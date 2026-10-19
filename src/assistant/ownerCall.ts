import { extractJson } from '../models.ts';
// Type-only: the receipt is written through the Store the caller already has,
// so this stays an erased edge and ownerCall keeps no runtime dep on queue.ts.
import type { Store } from '../queue.ts';
import { spawnStreaming } from '../runners/proc.ts';
import { cloudDown, cloudFallback, localOnly, localOnlyLabel } from '../localOnly.ts';
import { isAuthFailure, markCloudDown } from '../models.ts';
import { tierModel, type Tier } from '../roles.ts';

export interface OwnerCallResult {
  text: string;
  costUsd: number;
}

export type OwnerCallReason = 'spawn' | 'timeout' | 'aborted' | 'exit' | 'parse';

/** Typed so callers can degrade on a specific failure instead of string-matching. */
export class OwnerCallError extends Error {
  readonly reason: OwnerCallReason;
  constructor(reason: OwnerCallReason, message: string) {
    super(message);
    this.name = 'OwnerCallError';
    this.reason = reason;
  }
}

export interface OwnerCallOptions {
  signal?: AbortSignal;
  /** Hard cap on CLI turns — planning is one shot, not an agent loop. */
  maxTurns?: number;
  timeoutMs?: number;
  /** Tier override; Phase 3 reuses this call for senior reviewers. */
  tier?: Tier;
  /** Explicit model, winning over `tier`. */
  model?: string;
  cwd?: string;
  /** Where to bill this call. Omit only for calls that must not be metered. */
  store?: Store;
  /** Receipt `kind`, e.g. 'plan'; errors settle as `<kind>:error` like the broker's. */
  kind?: string;
  /** Task the spend belongs to; planning usually has none yet. */
  taskId?: string | null;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Tools the Owner model may not reach for.
 *
 * Every caller of `ownerCall` — the planner, the gate, a crew reviewer — hands
 * over a self-contained prompt and wants a judgement about what is IN it, not
 * an agent that goes looking for more. Left enabled, the model reaches for Read
 * to open a file the prompt already quoted, the headless session cannot serve
 * it, and the CLI returns `{"is_error":true,"stop_reason":"tool_use"}`. That
 * surfaces as "the owner model could not be reached" and holds the ticket:
 * observed on six of nine gate decisions in one run, with the three that landed
 * being the three where it happened not to reach for anything.
 */
const DISALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
];
/** The CLI is subscription-billed and hosted; it is never a local provider. */
export const OWNER_PROVIDER = 'claude-cli';

/**
 * One-shot Claude call through the `claude` CLI, deliberately NOT through the
 * broker: the broker routes local/hosted API models by alias and bills tokens,
 * while the Owner tier is a subscription-billed CLI model. `--output-format
 * json` makes the whole reply a single result envelope, so this stays a
 * request/response call with no streaming state machine.
 */
export async function ownerCall(prompt: string, opts: OwnerCallOptions = {}): Promise<OwnerCallResult> {
  if (!prompt.trim()) throw new OwnerCallError('spawn', 'prompt cannot be empty');
  // This lane spawns the hosted CLI directly and so never passes through the
  // broker's `assertAllowed` — which is the single choke point everything else
  // relies on. Under FOREMAN_LOCAL_ONLY that meant the crew review chain, the
  // planner, the plan critic and the playbook forge all still sent their
  // prompts off the machine while the flag promised nothing would. The promise
  // is the whole feature; enforce it here as well.
  if (localOnly()) {
    throw new OwnerCallError(
      'spawn',
      `${localOnlyLabel()}: the owner CLI is a hosted model and may not be called`,
    );
  }
  // Not a promise being kept but a CLI known not to answer: every caller
  // already degrades on a spawn error (keyword classification, park for a
  // human, the council's verdict), and that beats a 30-second wait to learn it.
  if (cloudFallback()) {
    throw new OwnerCallError('spawn', `the Claude CLI is unreachable (${cloudDown()}); not calling it`);
  }
  const bin = process.env['FOREMAN_CLAUDE_BIN'] ?? 'claude';
  const model = opts.model ?? tierModel(opts.tier ?? 'owner');
  const startedAt = Date.now();
  // Owner spend is real money that never passes through the broker, so it has
  // to be settled here or `spentToday()`/`foreman receipts` under-report it.
  const settle = (kind: string, costUsd: number, usage?: Record<string, unknown>): void => {
    if (!opts.store || !opts.kind) return;
    opts.store.addReceipt({
      taskId: opts.taskId ?? null,
      kind,
      provider: OWNER_PROVIDER,
      model,
      local: false,
      tokensIn: Number(usage?.['input_tokens'] ?? 0) || 0,
      tokensOut: Number(usage?.['output_tokens'] ?? 0) || 0,
      costUsd,
      latencyMs: Date.now() - startedAt,
    });
  };
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', model,
    '--max-turns', String(Math.max(1, Math.trunc(opts.maxTurns ?? 5))),
    // No tools. Every caller of this — the planner, the gate, a reviewer —
    // hands over a self-contained prompt and wants a judgement about what is
    // IN it, not an agent that goes looking for more.
    //
    // Without this the model reaches for Read to open a file the prompt
    // already quoted, the headless session has no such tool, and the CLI
    // returns `{"is_error":true,"stop_reason":"tool_use"}` — which reads as
    // "the owner model could not be reached" and holds the ticket. Observed on
    // six of nine gate decisions in one run; the three that landed were the
    // three where it happened not to reach.
    //
    // The flag is VARIADIC — space-separated names, not a comma-joined string.
    // Passing one comma-joined argument makes the CLI exit non-zero with no
    // JSON at all, which is a worse failure than the one being fixed. It stays
    // last in argv for the same reason: a variadic flag swallows whatever
    // follows it.
    '--disallowed-tools', ...DISALLOWED_TOOLS,
  ];

  // Own controller so a timeout is distinguishable from the caller's abort.
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  const stdout: string[] = [];
  const stderr: string[] = [];
  let code: number;
  try {
    code = await spawnStreaming(bin, args, {
      cwd: opts.cwd ?? process.cwd(),
      signal: controller.signal,
      onLine: (line, stream) => (stream === 'stdout' ? stdout : stderr).push(line),
    });
  } catch (err) {
    // Nothing ran, so nothing was billed: no receipt for a failed spawn.
    throw new OwnerCallError('spawn', `cannot run '${bin}': ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  const envelope = extractJson<Record<string, unknown>>(stdout.join('\n'));
  const costUsd = Number(envelope?.['total_cost_usd'] ?? 0) || 0;
  const usage = (envelope?.['usage'] ?? undefined) as Record<string, unknown> | undefined;
  const errorKind = `${opts.kind ?? 'owner'}:error`;

  // A killed or abandoned call may still have burned tokens upstream; record
  // what the envelope admits to (usually nothing) rather than losing the row.
  if (timedOut) {
    settle(errorKind, costUsd, usage);
    throw new OwnerCallError('timeout', `owner call timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
  }
  if (opts.signal?.aborted) {
    settle(errorKind, costUsd, usage);
    throw new OwnerCallError('aborted', 'owner call aborted');
  }

  const text = typeof envelope?.['result'] === 'string' ? envelope['result'].trim() : '';
  // A usable envelope wins over the exit code: the CLI can exit non-zero on a
  // trailing warning while still having produced the reply we asked for.
  if (!envelope || envelope['is_error'] === true || !text) {
    settle(errorKind, costUsd, usage);
    // The planner, the gate and every crew reviewer reach Claude through here,
    // not the broker, so a lapsed sign-in must be noticed here too — or auto
    // mode never falls back for the work that fails most visibly.
    if (envelope?.['is_error'] === true && isAuthFailure(text)) markCloudDown(`claude cli: ${text.slice(0, 200)}`);
    const detail = stderr.slice(-3).join(' | ') || stdout.slice(-3).join(' | ') || `exit ${code}`;
    throw new OwnerCallError(
      envelope ? 'parse' : code === 0 ? 'parse' : 'exit',
      `owner call produced no usable reply (${detail.slice(0, 300)})`,
    );
  }
  settle(opts.kind ?? 'owner', costUsd, usage);
  return { text, costUsd };
}
