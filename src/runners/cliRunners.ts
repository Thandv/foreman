import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Runner, RunnerContext, RunnerResult } from './index.ts';
import type { Stage, Task } from '../types.ts';
import { spawnStreaming } from './proc.ts';
import { getPlaybook } from '../playbooks.ts';
import { modelForTask, tierForTask, tierMaxTurns } from '../roles.ts';
import { cloudDown, cloudFallback, localOnly, localOnlyLabel } from '../localOnly.ts';
import { config } from '../config.ts';
import { testTimeoutMs } from '../verify/tests.ts';
import { RUN_ID_ENV, WORKER_TEST_CMD_ENV } from '../verify/testSlot.ts';
import { claudeIsolationArgs, claudeWorkerEnv, outOfJailWrite } from './claudeIsolation.ts';

const exec = promisify(execFile);

/**
 * `<bin> --version` used to be spawned once per task run to prove the CLI is
 * installed. The answer only changes when the operator installs something, so
 * it is memoized per binary path for the daemon's lifetime. A FAILURE is never
 * cached: installing the CLI mid-session must recover on the very next task.
 */
const PREFLIGHT_TTL_MS = 600_000;
const preflightOk = new Map<string, number>();

/** Test seam: the memo is process-global, so a suite has to be able to clear it. */
export function resetPreflightCache(): void {
  preflightOk.clear();
}

function stageForTool(tool: string, input: string): Stage | null {
  if (/^(Bash|shell|exec)$/i.test(tool)) {
    return /\b(test|testSlot|vitest|jest|pytest|npm t\b|cargo test|go test)\b/.test(input) ? 'test' : 'work';
  }
  if (/^(Edit|Write|NotebookEdit|apply_patch|patch)$/i.test(tool)) return 'work';
  if (/^(Read|Grep|Glob|search|list)$/i.test(tool)) return 'plan';
  return null;
}

/** Per-call knobs that are not part of the prompt itself. */
export interface BuildArgsOptions {
  /** A previous run's CLI session to continue instead of starting cold. */
  resumeSession?: string | null;
}

export interface CliSpec {
  id: Task['runner'];
  /** Env var that overrides the binary name. */
  binEnv: string;
  defaultBin: string;
  argsEnv: string;
  buildArgs(prompt: string, extra: string[], task: Task, opts?: BuildArgsOptions): string[];
  /**
   * The WHOLE environment every spawn of this CLI gets — the worker AND the
   * `--version` preflight, so the preflight proves the binary runs the way the
   * worker will run it. It replaces the daemon's environment; a spec without
   * one inherits the daemon's.
   */
  env?(task: Pick<Task, 'id'>): NodeJS.ProcessEnv;
  /** Pull stage/log/usage signal out of one parsed NDJSON object. */
  onEvent(ev: Record<string, unknown>, ctx: RunnerContext, state: CliState): void;
}

export interface CliState {
  turns: number;
  lastText: string;
  resultOk: boolean | null;
  /** The CLI's own conversation id, once it has announced one. */
  sessionId: string | null;
  /**
   * The `subtype` of the CLI's result envelope, which is where it says HOW a
   * run ended. Without it a failure is reported as the last thing the agent
   * happened to say, so a run that ran out of turns mid-edit surfaces to the
   * operator as `the worker itself failed: Now converting to the curly quotes`
   * — a sentence that names neither the cause nor the fix.
   */
  resultSubtype: string | null;
  /**
   * The first path a file-writing tool call aimed outside the jail, as the
   * agent wrote it. Once set the run has failed, whatever the CLI reports.
   */
  jailBreach: string | null;
  /**
   * Model responses seen: the distinct message ids of the stream's assistant events. `turns` above counts the
   * events, and the CLI writes one per content block, so it runs ahead of this.
   */
  responses: Set<string>;
  /** Assistant events that carried no message id: each is counted as a response of its own. */
  unidentified: number;
  /** `num_turns` of the CLI's result event, as the CLI counts them; null when it gave none. */
  reportedTurns: number | null;
}

export function initialCliState(): CliState {
  return {
    turns: 0, lastText: '', resultOk: null, sessionId: null, resultSubtype: null, jailBreach: null,
    responses: new Set(), unidentified: 0, reportedTurns: null,
  };
}

/** The last `--max-turns` among a CLI's arguments (a later one wins, as in the CLI), or null when there is none. */
export function turnLimitOf(args: readonly string[]): number | null {
  const at = args.lastIndexOf('--max-turns');
  const n = at >= 0 ? Number(args[at + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * A plain-English reason for a failed CLI run, or null when the subtype adds
 * nothing the summary does not already say. `turnCap` is this run's own ceiling
 * so the message can name the number the operator has to raise.
 */
export function cliFailureReason(subtype: string | null, turnCap: number | null): string | null {
  if (!subtype) return null;
  if (subtype === 'error_max_turns') {
    return turnCap === null
      ? 'the agent hit the CLI\'s own turn limit before it finished'
      : `the agent used all ${turnCap} of its turns before it finished — raise the tier's ` +
        'FOREMAN_MAX_TURNS_* ceiling, or split the ticket';
  }
  if (subtype === 'error_during_execution') return 'the CLI errored partway through the run';
  if (subtype === 'success') return null;
  return `the CLI ended with ${subtype}`;
}

/** Why a run that wrote outside its jail failed, naming the path the agent asked for. */
export function jailBreachReason(target: string): string {
  return `the agent tried to write outside its working directory (${target.slice(0, 300)}) — ` +
    'a worker may only edit files inside its jail, so the run was stopped';
}

/**
 * Route one line of CLI output: stderr is operator noise, stdout is NDJSON
 * with the occasional stray plain line. A line that parses to a non-object
 * (`null`, a bare number…) is treated as text too — handing it to onEvent
 * would throw inside the stream handler and take the daemon down.
 * Exported so the parsing can be exercised on recorded fixtures without a
 * live CLI.
 */
export function handleCliLine(
  spec: Pick<CliSpec, 'onEvent'>,
  ctx: RunnerContext,
  state: CliState,
  line: string,
  stream: 'stdout' | 'stderr',
): void {
  if (stream === 'stderr') {
    ctx.log(`stderr: ${line}`);
    return;
  }
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    ev = undefined;
  }
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    ctx.log(line);
    state.lastText = line;
    return;
  }
  spec.onEvent(ev as Record<string, unknown>, ctx, state);
}

/**
 * A final message bounded to 4000 chars keeps its head and its tail: the brief
 * has the worker END its report with the ACCEPTANCE MAP, so cutting the tail
 * off would drop the part that is read.
 */
export function boundSummary(text: string): string {
  if (text.length <= 4000) return text;
  return `${text.slice(0, 2000)}\n[... ${text.length - 4000} chars cut ...]\n${text.slice(-2000)}`;
}

function makeCliRunner(spec: CliSpec): Runner {
  const bin = (): string => process.env[spec.binEnv] ?? spec.defaultBin;
  return {
    id: spec.id,
    takesBrief: true,
    verifiable: true,
    async preflight(task) {
      if (task.sensitivity === 'S2') {
        return `S2 task cannot use ${spec.id}: it sends the prompt to a hosted model`;
      }
      // Admission already refuses this runner under local-only. Saying so here
      // too is not redundant: preflight is what `foreman doctor` reports, and a
      // readiness check that lists claude-code as `ok` in a mode that will
      // refuse every task using it is worse than no readiness check.
      if (localOnly()) {
        return `${localOnlyLabel()}: ${spec.id} drives a hosted model. Use the 'api' runner.`;
      }
      if (spec.id === 'claude-code' && cloudFallback()) {
        return `the Claude CLI is unreachable (${cloudDown()}); claude-code tickets wait in the queue until it is back`;
      }
      const binPath = bin();
      const provenAt = preflightOk.get(binPath);
      if (provenAt !== undefined && Date.now() - provenAt < PREFLIGHT_TTL_MS) return null;
      try {
        await exec(binPath, ['--version'], { timeout: 20_000, env: spec.env?.(task) ?? process.env });
        preflightOk.set(binPath, Date.now());
        return null;
      } catch {
        // A failure is never cached, and it drops any stale success for this
        // path too, so the memo can only ever shorten the happy case.
        preflightOk.delete(binPath);
        return `${spec.id} CLI not runnable as '${binPath}' — install it or set ${spec.binEnv}`;
      }
    },
    async run(ctx): Promise<RunnerResult> {
      ctx.stage('plan', `starting ${spec.id}`);
      const extra = (process.env[spec.argsEnv] ?? '').split(/\s+/).filter(Boolean);
      const state = initialCliState();
      const opts: BuildArgsOptions = { resumeSession: ctx.resumeSession ?? null };

      // The tripwire's own abort: a worker caught writing outside its jail is
      // stopped there, not left to finish the turn. Separate from ctx.signal so
      // the scheduler never reads it as a cancel or a stop.
      const tripwire = new AbortController();

      const args = spec.buildArgs(ctx.task.prompt, extra, ctx.task, opts);
      const code = await spawnStreaming(bin(), args, {
        cwd: ctx.dir,
        signal: AbortSignal.any([ctx.signal, tripwire.signal]),
        env: { ...spec.env?.(ctx.task), ...workerEnv(ctx.task, ctx.runId) },
        replaceEnv: spec.env !== undefined,
        onSpawn: (pid) => ctx.child(pid),
        onLine: (line, stream) => {
          handleCliLine(spec, ctx, state, line, stream);
          if (state.jailBreach !== null && !tripwire.signal.aborted) tripwire.abort();
        },
      });

      ctx.child(null);
      ctx.progress(1);
      const ok = code === 0 && state.resultOk !== false && state.jailBreach === null;
      const tier = tierForTask(ctx.task);
      const reason = state.jailBreach !== null
        ? jailBreachReason(state.jailBreach)
        : ok ? null : cliFailureReason(state.resultSubtype, tier ? tierMaxTurns(tier) : null);
      const tail = boundSummary(state.lastText) || (ok ? `${spec.id} finished` : `${spec.id} exited ${code}`);
      return {
        ok,
        exitCode: code,
        // The reason leads: whoever reads this is reading it to find out what
        // to do next, and the agent's last sentence is not that.
        summary: reason ? `${reason}. Last from the agent: ${tail}` : tail,
        report: state.lastText || undefined,
        turns: state.responses.size + state.unidentified,
        turnsReported: state.reportedTurns,
        turnLimit: turnLimitOf(args),
        endedBy: state.jailBreach !== null ? 'tripwire' : state.resultSubtype === 'error_max_turns' ? 'turn-ceiling' : null,
      };
    },
  };
}

/**
 * The shell commands a headless Claude Code worker may run without a human to
 * approve them.
 *
 * `acceptEdits` alone lets the worker write files but refuses every Bash call
 * as "requires approval" — and nobody can approve in a headless session. On
 * the first Kiln epic every worker wrote its code without once running its own
 * tests, and one hand-wrote "NOT CAPTURED" fixtures because it could not run
 * tsc at all. The test stage already executes the code the worker wrote, so
 * letting the worker run that same suite (and typecheck, and read git) grants
 * nothing the pipeline did not already do; arbitrary interpreters stay gated.
 * The FULL suite runs only through the slot wrapper (testSlot.ts), so it counts
 * against FOREMAN_MAX_VERIFIES like the gate's own runs; see workerShellDenylist.
 * `FOREMAN_CLAUDE_ALLOWED_TOOLS` replaces the list (`;`-separated), `none`
 * turns it off.
 */
export function workerShellAllowlist(task: Pick<Task, 'testCmd'> & Partial<Pick<Task, 'playbook' | 'sensitivity'>>): string[] {
  const raw = process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS'];
  if (raw !== undefined) {
    const list = raw.trim() === 'none' ? [] : raw.split(';').map((t) => t.trim()).filter(Boolean);
    return list.length ? ['--allowedTools', ...list] : [];
  }
  const list = [
    `Bash(${testSlotCommand()}:*)`,
    'Bash(npm run:*)', 'Bash(npx tsc:*)', 'Bash(node --test:*)',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
    ...workerWebTools(task),
  ];
  return ['--allowedTools', ...list];
}

/**
 * Web search and fetch for a worker whose playbook opts in (`"web": true`, research). Never for an S2 ticket: its
 * text must not leave the machine, and a search query is text leaving it. Reviewers run with no tools at all.
 */
export function workerWebTools(task: Partial<Pick<Task, 'playbook' | 'sensitivity'>>): string[] {
  // Granted only for a sensitivity that is known to allow text to leave the machine: an unset one fails closed.
  if (!task.playbook || (task.sensitivity !== 'S0' && task.sensitivity !== 'S1')) return [];
  const web = getPlaybook(task.playbook)?.web;
  if (!web) return [];
  // One allow rule per host: a fetch anywhere else needs an approval a headless worker cannot get, so it is refused.
  return [...(web.search ? ['WebSearch'] : []), ...web.domains.map((d) => `WebFetch(domain:${d})`)];
}

/** How a worker invokes the slot wrapper: an absolute path, so it works from any jail. */
export function testSlotCommand(): string {
  return `node ${path.join(config.sourceRoot, 'src', 'verify', 'testSlot.ts')}`;
}

/**
 * Full-suite commands the worker must NOT run directly: run there, they are
 * outside the verify cap (a worker's `npm run verify` ran beside two gate
 * verifies under a cap of 2). Deny beats allow in the CLI, so `npm run <other>`
 * stays open while these go through the wrapper. Only these: the ticket's own
 * test command is often a cheap gate (`npx tsc --noEmit`, a book ticket's
 * `bash scripts/gate.sh Chapters/X.md`), and denying it sent every such check
 * through the suite queue. A ticket command that is one of these is already
 * covered by its prefix. `FOREMAN_CLAUDE_DISALLOWED_TOOLS` replaces the list
 * (`;`-separated), `none` turns it off.
 */
export function workerShellDenylist(task: Pick<Task, 'testCmd'> & Partial<Pick<Task, 'playbook' | 'sensitivity'>>): string[] {
  const raw = process.env['FOREMAN_CLAUDE_DISALLOWED_TOOLS'];
  if (raw !== undefined) {
    const list = raw.trim() === 'none' ? [] : raw.split(';').map((t) => t.trim()).filter(Boolean);
    return list.length ? ['--disallowedTools', ...list] : [];
  }
  // A worker whose playbook does not grant the web is denied it outright: deny beats allow in the CLI, so a repo's own
  // .claude/settings.json (which a worker can write for its next round) cannot switch web access on.
  // Denied outright unless granted: WebSearch when the grant has no search, every WebFetch when it names no host.
  // (A domain-limited grant is not denied — deny beats allow — the allow rules alone limit it.)
  const granted = workerWebTools(task);
  const noWeb = [
    ...(granted.includes('WebSearch') ? [] : ['WebSearch']),
    ...(granted.some((t) => t.startsWith('WebFetch(')) ? [] : ['WebFetch']),
  ];
  return ['--disallowedTools', 'Bash(npm test:*)', 'Bash(npm t:*)', 'Bash(npm run test:*)', 'Bash(npm run verify:*)', ...noWeb];
}

/**
 * What a worker session gets on top of its base environment (the daemon's, or
 * the spec's own allowlisted one): the ticket's
 * test command for the wrapper, and a Bash-tool ceiling long enough for a
 * queued full suite. Only the ceiling (BASH_MAX_TIMEOUT_MS), never the default:
 * a default this long let a worker's `npm run serve` or watch script eat the
 * whole task budget instead of being killed at the CLI's 2 minutes. The worker
 * asks for the long timeout on its suite run (the shell brief says so); the
 * ceiling never exceeds the task's own timeout. And which run it is, so the
 * wrapper can tell the daemon whose suite is asking for a slot (that wait is
 * not charged to the run, and a run holds one suite run at a time).
 */
export function workerEnv(task: Pick<Task, 'testCmd'>, runId?: string): NodeJS.ProcessEnv {
  // Always the daemon's resolved home, so a spec-allowlisted base environment cannot carry a relative one either.
  const env: NodeJS.ProcessEnv = { FOREMAN_HOME: config.home };
  if (runId) env[RUN_ID_ENV] = runId;
  if (task.testCmd?.trim()) env[WORKER_TEST_CMD_ENV] = task.testCmd.trim();
  const toolMs = Math.min(testTimeoutMs() + 15 * 60_000, config.taskTimeoutMs);
  if (!process.env['BASH_MAX_TIMEOUT_MS']) env['BASH_MAX_TIMEOUT_MS'] = String(toolMs);
  return env;
}

/** Subscription-billed worker: Claude Code headless, stream-json parsed. */
export const claudeCodeSpec: CliSpec = {
  id: 'claude-code',
  binEnv: 'FOREMAN_CLAUDE_BIN',
  defaultBin: 'claude',
  argsEnv: 'FOREMAN_CLAUDE_ARGS',
  buildArgs: (prompt, extra, task, opts) => {
    const model = modelForTask(task);
    // A crew ticket's tier caps the agent loop; a task with no role keeps the
    // CLI's own default, because nothing here knows how big its job is.
    const tier = tierForTask(task);
    const resume = opts?.resumeSession?.trim();
    return [
      // --resume first: it selects the conversation the rest of the flags act on.
      ...(resume ? ['--resume', resume] : []),
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      // Variadic: each must be followed by another flag, never by a positional.
      ...workerShellAllowlist(task),
      ...workerShellDenylist(task),
      '--permission-mode', process.env['FOREMAN_CLAUDE_PERMISSION_MODE'] ?? 'acceptEdits',
      ...(model ? ['--model', model] : []),
      ...(tier ? ['--max-turns', String(tierMaxTurns(tier))] : []),
      // Not --bare: that drops the OAuth sign-in along with everything else.
      ...claudeIsolationArgs(),
      ...extra, // last, so a caller-supplied override in extra wins every one of these
    ];
  },
  env: claudeWorkerEnv,
  onEvent(ev, ctx, state) {
    const type = String(ev['type'] ?? '');
    // The init envelope is the only place the CLI names the conversation it
    // just opened; catching it here is what makes a resumed repair round
    // possible at all. `result` carries it too, as a belt-and-braces second
    // chance for a run whose init line was lost.
    if ((type === 'system' && ev['subtype'] === 'init') || type === 'result') {
      const sessionId = String(ev['session_id'] ?? '').trim();
      if (sessionId && sessionId !== state.sessionId) {
        state.sessionId = sessionId;
        ctx.session(sessionId);
      }
    }
    if (type === 'assistant') {
      state.turns++;
      ctx.progress(Math.min(0.9, state.turns / 25));
      const msg = (ev['message'] ?? {}) as Record<string, unknown>;
      if (typeof msg['id'] === 'string' && msg['id']) state.responses.add(msg['id']);
      else state.unidentified++;
      const usage = (msg['usage'] ?? {}) as Record<string, unknown>;
      ctx.usage({
        tokensIn: Number(usage['input_tokens'] ?? 0),
        tokensOut: Number(usage['output_tokens'] ?? 0),
      });
      for (const block of (msg['content'] as Record<string, unknown>[] | undefined) ?? []) {
        if (block['type'] === 'text' && String(block['text'] ?? '').trim()) {
          state.lastText = String(block['text']).trim();
          ctx.log(state.lastText.slice(0, 2000));
        } else if (block['type'] === 'tool_use') {
          const tool = String(block['name'] ?? 'tool');
          const input = JSON.stringify(block['input'] ?? {}).slice(0, 400);
          const stage = stageForTool(tool, input);
          if (stage) ctx.stage(stage, tool);
          ctx.log(`→ ${tool} ${input}`);
          // Checked on the whole input, not the 400-char log copy above.
          const escaped = outOfJailWrite(tool, block['input'], ctx.dir);
          if (escaped !== null && state.jailBreach === null) {
            state.jailBreach = escaped;
            ctx.log(`out-of-jail write: ${tool} ${escaped.slice(0, 300)}`);
          }
        }
      }
    } else if (type === 'result') {
      state.resultSubtype = typeof ev['subtype'] === 'string' ? ev['subtype'] : null;
      state.resultOk = ev['subtype'] === 'success' && ev['is_error'] !== true;
      const reported = Number(ev['num_turns']);
      if (ev['num_turns'] != null && Number.isInteger(reported) && reported >= 0) state.reportedTurns = reported;
      const cost = Number(ev['total_cost_usd'] ?? 0);
      if (cost > 0) ctx.usage({ costUsd: cost });
      if (typeof ev['result'] === 'string' && ev['result'].trim()) state.lastText = ev['result'].trim();
      ctx.log(`result: ${state.resultOk ? 'success' : 'error'}`);
    }
  },
};

export const claudeCodeRunner = makeCliRunner(claudeCodeSpec);

/** Same shape for the Codex CLI, whose JSONL uses msg/type envelopes. */
export const codexCliSpec: CliSpec = {
  id: 'codex-cli',
  binEnv: 'FOREMAN_CODEX_BIN',
  defaultBin: 'codex',
  argsEnv: 'FOREMAN_CODEX_ARGS',
  buildArgs: (prompt, extra, _task) => ['exec', '--json', ...extra, prompt],
  onEvent(ev, ctx, state) {
    const msg = (ev['msg'] ?? ev) as Record<string, unknown>;
    const type = String(msg['type'] ?? ev['type'] ?? '');
    if (type.includes('agent_message') || type === 'message') {
      state.turns++;
      state.unidentified++;
      ctx.progress(Math.min(0.9, state.turns / 25));
      const text = String(msg['message'] ?? msg['text'] ?? '').trim();
      if (text) {
        state.lastText = text;
        ctx.log(text.slice(0, 2000));
      }
    } else if (type.includes('exec_command') || type.includes('patch')) {
      const command = String(msg['command'] ?? msg['path'] ?? '').slice(0, 400);
      const stage = stageForTool(type.includes('patch') ? 'apply_patch' : 'shell', command);
      if (stage) ctx.stage(stage, type);
      ctx.log(`→ ${type} ${command}`);
    } else if (type.includes('token_count') || msg['usage']) {
      const usage = (msg['usage'] ?? msg) as Record<string, unknown>;
      ctx.usage({
        tokensIn: Number(usage['input_tokens'] ?? 0),
        tokensOut: Number(usage['output_tokens'] ?? 0),
      });
    } else if (type.includes('task_complete') || type === 'result') {
      state.resultOk = msg['error'] == null && ev['error'] == null;
      const text = String(msg['last_agent_message'] ?? '').trim();
      if (text) state.lastText = text;
    } else if (type.includes('error')) {
      state.resultOk = false;
      ctx.log(`error: ${JSON.stringify(msg).slice(0, 500)}`);
    }
  },
};

export const codexCliRunner = makeCliRunner(codexCliSpec);
