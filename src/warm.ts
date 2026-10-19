import { councilAliases } from './verify/council.ts';
import { resolveSpec, specs } from './models.ts';
import type { Sensitivity } from './types.ts';

export interface WarmResult {
  alias: string;
  model: string;
  ok: boolean;
  ms: number;
  error: string | null;
}

/**
 * The models the very first review will need: rung-0's two advisors plus the
 * chair it escalates to. Warming exactly these avoids loading the whole roster
 * for a machine that may only have room for two.
 */
export function warmTargets(sensitivity: Sensitivity = 'S1'): string[] {
  const { advisors, chair } = councilAliases(sensitivity, 0);
  return [...new Set([...advisors, chair])].filter((alias) => {
    const spec = specs().get(alias);
    return spec?.provider === 'ollama';
  });
}

/**
 * A zero-token load request. `num_predict: 0` asks Ollama to load the model and
 * generate nothing, and `keep_alive` holds it resident — so the first real
 * review finds it warm instead of paying a cold load inside the VRAM guard,
 * which serialises the two advisors precisely when they are both cold.
 */
async function warmOne(alias: string, keepAlive: string, timeoutMs: number): Promise<WarmResult> {
  const started = Date.now();
  const base = process.env['FOREMAN_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
  let spec;
  try {
    // Resolution belongs inside the guard: one bad alias in models.json must
    // skip that model, not abandon warming for every other one.
    spec = resolveSpec(alias);
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: spec.model,
        messages: [],
        stream: false,
        think: false,
        keep_alive: keepAlive,
        options: { num_predict: 0 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
    await res.arrayBuffer();
    return { alias, model: spec.model, ok: true, ms: Date.now() - started, error: null };
  } catch (err) {
    return {
      alias, model: spec?.model ?? alias, ok: false, ms: Date.now() - started,
      error: (err as Error).message.slice(0, 200),
    };
  }
}

export interface PrewarmOptions {
  keepAlive?: string;
  timeoutMs?: number;
  aliases?: string[];
  onLine?: (line: string) => void;
  /** Injectable residency probe, so the eviction logic is testable. */
  residentFn?: () => Promise<Set<string>>;
}

/**
 * Warm rung-0 at daemon start.
 *
 * Deliberately sequential, and it stops as soon as loading one model evicts a
 * model it just warmed. Measured on this machine: warming three models in
 * parallel left exactly one resident — they competed for VRAM and evicted each
 * other, so a "parallel ping" would have churned the disk and warmed nothing.
 * Warming is best-effort throughout: no Ollama, or a box too small to hold two
 * models, simply carries on and pays the load on first use.
 */
export async function prewarmRoster(opts: PrewarmOptions = {}): Promise<WarmResult[]> {
  if (process.env['FOREMAN_PREWARM'] === 'off') return [];
  const targets = opts.aliases ?? warmTargets();
  if (!targets.length) return [];
  const keepAlive = opts.keepAlive ?? process.env['FOREMAN_OLLAMA_KEEP_ALIVE'] ?? '30m';
  const timeoutMs = opts.timeoutMs ?? Number(process.env['FOREMAN_PREWARM_TIMEOUT_MS'] ?? 120_000);
  const readResident = opts.residentFn ?? loadedModels;

  const results: WarmResult[] = [];
  const warmed: string[] = [];
  for (const alias of targets) {
    const result = await warmOne(alias, keepAlive, timeoutMs);
    results.push(result);
    if (!result.ok) {
      opts.onLine?.(`could not warm ${result.alias}: ${result.error}`);
      continue;
    }
    warmed.push(result.model);

    const resident = await readResident().catch(() => null);
    if (!resident) {
      opts.onLine?.(`warmed ${result.alias} (${result.model}) in ${result.ms}ms`);
      continue;
    }
    const evicted = warmed.filter((m) => !resident.has(m));
    if (evicted.length) {
      opts.onLine?.(
        `warmed ${result.alias} (${result.model}) in ${result.ms}ms, but that evicted ${evicted.join(', ')} — ` +
          'this machine holds one roster model at a time, so pre-warming stops here',
      );
      break;
    }
    opts.onLine?.(`warmed ${result.alias} (${result.model}) in ${result.ms}ms`);
  }
  return results;
}

/** Which models Ollama currently has resident. */
async function loadedModels(): Promise<Set<string>> {
  const base = process.env['FOREMAN_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
  const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`ollama ps: ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
  return new Set((body.models ?? []).flatMap((m) => [m.name, m.model].filter((n): n is string => Boolean(n))));
}

export interface ParallelismCheck {
  numParallel: number | null;
  ok: boolean;
  advice: string;
}

/**
 * Two advisors can only share one model load if the Ollama server is willing
 * to serve requests in parallel. That is a server-side setting Foreman cannot
 * set for the operator, so it reports it rather than pretending.
 */
export async function checkOllamaParallelism(): Promise<ParallelismCheck> {
  const base = process.env['FOREMAN_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
  const fromEnv = process.env['OLLAMA_NUM_PARALLEL'];
  if (fromEnv && Number.isFinite(Number(fromEnv))) {
    const n = Number(fromEnv);
    return {
      numParallel: n,
      ok: n >= 2,
      advice: n >= 2 ? 'the server can serve both advisors at once' : 'set OLLAMA_NUM_PARALLEL=2 or more so both advisors share one load',
    };
  }
  try {
    const res = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(String(res.status));
    await res.arrayBuffer();
  } catch {
    return { numParallel: null, ok: false, advice: 'ollama is not reachable; council calls will fail' };
  }
  // The server does not report its own concurrency, so an unset variable is
  // reported as unknown rather than guessed at.
  return {
    numParallel: null,
    ok: false,
    advice: 'OLLAMA_NUM_PARALLEL is unset here; set it to 2+ (in the server’s environment) so both advisors share one model load',
  };
}
