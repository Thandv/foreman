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
