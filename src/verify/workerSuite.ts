/**
 * What the worker's own in-jail suite run left behind, read by the daemon at collection.
 *
 * ADVISORY. The saved output is written by worker-side code (testSlot.ts) in a directory the worker can write, and
 * "changed after" is a file-mtime comparison: a worker can forge either. The line tells a reviewer what the worker
 * did; it never holds, fails or approves anything. The gate's own test stage is the one that counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.ts';
import { OUTPUT_DIR_NAME, resultFileFor, savedOutputs } from './suiteOutput.ts';
import type { Store } from '../queue.ts';
import type { Run } from '../types.ts';

export interface WorkerSuiteResult {
  version: 1;
  /** `none`: no saved output. `unreadable`: the directory or the log could not be read. */
  status: 'PASSED' | 'FAILED' | 'unknown' | 'none' | 'unreadable';
  /** ms since epoch of the last run's log (its last write). */
  at: number | null;
  log: string | null;
  changedAfter: boolean;
  /** The one gate-note line. */
  line: string;
  error?: string;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const WALK_MAX = 50_000;

/**
 * Newest mtime of any file or directory in the jail (not .git, not node_modules), or 0. Directories count because a
 * file deleted or renamed changes only its directory's mtime. Bounded; a single unreadable entry is skipped.
 */
export function newestJailMtime(dir: string): number {
  const mtime = (p: string): number => {
    try {
      return fs.lstatSync(p).mtimeMs;
    } catch {
      return 0; /* gone */
    }
  };
  let newest = mtime(dir);
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < WALK_MAX) {
    const d = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (++seen > WALK_MAX) break;
      const p = path.join(d, e.name);
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        stack.push(p);
        newest = Math.max(newest, mtime(p));
      } else if (e.isFile()) {
        newest = Math.max(newest, mtime(p));
      }
    }
  }
  return newest;
}

/**
 * The saved-output folder if it already exists, never creating it (suiteOutput.outputDir makes the folder, which
 * would leave one behind in the temp dir of a daemon that never saw a worker suite). Same candidates, same order.
 */
export function existingOutputDir(): string | null {
  for (const base of [os.tmpdir(), '/tmp']) {
    try {
      const dir = path.join(fs.realpathSync(base), OUTPUT_DIR_NAME);
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * PASSED/FAILED from the wrapper's result file beside a saved log (`testSlot: <cmd> PASSED|FAILED`), or null when it
 * wrote none (a run cut short). Never from the log itself: that is the suite's own output, whatever it printed.
 */
export function outcomeOfLog(file: string): 'PASSED' | 'FAILED' | null {
  let text: string;
  try {
    text = fs.readFileSync(resultFileFor(file), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return /^testSlot: .* (PASSED|FAILED)\n?$/.exec(text.slice(0, 8192))?.[1] as 'PASSED' | 'FAILED' | undefined ?? null;
}

/** Never throws: a read error is a result with a visible line. */
export function readWorkerSuite(outDir: string | null, runId: string, jailDir: string | null): WorkerSuiteResult {
  // Under FOREMAN_WORKER_SUITE=targeted no run is the policy, not an omission; a run that did happen reads as below.
  const noRun = config.workerSuite === 'targeted' ? 'worker suite: not run (FOREMAN_WORKER_SUITE=targeted)' : 'the worker never ran the suite';
  const none: WorkerSuiteResult = { version: 1, status: 'none', at: null, log: null, changedAfter: false, line: noRun };
  try {
    if (!outDir) return none;
    try {
      fs.readdirSync(outDir); // savedOutputs hides a read error as "none"; look first
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return none;
      throw err;
    }
    const newest = savedOutputs(outDir, runId)[0];
    if (!newest) return none;
    const at = fs.statSync(newest).mtimeMs;
    const outcome = outcomeOfLog(newest);
    const changedAfter = !!jailDir && newestJailMtime(jailDir) > at;
    const when = new Date(at).toISOString();
    const base = outcome
      ? `worker suite: ${outcome} at ${when} (advisory, written by worker-side code)`
      : `worker suite: no result line in its last saved output, at ${when} (advisory, written by worker-side code)`;
    return {
      version: 1, status: outcome ?? 'unknown', at, log: newest, changedAfter,
      line: changedAfter ? `${base}; changed after the worker's suite` : base,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ...none, status: 'unreadable', error, line: `worker suite: could not read its saved output (${error.slice(0, 200)})` };
  }
}

/** Store the result: a JSON file and a `worker-suite` artifact whose summary is the line (in `foreman show` and /api/state). */
export function recordWorkerSuite(store: Store, root: string, runId: string, taskId: string, r: WorkerSuiteResult): void {
  const file = path.join(root, `${runId}.worker-suite.json`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  store.addArtifact({ runId, taskId, type: 'worker-suite', path: file, summary: r.line });
}

/** The line of a run whose result was recorded earlier (a re-review); null when there is none. */
export function storedWorkerSuiteNote(store: Store, run: Run | null): string | null {
  if (!run) return null;
  const row = store.artifactsForTask(run.taskId).filter((a) => a.type === 'worker-suite' && a.runId === run.id).at(-1);
  return row?.summary ?? null;
}
