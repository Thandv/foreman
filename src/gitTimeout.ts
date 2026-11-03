// The one time limit on every daemon-side git process. A git that wedges (a credential prompt, an NFS stall, a hook)
// would otherwise hang its caller forever and be orphaned; past the limit it is killed with SIGKILL and the caller
// rejects with an error naming the subcommand only.

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** FOREMAN_GIT_TIMEOUT_MS, read on each call; empty, non-numeric or non-positive keeps the default. */
export function gitTimeoutMs(): number {
  const raw = process.env['FOREMAN_GIT_TIMEOUT_MS']?.trim();
  if (!raw) return DEFAULT_GIT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GIT_TIMEOUT_MS;
}

/**
 * The options every git spawn carries (execFile, execFileSync and spawn all take them). `capMs` keeps a call's own
 * shorter limit: a synchronous lookup holds the event loop for as long as git runs.
 */
export function gitTimeoutOpts(capMs = Infinity): { timeout: number; killSignal: 'SIGKILL' } {
  return { timeout: Math.min(capMs, gitTimeoutMs()), killSignal: 'SIGKILL' };
}

/** The subcommand of a git argv: the first word that is not an option or the value of -c / -C. */
export function gitSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' || a === '-C') { i++; continue; }
    if (a.startsWith('-')) continue;
    return /^[a-z][a-z0-9-]*$/i.test(a) ? a : 'git';
  }
  return 'git';
}

/** Map an execFile failure: one that came from the time limit becomes an error naming the subcommand only. */
export function gitFailure(err: unknown, args: readonly string[]): unknown {
  const e = err as { killed?: boolean; signal?: unknown } | null;
  if (e && e.killed === true && e.signal === 'SIGKILL') {
    return new Error(`git ${gitSubcommand(args)} timed out after ${gitTimeoutMs()}ms`);
  }
  return err;
}

/** Await a promisified execFile of git, mapping a timeout to gitFailure's error. */
export async function timedGit<T>(run: Promise<T>, args: readonly string[]): Promise<T> {
  try {
    return await run;
  } catch (err) {
    throw gitFailure(err, args);
  }
}
