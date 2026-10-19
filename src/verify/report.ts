import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import type { Store } from '../queue.ts';
import type { Run } from '../types.ts';

/**
 * The worker's final report on its way to a reviewer.
 *
 * The run row keeps a 4000-character copy with its middle cut out
 * (runners/cliRunners.ts boundSummary), and that copy was what a reviewer got,
 * cut again to its last 3000: on the Kiln trial a technical writer's claims
 * table reached the reviewer starting mid-row with a 9434-character hole, and
 * a follow-up another report gave in full existed only in the session
 * transcript. So the whole report is stored once, as a run artifact, and what
 * a reviewer reads is bounded here, by one budget, keeping whole lines of the
 * head (DONE / CHANGED) and of the tail (the acceptance map) and saying how
 * much is gone and where the rest is.
 */

/** The largest report kept as an artifact. Past it the middle is cut, and the file says so. */
export const REPORT_ARTIFACT_MAX = 256 * 1024;

/** Share of a cut report's budget that goes to its end, where the acceptance map is. */
const TAIL_SHARE = 2 / 3;

/**
 * `text` in at most `budget` characters: whole lines from its start, a marker,
 * whole lines from its end. Never a line cut in two — a line too long for its
 * share is dropped and counted. `marker` is given the number of characters
 * dropped and is paid for out of the budget.
 */
export function cutMiddle(text: string, budget: number, marker: (dropped: number) => string): string {
  if (text.length <= budget) return text;
  const room = Math.max(0, budget - marker(text.length).length - 2);
  const tailRoom = Math.floor(room * TAIL_SHARE);
  const headRoom = room - tailRoom;
  // The last line break at or before the head's share; the first at or after the start of the tail's.
  const headEnd = text.lastIndexOf('\n', headRoom - 1) + 1;
  const from = text.length - tailRoom;
  const nl = text.indexOf('\n', Math.max(from - 1, headEnd - 1));
  const tailStart = nl < 0 ? text.length : nl + 1;
  const head = text.slice(0, headEnd);
  const tail = tailStart > headEnd ? text.slice(tailStart) : '';
  return `${head}${marker(text.length - head.length - tail.length)}\n${tail}`;
}

/**
 * Write a run's whole report under the artifact root and record it as the
 * run's `report` artifact. Returns the path, or null when there was no report
 * or it could not be written (the review then says nothing about a file).
 */
export function storeReport(store: Store, runId: string, taskId: string, report: string | null | undefined): string | null {
  const text = report?.trim();
  if (!text) return null;
  const kept = cutMiddle(text, REPORT_ARTIFACT_MAX, (dropped) =>
    `[FOREMAN cut ${dropped} characters from the middle of this report here: it was over the ${REPORT_ARTIFACT_MAX}-character limit for a stored report, and the cut part was not kept]`);
  const file = path.join(config.artifactRoot, `${runId}.report.md`);
  try {
    fs.mkdirSync(config.artifactRoot, { recursive: true });
    fs.writeFileSync(file, `${kept}\n`);
  } catch {
    return null;
  }
  store.addArtifact({
    runId, taskId, type: 'report', path: file,
    summary: kept === text ? `the worker's final report, whole (${text.length} characters)` : `the worker's final report (${text.length} characters, cut to ${kept.length})`,
  });
  return file;
}

/** What a re-review reads back: this run's stored report, or the bounded copy on the run row when there is none. */
export function storedReport(store: Store, run: Run): { text: string | null; path: string | null } {
  const artifact = store.artifactsForTask(run.taskId).filter((a) => a.type === 'report' && a.runId === run.id).at(-1);
  if (artifact) {
    try {
      // Foreman's own file, under its own home: read whole, but never more than it would have written.
      const st = fs.lstatSync(artifact.path);
      if (st.isFile() && st.size <= 4 * REPORT_ARTIFACT_MAX + 1024) return { text: fs.readFileSync(artifact.path, 'utf8').trimEnd(), path: artifact.path };
    } catch {
      /* the file is gone: the run row's copy is what is left */
    }
  }
  return { text: run.summary ?? null, path: null };
}

/** The worker's report as one reviewer prompt carries it: whole under the budget, else head and tail with the cut marked. */
export function boundReport(report: string, artifactPath: string | null = null, budget: number = config.reviewReportBytes): string {
  return cutMiddle(report, budget, (dropped) =>
    `[FOREMAN cut ${dropped} characters from the middle of this report here to fit its ${budget}-character budget ` +
    `(FOREMAN_REVIEW_REPORT_BYTES). The worker wrote them; they are NOT shown to you. ` +
    (artifactPath ? `The full report is at ${artifactPath}. ` : '') +
    'Anything you needed from the cut part is "not shown": an acceptance item that depends on it is not verifiable, not met.]');
}
