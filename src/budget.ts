import { readBench } from './bench.ts';
import { chat, ModelUnavailable, resolveSpec, specs, type ChatMessage, type ChatResult } from './models.ts';
import { modelFits, modelInstalled } from './memory.ts';
import type { Store } from './queue.ts';
import type { Sensitivity } from './types.ts';

export class BudgetExceeded extends Error {}

export interface CallRequest {
  taskId: string | null;
  runId: string | null;
  /** What the spend was for: 'council', 'chair', 'agent', 'memory'. */
  kind: string;
  alias: string;
  messages: ChatMessage[];
  sensitivity: Sensitivity;
  /** Per-task ceiling; null means only the daily cap applies. */
  taskBudgetUsd?: number | null;
  maxTokens?: number;
  temperature?: number;
  /** `true` for any JSON; a JSON Schema to constrain decoding to one shape. */
  json?: boolean | Record<string, unknown>;
  signal?: AbortSignal;
  keepAlive?: string;
  seed?: number;
  /** Ollama context window for this call; see localOnly.ts:contextTokensFor. */
  numCtx?: number;
  /**
   * Run exactly this alias or fail — never a smaller one. For callers whose
   * result is a MEASUREMENT of the model asked for: the bench, the readiness
   * drill, an adoption judge. A stepped-down answer there is a wrong number
   * recorded under the right name.
   */
  noDownshift?: boolean;
}

/** An error thrown after the broker had already stepped down, or seen a stall. */
export function steppedDownError(err: unknown): string | null {
  return (err as { steppedDownFrom?: string } | null)?.steppedDownFrom ?? null;
}

/** How long a model that did not fit (or stalled) is skipped before it is tried again. */
function stepDownHoldMs(): number {
  const raw = Number(process.env['FOREMAN_DOWNSHIFT_HOLD_MS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 60_000;
}

interface BrokerOptions {
  dailyCapUsd?: number;
  concurrency?: Record<string, number>;
  /** Injectable so tests can exercise the broker without a model server. */
  chatFn?: typeof chat;
  /** Which models are currently resident. Injectable for the same reason. */
  loadedModelsFn?: () => Promise<Set<string>>;
  /** Set false to dispatch without the VRAM guard (single-model installs). */
  guardResidency?: boolean;
  /**
   * Whether a model can load now (memory.ts:modelFits). Injectable so tests can
   * drive the step-down decision without a machine in a particular state.
   */
  fitsFn?: (model: string, numCtx: number | undefined) => Promise<boolean>;
  /** Whether a model is pulled at all. A step-down target that is not is skipped, never tried. */
  installedFn?: (model: string) => Promise<boolean>;
}

const envNum = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The daily ceiling, read lazily. Exported because Owner-tier calls bypass the
 * broker (they are subscription-billed CLI calls, see assistant/ownerCall.ts)
 * and so have to consult the same number themselves rather than a copy of it.
 * 0 or less means "no cap", exactly as the broker reads it.
 */
export function dailyCapUsd(): number {
  return envNum('FOREMAN_DAILY_USD_CAP', 5);
}

/**
 * The ceiling on NOTIONAL subscription spend, in list-price dollars.
 *
 * Deliberately far above the metered cap and doing a different job. The metered
 * cap protects real money, so $5 is a sane default. Subscription calls cost no
 * money at all, and holding them to the same $5 hard-stopped every task on the
 * board after a handful of Opus reviews — spending nobody had done. But they
 * are not free either: a runaway loop burns a rate limit exactly as fast as it
 * would burn a card, which is what this still catches.
 */
export function subscriptionCapUsd(): number {
  return envNum('FOREMAN_DAILY_SUBSCRIPTION_USD_CAP', 200);
}

/**
 * Every model call in Foreman goes through here: reserve against the caps,
 * wait for a provider slot, call, then settle actual spend into a receipt.
 * Reserving before the call is what stops N parallel workers from each
 * individually fitting under a cap they collectively blow through.
 */
export class Broker {
  private readonly store: Store;
  private readonly dailyCapUsd: number;
  private readonly limits: Record<string, number>;
  private readonly inFlight = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();
  /** Reserved-but-not-yet-settled dollars, keyed by task. */
  private readonly pending = new Map<string, number>();
  private pendingTotal = 0;
  private readonly chatFn: typeof chat;
  private readonly loadedModelsFn: () => Promise<Set<string>>;
  private readonly guardResidency: boolean;
  private readonly fitsFn: NonNullable<BrokerOptions['fitsFn']>;
  private readonly installedFn: NonNullable<BrokerOptions['installedFn']>;
  /**
   * Models judged too big — by the fit check, or by stalling — and until when.
   * Without this hold the decision oscillates: once the stepped-down model is
   * resident, its memory counts as evictable, the big model "fits" again, the
   * next call loads it and stalls — the exact failure stepping down avoided.
   */
  private readonly tooBigUntil = new Map<string, { until: number; numCtx: number }>();
  /** In-flight calls per concrete model, for the residency guard. */
  private readonly liveModels = new Map<string, number>();
  private readonly drainWaiters: Array<() => void> = [];

  constructor(store: Store, opts: BrokerOptions = {}) {
    this.store = store;
    this.chatFn = opts.chatFn ?? chat;
    this.loadedModelsFn = opts.loadedModelsFn ?? loadedOllamaModels;
    this.guardResidency = opts.guardResidency ?? process.env['FOREMAN_VRAM_GUARD'] !== 'off';
    // A broker with an injected chat function is talking to no real model, so
    // the real machine's memory must not steer it — that would make every
    // test depend on what else happens to be running.
    this.fitsFn = opts.fitsFn ?? (opts.chatFn ? async () => true : modelFits);
    this.installedFn = opts.installedFn ?? (opts.chatFn ? async () => true : modelInstalled);
    this.dailyCapUsd = opts.dailyCapUsd ?? dailyCapUsd();
    this.limits = {
      ollama: envNum('FOREMAN_OLLAMA_CONCURRENCY', 2),
      openai: envNum('FOREMAN_GATEWAY_CONCURRENCY', 4),
      ...opts.concurrency,
    };
  }

  /** Whether a model can load now — the same judgement `call` steps down on, hold included. */
  async fits(model: string, numCtx: number | undefined): Promise<boolean> {
    if (this.held(model, numCtx)) return false;
    return this.fitsFn(model, numCtx).catch(() => true);
  }

  /**
   * Held off: this model failed to fit (or stalled) recently at this window or
   * a smaller one. A smaller window than the one that failed is not held — a
   * 32k call that did not fit says nothing about a 2k call.
   */
  private held(model: string, numCtx: number | undefined): boolean {
    const hold = this.tooBigUntil.get(model);
    return !!hold && hold.until > Date.now() && (numCtx ?? 4096) >= hold.numCtx;
  }

  /**
   * Start a hold. Only on fresh evidence — a fit check that said no, or a
   * stall — never because the model was already held: re-arming on every
   * call kept a busy daemon's hold alive forever, so the big model was never
   * tried again and the re-check sweep never saw it fit.
   */
  private holdTooBig(model: string, numCtx: number | undefined): void {
    const ctx = numCtx ?? 4096;
    const prev = this.tooBigUntil.get(model);
    const keep = prev && prev.until > Date.now() ? Math.min(prev.numCtx, ctx) : ctx;
    this.tooBigUntil.set(model, { until: Date.now() + stepDownHoldMs(), numCtx: keep });
  }

  get dailyCap(): number {
    return this.dailyCapUsd;
  }

  /** Cheap upper bound: ~4 chars per token in, plus the full output allowance. */
  estimate(req: CallRequest): number {
    const spec = resolveSpec(req.alias);
    const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
    const tokensIn = Math.ceil(chars / 4);
    const tokensOut = req.maxTokens ?? 1024;
    return (tokensIn / 1e6) * spec.usdPerMTokIn + (tokensOut / 1e6) * spec.usdPerMTokOut;
  }

  private checkCaps(req: CallRequest, estimated: number): void {
    // Locality, not price, is what makes a call free. An alias in models.json
    // with its rates omitted defaults to $0 per token — and returning early on
    // a zero ESTIMATE meant a real metered provider billed real money while
    // every receipt read $0.00 and no cap ever bound. Ask what it runs on.
    if (resolveSpec(req.alias).local && estimated === 0) return;
    const day = this.store.spentToday() + this.pendingTotal + estimated;
    if (this.dailyCapUsd > 0 && day > this.dailyCapUsd) {
      throw new BudgetExceeded(
        `daily cap reached: $${day.toFixed(4)} would exceed $${this.dailyCapUsd.toFixed(2)}`,
      );
    }
    if (req.taskId && req.taskBudgetUsd != null) {
      const spent = this.store.spentOnTask(req.taskId) + (this.pending.get(req.taskId) ?? 0) + estimated;
      if (spent > req.taskBudgetUsd) {
        throw new BudgetExceeded(
          `task budget reached: $${spent.toFixed(4)} would exceed $${req.taskBudgetUsd.toFixed(2)}`,
        );
      }
    }
  }

  private async acquire(provider: string, signal?: AbortSignal): Promise<void> {
    const limit = this.limits[provider] ?? 4;
    for (;;) {
      if (signal?.aborted) throw new Error('aborted while waiting for a provider slot');
      const used = this.inFlight.get(provider) ?? 0;
      if (used < limit) {
        this.inFlight.set(provider, used + 1);
        return;
      }
      // Waiting for a slot must be interruptible: a cancelled task or a
      // shutting-down daemon cannot be held hostage by someone else's call.
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const queue = this.waiters.get(provider);
          const at = queue?.indexOf(wake) ?? -1;
          if (queue && at >= 0) queue.splice(at, 1);
          reject(new Error('aborted while waiting for a provider slot'));
        };
        const queue = this.waiters.get(provider) ?? [];
        queue.push(wake);
        this.waiters.set(provider, queue);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  private release(provider: string): void {
    this.inFlight.set(provider, Math.max(0, (this.inFlight.get(provider) ?? 1) - 1));
    const next = this.waiters.get(provider)?.shift();
    next?.();
  }

  /**
   * VRAM guard: dispatching a model that is not resident while a *different*
   * model is mid-call makes the runtime evict the busy one and reload it
   * moments later — both calls then crawl. Wait for the in-flight work to
   * drain instead, so two large models serialise rather than thrash.
   */
  private async awaitResidency(spec: { provider: string; model: string }, signal?: AbortSignal): Promise<void> {
    if (!this.guardResidency || spec.provider !== 'ollama') return;
    for (;;) {
      const others = [...this.liveModels.entries()].filter(([m, n]) => m !== spec.model && n > 0);
      if (!others.length) return;
      let loaded: Set<string>;
      try {
        loaded = await this.loadedModelsFn();
      } catch {
        return; // if we cannot see the runtime, do not block on a guess
      }
      if (loaded.has(spec.model)) return; // already resident: no eviction to cause
      if (signal?.aborted) throw new Error('aborted while waiting for model residency');
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const at = this.drainWaiters.indexOf(wake);
          if (at >= 0) this.drainWaiters.splice(at, 1);
          reject(new Error('aborted while waiting for model residency'));
        };
        this.drainWaiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  private releaseModel(model: string): void {
    const left = (this.liveModels.get(model) ?? 1) - 1;
    if (left > 0) this.liveModels.set(model, left);
    else this.liveModels.delete(model);
    while (this.drainWaiters.length) this.drainWaiters.shift()?.();
  }

  /**
   * The aliases this call may run on, best first: the one asked for, then its
   * step-down chain (models.ts). Only local Ollama aliases step down — a cloud
   * model has no memory to run out of, and an adopted persona never silently
   * becomes its unadapted base.
   */
  private async chainFor(req: CallRequest): Promise<string[]> {
    const spec = resolveSpec(req.alias);
    if (req.noDownshift || process.env['FOREMAN_DOWNSHIFT'] === 'off' || spec.provider !== 'ollama' || !spec.local) {
      return [req.alias];
    }
    const all = specs();
    const chain = [req.alias];
    for (const alias of spec.downshift ?? []) {
      const next = all.get(alias);
      if (!next || !next.local || next.provider !== 'ollama' || chain.includes(alias)) continue;
      // A step-down target that was never pulled would turn a slow call into a
      // hard 404; it is skipped, and the chain goes on to the next.
      if (!(await this.installedFn(next.model).catch(() => true))) continue;
      chain.push(alias);
    }
    return chain;
  }

  /**
   * Run a model call, stepping down to a smaller model when the one asked for
   * cannot run on this machine right now.
   *
   * Two triggers. Before the call: the intended model does not fit in memory
   * (memory.ts:modelFits), or did not fit recently — the first model in the
   * chain that does is used, or the smallest if none does. During it: a local
   * model that stalls ("sent nothing for…") is retried one step down rather
   * than failing the task, because that stall is what a model paging itself in
   * looks like from here. A model that did not fit is held off for a while
   * (FOREMAN_DOWNSHIFT_HOLD_MS, default 10 min) so the choice does not flap.
   *
   * Either way the result carries `downshiftedFrom` and the receipt records it,
   * and an error thrown after a step-down carries `steppedDownFrom`, so a
   * reviewer can mark its verdict provisional and the scheduler can re-check
   * the work with the full model once it fits.
   */
  async call(req: CallRequest): Promise<ChatResult> {
    const chain = await this.chainFor(req);
    let start = chain.length - 1;
    for (let i = 0; i < chain.length - 1; i++) {
      const model = resolveSpec(chain[i]!).model;
      if (this.held(model, req.numCtx)) continue;
      if (await this.fitsFn(model, req.numCtx).catch(() => true)) {
        start = i;
        break;
      }
      this.holdTooBig(model, req.numCtx);
    }
    let stalledAny = false;
    for (let i = start; ; i++) {
      const alias = chain[i]!;
      try {
        const result = await this.callOne({ ...req, alias }, alias === req.alias ? undefined : req.alias);
        return alias === req.alias ? result : { ...result, downshiftedFrom: req.alias };
      } catch (err) {
        const stalled = err instanceof ModelUnavailable && /sent nothing for/.test(err.message);
        if (stalled) {
          stalledAny = true;
          this.holdTooBig(resolveSpec(alias).model, req.numCtx);
        }
        if (!stalled || i >= chain.length - 1 || req.signal?.aborted) {
          if ((i > 0 || stalledAny) && chain.length > 1 && err && typeof err === 'object' && Object.isExtensible(err)) {
            (err as { steppedDownFrom?: string }).steppedDownFrom = req.alias;
          }
          throw err;
        }
      }
    }
  }

  private async callOne(req: CallRequest, downshiftedFrom: string | undefined): Promise<ChatResult> {
    const spec = resolveSpec(req.alias);
    const estimated = this.estimate(req);
    this.checkCaps(req, estimated);

    const key = req.taskId ?? '';
    this.pending.set(key, (this.pending.get(key) ?? 0) + estimated);
    this.pendingTotal += estimated;

    try {
      await this.acquire(spec.provider, req.signal);
    } catch (err) {
      this.pendingTotal -= estimated;
      const left = (this.pending.get(key) ?? 0) - estimated;
      if (left > 1e-9) this.pending.set(key, left);
      else this.pending.delete(key);
      throw err;
    }

    let counted = false;
    try {
      await this.awaitResidency(spec, req.signal);
      this.liveModels.set(spec.model, (this.liveModels.get(spec.model) ?? 0) + 1);
      counted = true;
      const result = await this.chatFn({
        alias: req.alias,
        messages: req.messages,
        sensitivity: req.sensitivity,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        json: req.json,
        signal: req.signal,
        keepAlive: req.keepAlive ?? keepAliveFor(req.alias),
        numCtx: req.numCtx,
        seed: req.seed,
      });
      this.store.addReceipt({
        taskId: req.taskId,
        runId: req.runId,
        kind: req.kind,
        provider: spec.provider,
        model: spec.model,
        local: spec.local,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
        reservedUsd: estimated,
        latencyMs: result.latencyMs,
        downshiftedFrom: downshiftedFrom ?? null,
      });
      return result;
    } catch (err) {
      this.store.addReceipt({
        taskId: req.taskId, runId: req.runId, kind: `${req.kind}:error`,
        provider: spec.provider, model: spec.model, local: spec.local, reservedUsd: estimated,
        downshiftedFrom: downshiftedFrom ?? null,
      });
      throw err;
    } finally {
      if (counted) this.releaseModel(spec.model);
      else while (this.drainWaiters.length) this.drainWaiters.shift()?.();
      this.release(spec.provider);
      this.pendingTotal -= estimated;
      const left = (this.pending.get(key) ?? 0) - estimated;
      if (left > 1e-9) this.pending.set(key, left);
      else this.pending.delete(key);
    }
  }
}

/** Which models Ollama currently has resident. */
export async function loadedOllamaModels(): Promise<Set<string>> {
  const base = process.env['FOREMAN_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
  const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`ollama ps: ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
  return new Set((body.models ?? []).flatMap((m) => [m.name, m.model].filter((n): n is string => Boolean(n))));
}

/** Keep the benched roster warm; let everything else fall out of memory. */
export function keepAliveFor(alias: string): string | undefined {
  const roster = readBench()?.roster;
  if (!roster) return undefined;
  const warm = new Set(Object.values(roster));
  return warm.has(alias)
    ? (process.env['FOREMAN_OLLAMA_KEEP_ALIVE'] ?? '30m')
    : (process.env['FOREMAN_OLLAMA_KEEP_ALIVE_COLD'] ?? '5m');
}
