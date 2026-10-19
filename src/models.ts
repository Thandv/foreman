import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { memoryWarning, modelSizeGb, readMemory } from './memory.ts';
import { loadPersonas, personaServerUrl } from './align/personas.ts';
import { cloudDown, cloudFallback, localOnly, localOnlyMode, setCloudDown } from './localOnly.ts';

const execFileAsync = promisify(execFile);
import type { Sensitivity } from './types.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelSpec {
  alias: string;
  /**
   * `claude-cli` drives the subscription-billed Claude Code CLI headlessly.
   *
   * It exists because the operator's cloud access is a subscription, not an API
   * key: without it there is no way for the BROKER to reach a Claude model at
   * all, only for a runner to. And the broker is where judging happens — the
   * adoption gate's third arm, a council seat, the shadow comparison. "Claude
   * models gate the local ones" is unimplementable until Claude is an alias.
   *
   * It is `local: false`, so every existing guard already covers it: an S2 task
   * refuses it, and FOREMAN_LOCAL_ONLY refuses it. It stops working of its own
   * accord when the subscription lapses, which is the intended lifecycle.
   */
  provider: 'ollama' | 'openai' | 'claude-cli';
  model: string;
  /** True when inference never leaves this machine. S2 tasks require it. */
  local: boolean;
  /**
   * OpenAI-compatible endpoint for this alias alone. A persona adapter is
   * served by its own `mlx_lm.server`, so aliases can no longer share one
   * gateway URL read from the environment.
   */
  baseUrl?: string;
  usdPerMTokIn: number;
  usdPerMTokOut: number;
  /**
   * Smaller local aliases to step down to, in order, when this one does not
   * fit in memory right now (budget.ts). Work done on a step-down is marked
   * and re-checked by the full model later; it is never a silent swap.
   */
  downshift?: string[];
  /**
   * Only ever a step-down target: never benched, never put in the roster,
   * never seated on a council as if it were a full-strength reviewer.
   */
  stepDownOnly?: boolean;
}

export interface ChatResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  spec: ModelSpec;
  /** Set by the broker when this ran on `spec` in place of the alias asked for. */
  downshiftedFrom?: string;
}

/**
 * Defaults are local-first: every alias below runs on this machine, so an S2
 * task can be served without a network hop. Cloud aliases are opt-in through
 * models.json or FOREMAN_GATEWAY_URL.
 */
const DEFAULT_SPECS: ModelSpec[] = [
  { alias: 'local-fast', provider: 'ollama', model: 'qwen3.5:2b', local: true, usdPerMTokIn: 0, usdPerMTokOut: 0 },
  { alias: 'local-general', provider: 'ollama', model: 'llama3.1:8b', local: true, usdPerMTokIn: 0, usdPerMTokOut: 0, downshift: ['local-fast'] },
  { alias: 'local-reason', provider: 'ollama', model: 'qwen3.5:9b', local: true, usdPerMTokIn: 0, usdPerMTokOut: 0, downshift: ['local-fast'] },
  {
    alias: 'local-code', provider: 'ollama', model: 'qwen2.5-coder:14b', local: true, usdPerMTokIn: 0, usdPerMTokOut: 0,
    downshift: ['local-code-small', 'local-fast'],
  },
  // The cheap coder: half the 14B's footprint (4.7 vs 9 GB). It is a step-down
  // seat, not a roster seat — never benched against the 14B, so it is used
  // only when the 14B cannot load, and its work is re-checked when it can.
  {
    alias: 'local-code-small', provider: 'ollama', model: 'qwen2.5-coder:7b', local: true, usdPerMTokIn: 0, usdPerMTokOut: 0,
    downshift: ['local-fast'], stepDownOnly: true,
  },
];

/**
 * Claude aliases, available only while the CLI is installed and signed in.
 *
 * Registered by default rather than opt-in: the CLI's presence IS the opt-in,
 * and an operator with no subscription simply has aliases whose preflight
 * fails, exactly like an unpulled Ollama model. Rates are the published list
 * prices — under a subscription nothing is billed per token, but a receipt
 * that says $0.00 for an Opus call would make the ledger lie about what the
 * work would cost to reproduce.
 */
/**
 * Aliases still registered (an agent or FOREMAN_MODEL_* that pins one keeps
 * working) but no longer a default anywhere. `fable` was the owner tier until
 * 2026-10-05; Opus 5.5 and Sonnet 5.5 now outperform it for this work.
 */
export const DEPRECATED_ALIASES: ReadonlySet<string> = new Set(['fable']);

const CLAUDE_SPECS: ModelSpec[] = [
  { alias: 'fable', provider: 'claude-cli', model: 'claude-fable-5-1', local: false, usdPerMTokIn: 10, usdPerMTokOut: 50 },
  { alias: 'opus', provider: 'claude-cli', model: 'claude-opus-5-5', local: false, usdPerMTokIn: 4, usdPerMTokOut: 20 },
  { alias: 'sonnet', provider: 'claude-cli', model: 'claude-sonnet-5-5', local: false, usdPerMTokIn: 2, usdPerMTokOut: 10 },
  { alias: 'haiku', provider: 'claude-cli', model: 'claude-haiku-4-5', local: false, usdPerMTokIn: 1, usdPerMTokOut: 5 },
];

/** The Claude aliases, registered or not — for status output that must name them either way. */
export function claudeSpecs(): readonly ModelSpec[] {
  return CLAUDE_SPECS;
}

export class SensitivityViolation extends Error {}
export class ModelUnavailable extends Error {}
/**
 * A reply cut off at its output ceiling. Still a ModelUnavailable — every
 * verdict path must keep treating it as no answer — but distinguishable, so a
 * liveness probe that asked for one token can tell "the model answered and was
 * stopped where we told it to stop" from "the model is down".
 */
export class TruncatedReply extends ModelUnavailable {}

function loadSpecs(): Map<string, ModelSpec> {
  const specs = new Map<string, ModelSpec>();
  for (const spec of DEFAULT_SPECS) specs.set(spec.alias, spec);
  // Skipped entirely under local-only, for the same reason gateway aliases are:
  // an alias that resolves is one config edit from live.
  // Nor while auto mode has fallen back: an alias whose CLI is known to be
  // signed out would be picked by every fallback chain and fail every call.
  if (!localOnly() && !cloudFallback()) for (const spec of CLAUDE_SPECS) specs.set(spec.alias, spec);

  const file = path.join(config.home, 'models.json');
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: Partial<ModelSpec>[] };
    for (const raw of parsed.models ?? []) {
      if (!raw.alias || !raw.model) throw new Error('models.json: every entry needs alias and model');
      const spec = raw as ModelSpec;
      // An entry that re-points an alias keeps its step-down chain unless it
      // names one: dropping it silently would make a re-pointed 14B fail
      // where the default one steps down.
      const base = specs.get(spec.alias);
      specs.set(spec.alias, {
        downshift: base?.downshift,
        stepDownOnly: base?.stepDownOnly,
        ...spec,
        local: spec.local ?? spec.provider === 'ollama',
        usdPerMTokIn: spec.usdPerMTokIn ?? 0,
        usdPerMTokOut: spec.usdPerMTokOut ?? 0,
      });
    }
  }

  // The local-only policy: in local-only mode a gateway alias is not merely refused at call
  // time, it is never registered. A refusal at the call site still leaves the
  // alias resolvable — visible in `doctor`, pickable by a stale models.json,
  // one config edit away from live. Not loading it is the stronger statement.
  const gateway = localOnly() ? undefined : process.env['FOREMAN_GATEWAY_URL'];
  if (gateway) {
    for (const alias of (process.env['FOREMAN_GATEWAY_ALIASES'] ?? 'gateway-chair').split(',')) {
      const name = alias.trim();
      if (!name) continue;
      specs.set(name, {
        alias: name,
        provider: 'openai',
        model: process.env[`FOREMAN_MODEL_${name.replace(/\W/g, '_').toUpperCase()}`] ?? name,
        local: false,
        usdPerMTokIn: Number(process.env['FOREMAN_GATEWAY_IN_RATE'] ?? 3),
        usdPerMTokOut: Number(process.env['FOREMAN_GATEWAY_OUT_RATE'] ?? 15),
      });
    }
  }
  // Adopted personas last, so a hand-written models.json entry can still
  // override one. Each is served by its own local mlx_lm.server, which is why
  // they are `local: true` — an S2 task may use a persona, and may not use a
  // gateway.
  for (const persona of adoptedPersonaSpecs()) specs.set(persona.alias, persona);

  return specs;
}

/**
 * Model specs for every persona that has been adopted. A persona that is still
 * a draft or a candidate is deliberately absent: nothing can route to it, so a
 * misconfigured alias cannot quietly send live work to an unproven adapter.
 */
function adoptedPersonaSpecs(): ModelSpec[] {
  const out: ModelSpec[] = [];
  try {
    for (const persona of loadPersonas().personas) {
      if (persona.status !== 'adopted' || !persona.alias) continue;
      out.push({
        alias: persona.alias,
        provider: 'openai',
        model: persona.base,
        local: true,
        baseUrl: personaServerUrl(persona.id),
        usdPerMTokIn: 0,
        usdPerMTokOut: 0,
      });
    }
  } catch {
    // A broken personas directory must not take down model resolution.
  }
  return out;
}

let SPECS: Map<string, ModelSpec> | null = null;
export function specs(): Map<string, ModelSpec> {
  SPECS ??= loadSpecs();
  return SPECS;
}
/** Test hook; also lets `foreman doctor` re-read models.json without a restart. */
export function reloadSpecs(): void {
  SPECS = null;
}

export function resolveSpec(alias: string): ModelSpec {
  const spec = specs().get(alias);
  if (!spec) throw new ModelUnavailable(`unknown model alias: ${alias}`);
  return spec;
}

/**
 * Fail-closed: an S2 task may only ever touch a local model — and in local-only
 * mode EVERY task is treated as S2 for the purpose of model resolution (the local-only
 * policy). That is deliberately the same check rather than a parallel one: there is
 * exactly one place in this codebase that decides whether a call may leave the
 * machine, and it stays that way.
 */
export function assertAllowed(sensitivity: Sensitivity, spec: ModelSpec): void {
  if (spec.local) return;
  if (sensitivity === 'S2') {
    throw new SensitivityViolation(
      `S2 task refused: alias '${spec.alias}' runs on ${spec.provider} (non-local)`,
    );
  }
  if (localOnly()) {
    throw new SensitivityViolation(
      `local-only: alias '${spec.alias}' runs on ${spec.provider} (non-local). ` +
      `Unset FOREMAN_LOCAL_ONLY to allow cloud models again.`,
    );
  }
}

/**
 * Pick the first alias that exists, preferring local ones for S2 — and only
 * local ones in local-only mode, so a fallback can never pick a cloud alias
 * that assertAllowed would then refuse mid-run.
 */
export function pickAlias(preferred: string[], sensitivity: Sensitivity): string {
  const available = specs();
  const mustBeLocal = sensitivity === 'S2' || localOnly();
  for (const alias of preferred) {
    const spec = available.get(alias);
    if (spec && (!mustBeLocal || spec.local)) return alias;
  }
  for (const [alias, spec] of available) {
    if (!mustBeLocal || spec.local) return alias;
  }
  throw new ModelUnavailable('no model alias satisfies this task');
}

interface ChatOptions {
  alias: string;
  messages: ChatMessage[];
  sensitivity: Sensitivity;
  maxTokens?: number;
  temperature?: number;
  /**
   * `true` asks for "some JSON"; a JSON Schema asks for THIS json. Local 8-14B
   * models honour the first by replying with a well-formed object of their own
   * invention — a summary under `{"title","author"}` is valid JSON and a
   * useless verdict — so anything whose reply is parsed against a fixed shape
   * should pass the shape itself and let the runtime constrain decoding.
   */
  json?: boolean | Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Ollama only: how long to keep the model resident after the call. */
  keepAlive?: string;
  /**
   * Ollama only: the context window for this call. Left unset, Ollama uses its
   * own default (~4k) and SILENTLY DROPS the front of anything longer — so a
   * drafting call with an outline, a style sheet and the previous chapter in
   * front of it writes without the brief it was given, and reports success.
   * See localOnly.ts:contextTokensFor.
   */
  numCtx?: number;
  /**
   * Decoding seed. Temperature 0 alone is not bit-reproducible on Ollama —
   * batching and BLAS kernel choice still vary — so a fixed seed is what makes
   * the same prompt yield the same verdict twice.
   */
  seed?: number;
}


/**
 * How long to wait, given how much output was asked for.
 *
 * Since `postStream` made this an IDLE timeout rather than a total-duration
 * one, this number no longer has to predict how long a generation takes — it
 * only has to be longer than the longest plausible GAP between tokens. The
 * historical 180s default is already far more than that.
 *
 * A generous scaling is kept for large requests anyway, because the first gap
 * is not a gap between tokens at all: it is model load plus prompt evaluation,
 * and a 16k-token prompt on a cold 9B genuinely can take minutes before the
 * first chunk appears. That is the one wait a rate-free idle timer would still
 * get wrong.
 */
export function timeoutForCall(opts: { timeoutMs?: number; maxTokens?: number; local: boolean }): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  const floor = Number(process.env['FOREMAN_MODEL_TIMEOUT_MS'] ?? 180_000);
  if (!opts.local || !opts.maxTokens) return floor;
  // A big request implies a big prompt, and so a longer cold first chunk.
  return opts.maxTokens >= 4096 ? Math.max(floor, 600_000) : floor;
}

/**
 * POST and consume a newline-delimited or SSE stream, accumulating it.
 *
 * This exists for one measured reason. A non-streaming request sends NO
 * response headers until generation is complete, and undici — the fetch
 * implementation Node ships — gives up waiting for headers after 300 seconds
 * with `UND_ERR_HEADERS_TIMEOUT`. On this machine a local 9B sustains roughly
 * 10 tok/s, so any generation past about 2,500 tokens crossed that line and
 * died. Our own AbortSignal could not rescue it: undici had already given up.
 *
 * Streaming fixes it structurally rather than by raising a number. Headers
 * arrive immediately and a chunk lands every few hundred milliseconds, so
 * neither undici's header timeout nor its inter-chunk body timeout can fire.
 *
 * `onChunk` receives each decoded JSON object. The caller accumulates, because
 * Ollama's native stream and an OpenAI-compatible SSE stream carry the text in
 * different places and only the caller knows which it asked for.
 */
async function postStream(
  url: string,
  body: unknown,
  opts: { signal?: AbortSignal; timeoutMs: number; headers?: Record<string, string>; sse?: boolean },
  onChunk: (obj: any) => void,
): Promise<void> {
  const ac = new AbortController();
  // An IDLE timeout, not a total-duration one — and that distinction is the
  // whole reason streaming was worth doing.
  //
  // A total-duration ceiling has to be guessed from an assumed token rate,
  // which is a number that is wrong on every machine but the one it was
  // measured on, and wrong on that one as soon as something else is resident.
  // Guess low and an ordinary long draft is killed mid-scene; guess high and a
  // genuinely wedged call hangs for half an hour.
  //
  // A stream removes the guess. A generation that is still emitting tokens is
  // alive no matter how long it has been running; one that has emitted nothing
  // for `timeoutMs` is stuck. So the timer is reset by every chunk, and the
  // absolute ceiling on a run stays where it belongs — on the run
  // (FOREMAN_TASK_TIMEOUT_MS), which bounds the whole task rather than one call.
  let timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  const keepAliveTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  };
  const onAbort = (): void => ac.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new ModelUnavailable(`${url} \u2192 ${res.status}: ${text.slice(0, 300)}`);
    }
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      // Progress is proof of life: the clock restarts on every chunk.
      keepAliveTimer();
      buffered += decoder.decode(bytes, { stream: true });
      // A chunk boundary lands mid-line often enough that this matters: the
      // tail is kept and prepended to the next chunk rather than parsed.
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        const payload = opts.sse ? (line.startsWith('data:') ? line.slice(5).trim() : '') : line;
        if (!payload || payload === '[DONE]') continue;
        try {
          onChunk(JSON.parse(payload));
        } catch {
          // A malformed line is dropped rather than failing the call: a
          // truncated keep-alive comment must not lose 4,000 good tokens.
        }
      }
    }
    const rest = buffered.trim();
    if (rest) {
      const payload = opts.sse ? (rest.startsWith('data:') ? rest.slice(5).trim() : '') : rest;
      if (payload && payload !== '[DONE]') {
        try { onChunk(JSON.parse(payload)); } catch { /* same argument as above */ }
      }
    }
  } catch (err) {
    if (ac.signal.aborted && !opts.signal?.aborted) {
      throw new ModelUnavailable(`${url} sent nothing for ${opts.timeoutMs}ms`);
    }
    if (err instanceof ModelUnavailable) throw err;
    // `fetch` reports almost every transport failure as the bare string "fetch
    // failed" and hides what actually happened (ECONNRESET, a socket timeout,
    // a closed keep-alive connection) on `cause`. Dropping that turned a
    // diagnosable failure into an unfalsifiable one during a live drill, so
    // the cause is carried into the message.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    throw new ModelUnavailable(`${url}: ${(err as Error).message}${detail ? ` (${detail})` : ''}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** The CLI's own explanation of a failed call, from the JSON it still printed. */
function cliFailureCause(stdout: unknown): string | null {
  const text = typeof stdout === 'string' ? stdout : Buffer.isBuffer(stdout) ? stdout.toString('utf8') : '';
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as { result?: unknown };
    const result = String(parsed.result ?? '').trim();
    return result ? result.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/**
 * The CLI's own authentication failures — matched on how the CLI phrases them
 * at the START of its result, never anywhere in free text. A reviewer whose
 * reply discusses "the authentication module" also comes back in an is_error
 * envelope when it runs out of turns, and reading that as a sign-out would
 * flip the whole daemon on a model's prose.
 */
const AUTH_FAILURE = /^(failed to authenticate\b|invalid api key\b|not logged in\b|please run \/login\b|oauth (token|session) (has )?expired\b|authentication_error\b|api error: 401\b)/i;

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text.trim());
}

/**
 * Mark the Claude CLI unreachable because a real call failed on
 * authentication. Only a successful call clears it (see probeCloud).
 * Under `FOREMAN_LOCAL_ONLY=auto` this starts the local fallback, so the alias
 * registry is re-read — Claude aliases stop resolving the moment they stop
 * working.
 */
export function markCloudDown(reason: string): void {
  if (setCloudDown(reason)) reloadSpecs();
}

let probeGeneration = 0;

/**
 * Ask the CLI whether it is signed in. Free — no model call — and fast.
 *
 * Only a DEFINITIVE answer changes state: `loggedIn:false`, or no binary at
 * all. Output this cannot parse is "unknown" and leaves the state alone,
 * because an older or wrapped CLI that does not speak `auth status` must not
 * change routing.
 *
 * `loggedIn:true` is a hint, not proof: the CLI reports it for credentials
 * that are present but invalid. So it never clears a down state on its own —
 * recovery is confirmed by one real, tiny call, and only that clears it.
 * Overlapping probes (the boot timer, doctor, drill) are ordered by a
 * generation counter, so a slow stale answer cannot overwrite a newer one.
 */
let probeInFlight: Promise<string | null> | null = null;

export function probeCloud(): Promise<string | null> {
  // Overlapping callers (the boot timer, doctor, drill) share one probe, so a
  // down state costs one confirmation call, not one per caller.
  probeInFlight ??= probeCloudOnce().finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

async function probeCloudOnce(): Promise<string | null> {
  // Only auto mode routes on the answer. Under `on` nothing calls Claude, and
  // under `off` the operator has said not to fall back — probing there would
  // spend real confirmation calls to change nothing.
  if (localOnlyMode() !== 'auto') return cloudDown();
  const generation = ++probeGeneration;
  const bin = process.env['FOREMAN_CLAUDE_BIN'] ?? 'claude';
  let verdict: string | null | undefined;
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(bin, ['auth', 'status', '--json'], { timeout: 15_000, cwd: os.tmpdir() }));
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') verdict = `claude cli not found ('${bin}')`;
    // A signed-out CLI exits 1 and still prints its JSON, so the answer is on
    // the error path; dropping it there read every sign-out as "unknown".
    else stdout = String((err as { stdout?: unknown }).stdout ?? '');
  }
  if (verdict === undefined) {
    try {
      const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
      if (parsed.loggedIn === false) verdict = 'claude cli is not signed in — run `claude` and /login';
    } catch {
      /* unreadable: unknown */
    }
  }
  // Up is never taken from the status line: it says loggedIn:true for invalid
  // credentials. While down, and not definitively signed out or missing, one
  // tiny real call decides — including when the status line is unreadable,
  // because nothing else calls Claude during a fallback and an older CLI would
  // otherwise hold it until a restart. A failing auth call costs nothing.
  if (verdict === undefined && cloudDown() !== null) {
    try {
      await runClaudeCli(CLAUDE_SPECS.find((c) => c.alias === 'haiku')!.model, 'Reply with the single word: ok', {
        timeoutMs: 60_000,
        updateCloudState: false,
      });
      verdict = null;
    } catch (err) {
      verdict = cloudDown() ?? `claude cli still failing: ${(err as Error).message.slice(0, 200)}`;
    }
  }
  if (generation !== probeGeneration) return cloudDown();
  if (verdict !== undefined && setCloudDown(verdict)) reloadSpecs();
  return cloudDown();
}

/**
 * One headless `claude -p` call, returned as text plus token counts.
 *
 * Deliberately not the streaming `stream-json` format the CLI runners use:
 * this is a single question expecting a single answer, and `--output-format
 * json` gives exactly that in one object. The CLI is a subscription client, so
 * it does its own retry and rate-limit handling; what it cannot do is tell us
 * apart from a runner, which is why the timeout is enforced here.
 */
async function runClaudeCli(
  model: string,
  prompt: string,
  /**
   * `updateCloudState: false` is for probeCloud's confirmation call, whose
   * result must be applied under the probe's generation check — a slow
   * confirmation finishing after a newer, definitive sign-out must not undo it.
   */
  opts: { signal?: AbortSignal; timeoutMs: number; updateCloudState?: boolean },
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const track = opts.updateCloudState ?? true;
  const bin = process.env['FOREMAN_CLAUDE_BIN'] ?? 'claude';
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'json',
    // A judge answers from the prompt; it does not go looking. Without this the
    // model reaches for Read, the headless session cannot serve it, and the CLI
    // returns {"is_error":true,"stop_reason":"tool_use"} — the same failure
    // already fixed in ownerCall, which this path did not inherit because it
    // was written separately.
    '--max-turns', '3',
    '--disallowed-tools',
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
  ];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  const onAbort = (): void => ac.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const { stdout } = await execFileAsync(bin, args, {
      signal: ac.signal,
      maxBuffer: 32e6,
      // The CLI inherits the caller's cwd and would otherwise read whatever
      // CLAUDE.md and settings happen to sit there, so a judge's verdict would
      // depend on which directory the daemon was started from.
      cwd: os.tmpdir(),
    });
    const parsed = JSON.parse(stdout) as {
      result?: unknown;
      is_error?: boolean;
      subtype?: string;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    if (parsed.is_error) {
      if (track && isAuthFailure(String(parsed.result ?? ''))) markCloudDown(`claude cli: ${String(parsed.result).slice(0, 200)}`);
      throw new ModelUnavailable(`claude cli returned an error (${parsed.subtype ?? 'unknown'}): ${String(parsed.result ?? '').slice(0, 300)}`);
    }
    // A call that worked is the only proof the CLI is back (see probeCloud).
    if (track && cloudDown() !== null && setCloudDown(null)) reloadSpecs();
    const usage = parsed.usage ?? {};
    return {
      text: String(parsed.result ?? ''),
      // Cache reads and creations are real prompt tokens that were really
      // processed; omitting them would under-report a long review by an order
      // of magnitude and make the receipts useless for the one thing they are
      // for, which is knowing what this work costs.
      tokensIn: Number(usage.input_tokens ?? 0)
        + Number(usage.cache_read_input_tokens ?? 0)
        + Number(usage.cache_creation_input_tokens ?? 0),
      tokensOut: Number(usage.output_tokens ?? 0),
    };
  } catch (err) {
    if (ac.signal.aborted && !opts.signal?.aborted) {
      throw new ModelUnavailable(`claude cli timed out after ${opts.timeoutMs}ms`);
    }
    if (err instanceof ModelUnavailable) throw err;
    // The CLI exits non-zero WITH its JSON on stdout, and that JSON is the only
    // place the actual cause lives ("OAuth session expired"). execFile's own
    // message is the command line, which is 300 characters of arguments and
    // nothing an operator can act on.
    const cause = cliFailureCause((err as { stdout?: unknown }).stdout);
    if (cause) {
      if (track && isAuthFailure(cause)) markCloudDown(`claude cli: ${cause}`);
      throw new ModelUnavailable(`claude cli: ${cause}`);
    }
    throw new ModelUnavailable(`claude cli: ${(err as Error).message.slice(0, 300)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const spec = resolveSpec(opts.alias);
  assertAllowed(opts.sensitivity, spec);
  const started = Date.now();
  const timeoutMs = timeoutForCall({ timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens, local: spec.local });

  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let doneReason = '';

  if (spec.provider === 'claude-cli') {
    // The CLI takes one prompt, not a message list, so the conversation is
    // flattened. System content leads and is labelled, because `claude -p`
    // has no separate system channel in headless mode and an unlabelled
    // instruction block reads as part of the user's question.
    const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
      .join('\n\n');
    // A JSON schema cannot constrain decoding here the way it can on Ollama,
    // so the shape is put in the prompt — the same lesson earlier measurement
    // recorded for local models, for a different reason.
    const shape = typeof opts.json === 'object' && opts.json !== null
      ? `\n\nReply with ONLY a JSON object matching this schema, and no prose:\n${JSON.stringify(opts.json)}`
      : opts.json
        ? '\n\nReply with ONLY a JSON object, and no prose.'
        : '';
    const prompt = `${system ? `${system}\n\n---\n\n` : ''}${rest}${shape}`;
    const out = await runClaudeCli(spec.model, prompt, { signal: opts.signal, timeoutMs });
    text = out.text;
    tokensIn = out.tokensIn;
    tokensOut = out.tokensOut;
  } else if (spec.provider === 'ollama') {
    const base = process.env['FOREMAN_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
    // The native endpoint is deliberate: Ollama's OpenAI-compatible route
    // silently ignores `think:false`, which costs minutes per call.
    let content = '';
    try {
      await postStream(`${base}/api/chat`, {
        model: spec.model,
        messages: opts.messages,
        // Streaming is not a preference here — see postStream's comment. A
        // non-streaming call over ~2,500 tokens dies on undici's header timeout.
        stream: true,
        think: false,
        keep_alive: opts.keepAlive,
        format: typeof opts.json === 'object' ? opts.json : opts.json ? 'json' : undefined,
        options: {
          temperature: opts.temperature ?? 0,
          num_predict: opts.maxTokens ?? 1024,
          ...(opts.numCtx === undefined ? {} : { num_ctx: opts.numCtx }),
          ...(opts.seed === undefined ? {} : { seed: opts.seed }),
        },
      }, { signal: opts.signal, timeoutMs }, (obj) => {
        // A mid-stream error object is an error, not content. Ollama emits one
        // and then stops; without this the partial text before it is returned as
        // if it were the whole reply.
        if (obj?.error) throw new ModelUnavailable(`${spec.model}: ${String(obj.error).slice(0, 300)}`);
        content += String(obj?.message?.content ?? '');
        // Ollama reports the counts only on its final object, so these are
        // assigned whenever present rather than read once at the end.
        if (obj?.prompt_eval_count != null) tokensIn = Number(obj.prompt_eval_count);
        if (obj?.eval_count != null) tokensOut = Number(obj.eval_count);
        if (obj?.done_reason != null) doneReason = String(obj.done_reason);
      });
    } catch (err) {
      // Name the usual cause when it is the cause: a machine paging this model
      // in looks, from here, exactly like a hung server.
      if (err instanceof ModelUnavailable && /sent nothing for/.test(err.message)) {
        const pressure = memoryWarning(await readMemory(), (await modelSizeGb(spec.model)) ?? undefined);
        if (pressure) throw new ModelUnavailable(`${err.message} — ${pressure}`);
      }
      throw err;
    }
    text = content;
    // THE defect this guards, and it is the worst kind: a reply cut off at the
    // token ceiling is partial JSON, `repairJson` closes its brackets, and
    // because `verdict` is the FIRST field of VERDICT_SCHEMA it survives the
    // cut — so `{"verdict":"pass","confidence":0.9,"issues":["the diff looks
    // fine so f` becomes a well-formed PASS. It is then cached under a key that
    // says nothing about it being truncated, and a fail has silently become a
    // pass forever.
    //
    // A truncated generation is not an answer. Refuse it and let the caller
    // treat it as an unreachable advisor, which is a split, which parks for a
    // human — the behaviour the council already promises.
    if (doneReason === 'length') {
      throw new TruncatedReply(
        `${spec.model} hit its output ceiling (${opts.maxTokens ?? 1024} tokens) mid-reply; ` +
        'a truncated generation is not a verdict',
      );
    }
  } else {
    const base = (spec.baseUrl ?? process.env['FOREMAN_GATEWAY_URL'] ?? 'http://127.0.0.1:4000/v1').replace(/\/$/, '');
    const key = process.env['FOREMAN_GATEWAY_KEY'];
    let content = '';
    await postStream(`${base}/chat/completions`, {
      model: spec.model,
      messages: opts.messages,
      // Same reasoning as the Ollama branch: a persona's mlx_lm.server is doing
      // exactly the long generations that cross undici's header timeout.
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.seed === undefined ? {} : { seed: opts.seed }),
      response_format:
        typeof opts.json === 'object'
          ? { type: 'json_schema', json_schema: { name: 'verdict', schema: opts.json, strict: true } }
          : opts.json
            ? { type: 'json_object' }
            : undefined,
    }, {
      signal: opts.signal,
      timeoutMs,
      headers: key ? { authorization: `Bearer ${key}` } : {},
      sse: true,
    }, (obj) => {
      if (obj?.error) throw new ModelUnavailable(`${spec.model}: ${String(obj.error?.message ?? obj.error).slice(0, 300)}`);
      const choice = obj?.choices?.[0];
      if (choice?.finish_reason != null) doneReason = String(choice.finish_reason);
      // A server that ignores `stream` and answers with one whole completion
      // still parses here, because the non-streaming shape carries `message`.
      content += String(choice?.delta?.content ?? choice?.message?.content ?? '');
      if (obj?.usage?.prompt_tokens != null) tokensIn = Number(obj.usage.prompt_tokens);
      if (obj?.usage?.completion_tokens != null) tokensOut = Number(obj.usage.completion_tokens);
    });
    text = content;
    // Same defect, OpenAI's spelling of it.
    if (doneReason === 'length') {
      throw new TruncatedReply(
        `${spec.model} hit its output ceiling (${opts.maxTokens ?? 1024} tokens) mid-reply; ` +
        'a truncated generation is not a verdict',
      );
    }
  }

  const costUsd = (tokensIn / 1e6) * spec.usdPerMTokIn + (tokensOut / 1e6) * spec.usdPerMTokOut;
  return { text, tokensIn, tokensOut, costUsd, latencyMs: Date.now() - started, spec };
}

/**
 * Close a reply whose brackets do not. Local models emit near-miss JSON often
 * enough that discarding it costs real verdicts: an observed advisor reply
 * ended `…"issues":["…"}]` — the object closed before the array it was still
 * inside, which no `format` schema prevented. This walks the text tracking
 * open brackets outside strings, drops a closer that does not match what is
 * actually open, and appends the ones that are missing.
 *
 * It only ever runs after a strict parse has already failed, so it cannot
 * change how a well-formed reply is read; and every caller still validates the
 * SHAPE afterwards, so a repair that produces nonsense is rejected exactly as
 * an unparseable reply was.
 */
export function repairJson(text: string): string | null {
  const stack: string[] = [];
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch === '{' ? '}' : ']'); out += ch; continue; }
    if (ch === '}' || ch === ']') {
      // A closer for something that is not the innermost open bracket is the
      // transposition this exists for: skip it and let the tail rebuild.
      if (stack[stack.length - 1] === ch) { stack.pop(); out += ch; }
      continue;
    }
    out += ch;
  }
  if (inString) out += '"';
  if (!stack.length) return out === text ? null : out;
  while (stack.length) out += stack.pop();
  return out;
}

/** Models fence JSON in prose and code fences often enough to be worth handling. */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    const braced = trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
    for (const slice of [trimmed, braced]) {
      if (!slice) continue;
      try {
        return JSON.parse(slice) as T;
      } catch {
        /* try the next shape */
      }
    }
    // Last resort, and only for something that looked like an object to begin
    // with: a reply of plain prose has nothing to repair.
    const start = trimmed.indexOf('{');
    if (start === -1) continue;
    const repaired = repairJson(trimmed.slice(start));
    if (!repaired) continue;
    try {
      return JSON.parse(repaired) as T;
    } catch {
      /* genuinely unparseable: the caller treats it as no reply */
    }
  }
  return null;
}

/**
 * A stable seed derived from the prompt itself: the same review of the same
 * diff decodes identically, while a different prompt gets a different (but
 * still reproducible) sample. Kept inside the 32-bit range servers accept.
 */
export function seedFor(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash | 0) % 2_147_483_647;
}
