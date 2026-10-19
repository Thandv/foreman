import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Broker } from '../budget.ts';
import { evaluateAdoption, type AdoptionReport, type ArmRunner } from './adopt.ts';
import { alignDir } from './extract.ts';
import { personaAdapterDir, personaDataDir, personaPort, type Persona } from './personas.ts';
import { acquireLocalModelLock, describeHolder, releaseLocalModelLock } from './localLock.ts';

const exec = promisify(execFile);

/** Read lazily so a test or an operator can point it elsewhere per case. */
const python = (): string => process.env['FOREMAN_PYTHON'] ?? '/opt/homebrew/bin/python3';

/**
 * One arm of the adoption gate, answered by mlx-lm on this machine.
 *
 * `mlx_lm generate` is used rather than a long-lived server because the gate
 * runs twice — once with the adapter and once without — and two servers would
 * hold two copies of the same base in memory to answer prompts one at a time.
 * The process cost is real but bounded; the memory cost would not be.
 */
export function generateArgsFor(
  persona: Persona,
  withAdapter: boolean,
  prompt: string,
  maxTokens: number,
): string[] {
  const args = [
    '-m', 'mlx_lm', 'generate',
    '--model', persona.base,
    '--prompt', prompt,
    '--max-tokens', String(maxTokens),
    // Greedy decoding on both arms: a gate that samples is comparing luck.
    '--temp', '0',
  ];
  if (withAdapter) args.push('--adapter-path', personaAdapterDir(persona.id));
  return args;
}

export function personaArm(persona: Persona, withAdapter: boolean, timeoutMs = 180_000): ArmRunner {
  return {
    alias: withAdapter ? `${persona.id}+adapter` : persona.base,
    async ask(prompt, opts): Promise<string> {
      const args = generateArgsFor(persona, withAdapter, prompt, opts.maxTokens ?? 400);
      const { stdout } = await exec(python(), args, { timeout: timeoutMs, maxBuffer: 8e6 });
      return stripGenerationChrome(stdout);
    },
  };
}

export interface ServedArm extends ArmRunner {
  /** Shut the server down. Always call it; a stray server holds gigabytes. */
  close(): Promise<void>;
}

/**
 * An arm backed by a single long-lived `mlx_lm server`, on its own port.
 *
 * `mlx_lm generate` reloads the base for every prompt: the gate asks ~40
 * prompts per arm, so that is eighty loads of a 4.5 GB model, and the first
 * real run passed half an hour without finishing. A server loads once and
 * answers all of them. Both arms are up at once because the A/B needs them
 * together; at 4-bit that is ~9 GB, which fits on this machine with nothing
 * else resident — which is exactly what the local-model lock guarantees.
 */
export async function servedArm(
  persona: Persona,
  withAdapter: boolean,
  opts: { port?: number; startTimeoutMs?: number; timeoutMs?: number } = {},
): Promise<ServedArm> {
  const port = opts.port ?? personaPort(persona.id) + (withAdapter ? 0 : 1);
  const args = ['-m', 'mlx_lm', 'server', '--model', persona.base, '--port', String(port)];
  if (withAdapter) args.push('--adapter-path', personaAdapterDir(persona.id));

  const child = spawn(python(), args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const base = `http://127.0.0.1:${port}/v1`;

  const deadline = Date.now() + (opts.startTimeoutMs ?? 300_000);
  for (;;) {
    if (child.exitCode !== null) throw new Error(`mlx_lm server exited ${child.exitCode} before it was ready`);
    try {
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`mlx_lm server did not come up on port ${port} within the start timeout`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  return {
    alias: withAdapter ? `${persona.id}+adapter` : persona.base,
    async ask(prompt, askOpts): Promise<string> {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: persona.base,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: askOpts.maxTokens ?? 400,
          // Greedy on both arms: a gate that samples is comparing luck.
          temperature: 0,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
      });
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return String(json?.choices?.[0]?.message?.content ?? '').trim();
    },
    async close(): Promise<void> {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}

/**
 * mlx-lm frames its output with `==========` rules and a trailing stats block.
 * None of that is the model's answer, and leaving it in would let a scorer
 * match on the furniture.
 */
export function stripGenerationChrome(stdout: string): string {
  const parts = stdout.split(/^={5,}$/m);
  const body = parts.length >= 2 ? parts[1]! : stdout;
  return body
    .split('\n')
    .filter((line) => !/^(Prompt|Generation|Peak memory|Fetching|Calling):/.test(line.trim()))
    .join('\n')
    .trim();
}

/**
 * Prompts the blind A/B judges on: the persona's own validation set, which is
 * work of exactly the kind it will be asked for. A generic prompt list would
 * measure whether the adapter made the base worse in general, which is not the
 * question — the question is whether it does THIS job better.
 */
export function abPromptsFor(persona: Persona, limit = 8): string[] {
  const file = path.join(personaDataDir(persona.id), 'valid.jsonl');
  if (!fs.existsSync(file)) return [];
  const prompts: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || prompts.length >= limit) continue;
    try {
      const row = JSON.parse(line) as { prompt?: unknown };
      if (typeof row.prompt === 'string' && row.prompt.trim()) prompts.push(row.prompt.slice(0, 4000));
    } catch {
      /* a corrupt line is not worth failing the gate for */
    }
  }
  return prompts;
}

export interface PersonaAdoptionResult extends AdoptionReport {
  personaId: string;
  reportFile: string;
}

/**
 * Put a trained candidate through the gate it has to pass to serve live work.
 *
 * The judge is deliberately NOT one of the arms: a model scoring its own
 * output is not a gate. It is the operator's strong model, which is the whole
 * point of running local work behind a cloud reviewer while the adapters are
 * still learning what to be.
 */
export async function gatePersona(opts: {
  persona: Persona;
  broker: Broker;
  judgeAlias: string;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}): Promise<PersonaAdoptionResult> {
  const { persona } = opts;
  const adapter = personaAdapterDir(persona.id);
  if (!fs.existsSync(adapter) || !fs.readdirSync(adapter).some((f) => f.endsWith('.safetensors'))) {
    throw new Error(`${persona.id} has no trained adapter at ${adapter} — run: foreman persona train ${persona.id}`);
  }

  const prompts = abPromptsFor(persona);
  if (!prompts.length) {
    throw new Error(
      `${persona.id} has no validation prompts to judge on — run: foreman persona build`,
    );
  }

  // The gate loads a base twice per prompt. That is a local model, and it must
  // queue behind whatever else holds the machine's RAM.
  const held = acquireLocalModelLock(`adoption gate ${persona.id}`);
  if (held) throw new Error(`the local model is in use by ${describeHolder(held)} — try again when it is done`);

  try {
    // Both arms have to be up together: the blind A/B asks them the same prompt
    // at the same time, and a gate that compared answers from different moments
    // would be comparing warm-up as much as weights. That is two copies of the
    // base — ~9 GB at 4-bit — which fits, but only just, and is why both are
    // closed in `finally` rather than left to the process exiting.
    opts.onProgress?.('starting the candidate server…');
    const candidate = await servedArm(persona, true);
    let report;
    let released = false;
    try {
      opts.onProgress?.('starting the base server…');
      const baseArm = await servedArm(persona, false);
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        await baseArm.close();
        await candidate.close();
      };
      try {
        report = await evaluateAdoption({
          broker: opts.broker,
          candidate,
          base: baseArm,
          judgeAlias: opts.judgeAlias,
          prompts,
          signal: opts.signal,
          onProgress: opts.onProgress,
          // Selects the golden set and the judge's rubric. Without it an
          // authoring adapter is scored on code-review probes.
          role: persona.role,
          // The judge is a third model. Hand the machine back before it loads.
          onArmsDone: release,
        });
      } finally {
        await release();
      }
    } finally {
      await candidate.close();
    }

    const dir = path.join(alignDir(), 'personas', persona.id);
    fs.mkdirSync(dir, { recursive: true });
    const reportFile = path.join(dir, 'adoption.json');
    fs.writeFileSync(reportFile, `${JSON.stringify({ personaId: persona.id, ...report }, null, 2)}\n`);

    return { personaId: persona.id, reportFile, ...report };
  } finally {
    releaseLocalModelLock();
  }
}
