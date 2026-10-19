import fs from 'node:fs';
import path from 'node:path';
import type { Runner, RunnerContext } from './index.ts';
import { getAgent } from '../agents.ts';
import { modelForTask, tierForTask, tierMaxTurns } from '../roles.ts';
import { contextTokensFor, maxOutputTokensFor } from '../localOnly.ts';
import { assertPersonaReachable } from '../align/personaHealth.ts';
import { buildContextPack, chapterFromTitle } from '../prose/contextPack.ts';
import { scanCommand } from '../security/admit.ts';
import { extractJson, pickAlias, specs, type ChatMessage } from '../models.ts';
import { getTool, listTools, searchTools, type ToolManifest } from '../tools/catalog.ts';
import { getPlaybook } from '../playbooks.ts';
import type { Task } from '../types.ts';
import { toolBrief, toolSurface } from '../tools/forge.ts';
import { runTool as runCatalogTool } from '../tools/run.ts';
import { scrubbedEnv, spawnStreaming } from './proc.ts';
import { SandboxError } from '../security/sandbox.ts';
import { sandboxedShell } from '../verify/tests.ts';

const MAX_TURNS = Number(process.env['FOREMAN_API_MAX_TURNS'] ?? 12);
const MAX_READ = 20_000;
/**
 * A model that gets the same result from the same tool turn after turn is not
 * making progress: local runs have spent whole budgets listing one directory
 * twenty times, and calling a quarantined tool fifteen times after being told
 * it was quarantined. At REPEAT_NUDGE identical results in a row the model is
 * told so; at REPEAT_STOP the run ends instead of spending what is left.
 */
const REPEAT_NUDGE = envCount('FOREMAN_API_REPEAT_NUDGE', 3);
const REPEAT_STOP = envCount('FOREMAN_API_REPEAT_STOP', 5);

/**
 * A repeat count from the environment. One result is not a repeat, so anything
 * below 2 turns the check off (a threshold of 1 would fire on every call); junk
 * keeps the default.
 */
export function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) return fallback;
  if (!Number.isFinite(n)) return Infinity; // ±Infinity: off, like anything below 2
  return n < 2 ? Infinity : Math.floor(n);
}

/** An observation that says the call did not happen or did not work, whatever its arguments were. */
const REFUSAL = /^(error:|unknown tool:|no such tool:|refused:|tool \S+ failed: |run_shell is disabled on this install)/;

/** A call and its result, as one comparable key. Timings are not part of a result. */
function repeatKey(call: Record<string, unknown>, label: string, observation: string): string {
  const result = observation.replace(/ in \d+ms\b/g, '');
  // A refusal is the same outcome whatever was asked (a quarantined tool, an
  // unknown name): varying the arguments does not make it progress.
  if (REFUSAL.test(result)) return `${label}\u0000*\u0000${result}`;
  const { tool: _tool, ...args } = call;
  return `${label}\u0000${stableJson(args)}\u0000${result}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const SYSTEM = `You are an autonomous worker. You act only through tools, one per reply.
Reply with JSON only, in one of these shapes:
{"tool":"list_dir","path":"."}
{"tool":"read_file","path":"src/x.ts"}
{"tool":"write_file","path":"src/x.ts","content":"…full new contents…"}
{"tool":"run_shell","command":"npm test"}
{"tool":"find_tool","query":"csv pivot"}
{"tool":"use_tool","name":"csv-pivot","args":{…}}
{"tool":"build_tool","name":"csv-pivot","description":"one line","spec":"what it must do","when":"when this role should reach for it"}
{"tool":"done","summary":"what you changed and why"}
Rules: paths are relative to the working directory and may not escape it.
Read before you write. Finish with "done" as soon as the task is complete.
Never repeat a tool call that already returned the same result.
Before building a tool, always find_tool first — reuse beats rebuilding.
If a tool would make THIS task or the next one of its kind meaningfully easier,
more reliable or cheaper, build it — a deterministic tool beats doing the same
work by hand every run. Give a "when" note so it can be linked to your role's
playbook on approval and later tickets are told about it.
build_tool does not return a usable tool: it queues a separate, human-gated
build task. Say so in your summary and stop rather than waiting for it.`;

/**
 * Reject anything that resolves outside the jail, including via symlinks.
 *
 * The only honest way to check a symlink is to resolve it: a lexical check on
 * the requested path (`resolved.startsWith(jail)`) passes for `evil/x` even
 * when `evil` is a symlink to `/etc`, so it must never be the deciding clause.
 * We realpath the longest existing prefix of the target — which collapses any
 * symlink an attacker planted inside the jail — then re-attach the not-yet-
 * created tail and require the result to sit under the jail's real root. The
 * returned path is symlink-free in its existing portion, so a later read/write
 * cannot be redirected out through a link. Exported so the jail boundary can be
 * exercised directly in tests.
 */
export function safePath(dir: string, rel: string): string {
  const root = fs.realpathSync(dir);
  const resolved = path.resolve(root, rel);
  const tail: string[] = [];
  let existing = resolved;
  // lstat, not exists: existsSync follows links, so a DANGLING symlink
  // (`jail/x -> /home/op/.profile`, not created yet) read as "not there yet",
  // went into the tail unresolved, and write_file then created its target
  // through it, outside the jail.
  const present = (p: string): boolean => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  while (!present(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    existing = parent;
  }
  let realExisting: string;
  try {
    realExisting = fs.realpathSync(existing);
  } catch {
    // Present but unresolvable: a dangling link (or a loop). Where it would
    // lead cannot be shown to be inside the jail, so it is refused.
    throw new Error(`path escapes the jail: ${rel} (through a symlink that does not resolve)`);
  }
  const real = tail.length ? path.join(realExisting, ...tail) : realExisting;
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`path escapes the jail: ${rel}`);
  }
  return real;
}

function listDir(dir: string, rel: string): string {
  const target = safePath(dir, rel || '.');
  return fs
    .readdirSync(target, { withFileTypes: true })
    .slice(0, 200)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .join('\n') || '(empty)';
}

async function runTool(
  call: Record<string, unknown>,
  ctx: RunnerContext,
): Promise<string> {
  const tool = String(call['tool'] ?? '');
  const rel = String(call['path'] ?? '');
  switch (tool) {
    case 'list_dir':
      ctx.stage('plan', 'list_dir');
      return listDir(ctx.dir, rel);
    case 'read_file': {
      ctx.stage('plan', 'read_file');
      const file = safePath(ctx.dir, rel);
      if (!fs.existsSync(file)) return `no such file: ${rel}`;
      return fs.readFileSync(file, 'utf8').slice(0, MAX_READ);
    }
    case 'write_file': {
      ctx.stage('work', 'write_file');
      const file = safePath(ctx.dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(call['content'] ?? ''));
      return `wrote ${rel} (${String(call['content'] ?? '').length} bytes)`;
    }
    case 'run_shell': {
      const command = String(call['command'] ?? '');
      if (process.env['FOREMAN_API_ALLOW_SHELL'] === '0') return 'run_shell is disabled on this install';
      // The model authored this string; it never went through task admission.
      const blocked = scanCommand(command);
      if (blocked) return `refused: ${blocked}`;
      ctx.stage(/\btest\b/.test(command) ? 'test' : 'work', 'run_shell');
      const out: string[] = [];
      // Under FOREMAN_SANDBOX the command is confined to the jail; a sandbox that cannot start refuses it.
      let launch: Awaited<ReturnType<typeof sandboxedShell>>;
      try {
        launch = await sandboxedShell(ctx.dir, command);
      } catch (err) {
        if (!(err instanceof SandboxError)) throw err;
        return `refused: ${err.message}`;
      }
      let code: number;
      try {
        code = await spawnStreaming(launch.cmd, launch.args, {
          cwd: ctx.dir,
          signal: ctx.signal,
          // Credential-shaped variables never reach a command the model wrote.
          env: scrubbedEnv('deny', launch.env),
          replaceEnv: true,
          onSpawn: (pid) => ctx.child(pid),
          onLine: (line) => {
            out.push(line);
            if (out.length > 200) out.shift();
          },
        });
      } finally {
        launch.done();
      }
      ctx.child(null);
      return `exit ${code}\n${out.join('\n').slice(0, 8000)}`;
    }
    case 'find_tool': {
      ctx.stage('plan', 'find_tool');
      const query = String(call['query'] ?? '');
      const hits = (query ? searchTools(query) : listTools()).filter((t) => !t.quarantined);
      return hits.length
        ? `matching tools:\n${toolSurface(hits.slice(0, 10))}`
        : 'no tool in the catalog matches; build_tool can queue one';
    }
    case 'use_tool': {
      const name = String(call['name'] ?? '');
      const found = getTool(name);
      if (!found) return `no such tool: ${name}. Use find_tool to see what exists.`;
      ctx.stage('work', `use_tool ${name}`);
      const result = await runCatalogTool(found, call['args'] ?? {}, {
        cwd: ctx.dir,
        signal: ctx.signal,
      });
      ctx.usage({});
      return result.ok
        ? `tool ${name} ok in ${result.durationMs}ms:\n${JSON.stringify(result.output).slice(0, 8000)}`
        : `tool ${name} failed: ${result.error}`;
    }
    case 'build_tool': {
      const name = String(call['name'] ?? '');
      const description = String(call['description'] ?? '');
      const spec = String(call['spec'] ?? description);
      if (!name || !description) return 'build_tool needs a name and a one-line description';
      if (getTool(name)) return `a tool named '${name}' already exists; use_tool it, or pick another name`;
      ctx.stage('plan', `build_tool ${name}`);
      // Record WHO wanted it, so that on approval it is linked to that role's
      // playbook and becomes a habit rather than a thing rediscovered by the
      // next epic of the same shape. The `when` is the model's own account of
      // why it reached for a tool that did not exist, which is exactly the
      // note a future ticket needs.
      const req = ctx.task.playbook && ctx.task.role
        ? `for ${ctx.task.playbook}.${ctx.task.role}: ${String(call['when'] ?? description).slice(0, 200)}\n\n`
        : '';
      const child = ctx.enqueue({
        title: `Build tool: ${name}`,
        prompt: req + toolBrief({ name, description, spec, runtime: call['runtime'] === 'python' ? 'python' : 'node' }),
        kind: 'tool',
        runner: 'api',
        sensitivity: ctx.task.sensitivity,
        budgetUsd: ctx.task.budgetUsd,
        priority: ctx.task.priority,
      });
      return `queued build task ${child.id} for '${name}'. It must pass its own tests, the council ` +
        'and a human approval before it is registered. It is NOT available in this run.' +
        (req ? ` On approval it will be linked to ${ctx.task.playbook}.${ctx.task.role}, so later tickets of this kind are told about it.` : '');
    }
    default: {
      // Small models — the ones stepping down puts on this loop — routinely
      // call a catalog tool by its own name: {"tool":"apply-fixes",...}. Told
      // "unknown tool", a 7B looked it up with find_tool, saw it listed, and
      // called it the same wrong way again, turn after turn, in a live run.
      // The intent is unambiguous, so it is served as the use_tool it meant.
      if (getTool(tool)) {
        const { tool: _name, args, ...rest } = call;
        return runTool({ tool: 'use_tool', name: tool, args: args ?? rest }, ctx);
      }
      return `unknown tool: ${tool}. Built-in tools: ${BUILTIN_TOOLS.join(', ')}. ` +
        'A catalog tool is called as {"tool":"use_tool","name":"<its name>","args":{...}}.';
    }
  }
}

const BUILTIN_TOOLS = ['list_dir', 'read_file', 'write_file', 'run_shell', 'find_tool', 'use_tool', 'build_tool', 'done'];

/**
 * The catalog section of the first message. By default every tool, described
 * in full — 28 tools is ~5k tokens, most of a `dev` ticket's 8k window before
 * the task is read. FOREMAN_TOOL_SURFACE=sparse (experiment E-M): the tools the
 * task's playbook role declares stay in full here, and every other tool is
 * listed by name only; find_tool returns any of them in full on demand. (A crew
 * ticket's brief also lists the role's tools — scheduler.ts briefFor, through
 * roles.ts toolBrief — but this section does not lean on it: a ticket with an
 * explicit task.agent gets no role brief.) A task with no role, or a role that
 * declares no tools, keeps the full catalog.
 */
export function catalogSection(
  task: Pick<Task, 'playbook' | 'role'>,
  tools: ToolManifest[],
  mode = process.env['FOREMAN_TOOL_SURFACE'],
): string {
  if (mode !== 'sparse' || !task.playbook || !task.role) return toolSurface(tools);
  const pb = getPlaybook(task.playbook);
  // Own keys only: a role named like an Object.prototype member is no role.
  const declared = pb && Object.hasOwn(pb.tools, task.role) ? pb.tools[task.role]! : [];
  const hot = new Set(declared.map((t) => t.name));
  if (!hot.size) return toolSurface(tools);
  const full = tools.filter((t) => hot.has(t.name));
  const cold = tools.filter((t) => !hot.has(t.name)).map((t) => t.name);
  return [
    full.length
      ? toolSurface(full)
      : "(none of this role's tools can be used yet: not built, or quarantined — build_tool makes a missing one)",
    cold.length
      ? `Also in the catalog, by name only — find_tool with a name shows what it does and its args: ${cold.join(', ')}`
      : '',
  ].filter(Boolean).join('\n');
}

/**
 * API-billed worker: a tool loop against the model plane. Every call is
 * metered through the broker, so budget ceilings and S2 routing apply here
 * exactly as they do to the council.
 */
export const apiRunner: Runner = {
  id: 'api',
  takesBrief: true,
  verifiable: true,
  async preflight(task) {
    try {
      const alias = pickAlias([task.agent ?? '', task.kind === 'code' ? 'local-code' : 'local-reason', 'local-reason'], task.sensitivity);
      await assertPersonaReachable(alias);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  },
  async run(ctx) {
    const task = ctx.task;
    const agent = task.agent ? getAgent(task.agent) : null;
    if (task.agent && !agent && !specs().has(task.agent)) {
      throw new Error(`unknown agent '${task.agent}' — not in the catalog and not a model alias`);
    }
    // modelForTask is what knows about adopted personas and playbook tiers, so
    // it leads: a ticket whose role has a trained local model should be served
    // by it rather than by the generic alias for its kind.
    const routed = modelForTask(task);
    const alias = pickAlias(
      [
        agent?.model ?? '',
        task.agent ?? '',
        routed ?? '',
        // Not llama3.1:8b (`local-general`): 0.25 on the reasoning bench, and a
        // worker that cannot reason produces work the council then has to fail.
        // The 9B benched 1.00 and is the local-only policy's text-worker seat.
        task.kind === 'code' ? 'local-code' : 'local-reason',
        'local-reason',
      ],
      task.sensitivity,
    );
    if (agent) ctx.log(`agent '${agent.id}' from ${agent.source}`);
    // Before a single turn is spent: if this alias is an adopted persona, its
    // own server must be answering. Refusing here rather than on the first call
    // is the difference between "this ticket cannot run yet" and a run that
    // dies mid-way with a connection refused (local-only policy).
    await assertPersonaReachable(alias);
    ctx.log(`api runner using ${alias} (${specs().get(alias)?.model})`);

    // Canon before the task, for a prose ticket in a book workspace.
    //
    // An 8B cannot hold seven hundred days of timeline and two hundred proper
    // nouns across fifty-four chapters, and no LoRA fixes that — it is a
    // weakness of memory, not of style, and the fix is to stop asking it to
    // remember. Training supplies the voice; this supplies the facts.
    let pack = { text: '', included: null as unknown, bytes: 0 };
    if (task.kind === 'writing' && ctx.dir) {
      pack = buildContextPack({
        repo: ctx.dir,
        brief: `${task.title}\n${task.prompt}\n${task.acceptance ?? ''}`,
        chapter: chapterFromTitle(task.title),
      });
      if (pack.bytes) {
        ctx.log(`context pack: ${JSON.stringify(pack.included)} (${Math.round(pack.bytes / 1024)} KB)`);
      }
    }

    // Two known local-only gaps. Both of these are silent failures
    // rather than errors, which is what makes them worth spending a config on:
    // a drafting call under the 1024-token default returns a chapter that stops
    // mid-scene, and a call over Ollama's ~4k default context loses the front of
    // its own brief. Both then look like the model doing bad work.
    const maxTokens = maxOutputTokensFor(task.kind, task.role);
    // The window has to hold the pack. Sizing it from the kind alone would
    // hand the model a canon it cannot see — the same silent front-drop that
    // made every chapter review an unparseable essay.
    const numCtx = Math.max(
      contextTokensFor(task.kind, task.role),
      Math.ceil(pack.bytes / 4) + 4096,
    );
    // A turn ceiling by tier, for the same reason the CLI runners have one: a
    // self-gating 3,700-word chapter runs out of a 40-turn budget mid-polish.
    const tier = tierForTask(task);
    const maxTurns = tier ? Math.max(MAX_TURNS, tierMaxTurns(tier)) : MAX_TURNS;
    ctx.log(`ceilings: ${maxTokens} output tokens, ${numCtx} context, ${maxTurns} turns`);

    const messages: ChatMessage[] = [
      { role: 'system', content: agent ? `${agent.systemPrompt}\n\n${SYSTEM}` : SYSTEM },
      {
        role: 'user',
        content:
          (pack.text ? `${pack.text}\n\n=====\n\n` : '') +
          `TASK: ${task.title}\n\n${task.prompt}\n\n` +
          `Working directory contents:\n${listDir(ctx.dir, '.')}\n\n` +
          `Tools already in the catalog:\n${catalogSection(task, listTools().filter((t) => !t.quarantined))}`,
      },
    ];

    let summary = '';
    let steppedDown = false;
    let lastResult = '';
    let repeats = 0;
    for (let turn = 0; turn < maxTurns; turn++) {
      ctx.progress(Math.min(0.9, (turn + 1) / maxTurns));
      const res = await ctx.broker.call({
        taskId: task.id,
        runId: ctx.runId,
        kind: 'agent',
        alias,
        messages,
        sensitivity: task.sensitivity,
        taskBudgetUsd: task.budgetUsd,
        maxTokens,
        numCtx,
        json: true,
        signal: ctx.signal,
      });
      ctx.usage({ tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd });
      if (res.downshiftedFrom && !steppedDown) {
        steppedDown = true;
        ctx.log(`${res.downshiftedFrom} did not fit in memory; working on ${res.spec.alias} (${res.spec.model}) — the council review decides whether it holds up`);
      }

      const call = extractJson<Record<string, unknown>>(res.text);
      if (!call || typeof call['tool'] !== 'string') {
        ctx.log(`unparseable reply, asking again: ${res.text.slice(0, 200)}`);
        messages.push({ role: 'assistant', content: res.text.slice(0, 1000) });
        messages.push({ role: 'user', content: 'That was not a valid tool call. Reply with JSON only.' });
        continue;
      }

      if (call['tool'] === 'done') {
        summary = String(call['summary'] ?? 'done');
        ctx.log(`done: ${summary.slice(0, 500)}`);
        ctx.progress(1);
        return { ok: true, summary, exitCode: 0 };
      }

      let observation: string;
      try {
        observation = await runTool(call, ctx);
      } catch (err) {
        observation = `error: ${(err as Error).message}`;
      }
      ctx.log(`→ ${String(call['tool'])} ${String(call['path'] ?? call['command'] ?? '')} :: ${observation.slice(0, 300)}`);

      // The same call with the same result — or a refusal, whatever was asked —
      // is no progress, and neither will the next attempt be. Five different
      // silent commands are five results, not one.
      const label = call['tool'] === 'use_tool' ? `use_tool ${String(call['name'] ?? '')}` : String(call['tool']);
      const result = repeatKey(call, label, observation);
      repeats = result === lastResult ? repeats + 1 : 1;
      lastResult = result;
      if (repeats >= REPEAT_STOP) {
        ctx.log(`stopping a loop: ${label} returned the same result ${repeats} times in a row`);
        ctx.progress(1);
        return {
          ok: false,
          summary: `api runner stopped a loop: ${label} returned the same result ${repeats} times in a row`,
          exitCode: 1,
        };
      }
      messages.push({ role: 'assistant', content: JSON.stringify(call) });
      messages.push({
        role: 'user',
        content: `TOOL RESULT:\n${observation.slice(0, 8000)}` + (repeats >= REPEAT_NUDGE
          ? `\n\nThat is the same result ${repeats} times in a row; asking again will not change it. ` +
            'Do something different (another tool, run_shell, or write the result yourself), ' +
            'or reply with {"tool":"done","summary":"..."} and say what is blocking you.'
          : ''),
      });
    }

    ctx.progress(1);
    return { ok: false, summary: `api runner hit the ${maxTurns}-turn limit without finishing`, exitCode: 1 };
  },
};
