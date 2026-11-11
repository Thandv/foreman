// Where one pipeline-bench ticket stands. Apart from pipeline.ts, which runs the bench when it is loaded, so a test can import it.
import type { Store } from '../../src/queue.ts';
import type { Decision } from '../../src/types.ts';

/**
 * The ticket's approval that merged, if any. The gate logs 'approved' whether or not the merge happened (merge
 * disabled, a conflict, nothing ahead, the core guard refused); the decision row records which.
 */
export function mergedApproval(store: Store, id: string): Decision | undefined {
  return store.decisionsForTask(id).find((d) => d.action === 'approve' && d.merged === true);
}

/**
 * 'landed' once the owner gate has approved the ticket, the approval merged and its landing has settled; 'not-landed' once it ended any
 * other way; 'pending' until then. A done ticket stays pending until the gate has logged its verdict: the post-merge
 * check can end the landing hold before the approval has written its decision row and the gate its verdict (both
 * wait on git after the merge), and a ticket counted in that window is one that lands.
 */
export function outcome(store: Store, id: string): 'pending' | 'landed' | 'not-landed' {
  const status = store.getTask(id)!.status;
  if (status === 'failed' || status === 'rejected' || status === 'canceled') return 'not-landed';
  if (status !== 'done') return 'pending';
  const gate = store.gateDecision(id);
  if (store.isLanding(id) || gate === null) return 'pending';
  return gate.startsWith('approved@') && mergedApproval(store, id) ? 'landed' : 'not-landed';
}

/**
 * Why a ticket did not land: its status, the owner gate's marker and its last events. Each event keeps the end of its
 * message, where a failed command's error is: a git command's message starts with the long pinned `-c` list.
 */
export function whyNotLanded(store: Store, id: string): { id: string; status: string; gate: string | null; events: string[] } {
  return {
    id,
    status: store.getTask(id)!.status,
    gate: store.gateDecision(id),
    events: store.eventsForTask(id).slice(-5).map((e) => `${e.type}: ${e.message.slice(-300)}`),
  };
}

/** `n` counted events per landed ticket, to two places; 0 when nothing landed. */
export const perLanded = (n: number, landed: number): number => (landed ? Math.round((n / landed) * 100) / 100 : 0);

/** One run of a bench's fake suite: when it ended, and which ticket files its checkout held. */
export interface SuiteRun { endedAt: number; files: string[] }

/** The fake suite's log: one `<epoch ms> <file>,<file>…` line per run, written as the run ends. */
export function parseSuiteLog(text: string): SuiteRun[] {
  return text.split('\n').filter((l) => l !== '').map((l) => {
    const [at = '', files = ''] = l.split(' ');
    return { endedAt: Number(at), files: files.split(',').filter((f) => f !== '') };
  });
}

/**
 * How many runs were the own checks of tickets that wrote `unlanded` and never merged: a ticket's own check holds only
 * its file. A post-merge checkout that holds such a file anyway is a post-merge check and is not counted.
 */
export function ownChecksOf(runs: SuiteRun[], unlanded: string[]): number {
  return runs.filter((r) => r.files.length === 1 && unlanded.includes(r.files[0]!)).length;
}

/** How a red reads against the bad last ticket; a culprit that never merged cannot be named. */
export function redReading(red: { culpritLanded: boolean; named: string[]; attributed: boolean }): string {
  if (!red.culpritLanded) return 'culprit not landed';
  return `${red.attributed ? 'culprit' : 'NOT the culprit'} among ${red.named.length}`;
}

/**
 * How long after `mergedAt` a post-merge check first covered the ticket that wrote `file`: the first suite run to end
 * at or after the merge in a checkout that held the file. A ticket's own check holds the file too, but ends before the
 * merge. Undefined while no check has covered it.
 */
export function mergedToVerifiedMs(runs: SuiteRun[], file: string, mergedAt: number): number | undefined {
  const ends = runs.filter((r) => r.endedAt >= mergedAt && r.files.includes(file)).map((r) => r.endedAt);
  return ends.length ? Math.min(...ends) - mergedAt : undefined;
}

/** The task ids a red-main event names ("MAIN IS RED after merging a, b (cmd): …", src/landing/verify.ts), over `messages`. */
export function namedInRed(messages: string[]): string[] {
  return messages.flatMap((m) => /^MAIN IS RED after merging ([^(:]+)/.exec(m)?.[1]?.split(', ').map((id) => id.trim()) ?? []);
}
