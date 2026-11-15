/**
 * Four-eyes (D3): who may approve or land a ticket once auth is on (tokenAuth.ts).
 *
 * With auth off nothing changes. With auth on, only a live human principal can satisfy the rule: the owner model and
 * a service principal never do. Once more than one live human exists, the approver must not be the person who
 * created the ticket, and a ticket whose creator is unknown or not a person (a service principal, or a reserved actor
 * such as 'operator', which every ticket from before sign-in records) is refused: a person who can use a service token
 * could otherwise create as the service and approve as themselves. A change to protected paths always needs
 * that second person, even while only one human exists. The live-human count is whatever the host-admin secret has
 * minted (mint.ts), so a holder of that secret can mint a second name for themselves; mints are events.
 */
import type { Store } from '../queue.ts';
import type { Principal, PrincipalKind, Task } from '../types.ts';
import { authIsOn } from './tokenAuth.ts';

/**
 * The rule itself: null when `approver` may approve or land `task`, or why not. `approver` is the live principal
 * approving (null when the id names none: a reserved actor such as the owner model, or a disabled principal);
 * `protectedHit` is the protected path the change touches, or null; `humans` is the live human count; `creatorKind` is
 * the kind of the principal the ticket's creator id names, enabled or not (null: no principal, such as a reserved actor).
 */
export function fourEyes(
  approver: Principal | null,
  task: Pick<Task, 'createdBy'>,
  protectedHit: string | null,
  humans: number,
  creatorKind: PrincipalKind | null,
): string | null {
  if (approver?.kind !== 'human') return 'only a signed-in person can approve or land work, and this approver is not one';
  if (humans > 1) {
    if (task.createdBy === null) return 'the author of this ticket is unknown, so a second person cannot be shown to approve it';
    if (task.createdBy === approver.id) return `${approver.name} created this ticket, so another person must approve or land it`;
    if (creatorKind !== 'human') return `this ticket was created by ${task.createdBy}, which is not a person, so a second person cannot be shown to approve it`;
    return null;
  }
  if (protectedHit !== null) {
    return `the change touches ${protectedHit}, which a second person must approve; mint a principal for a second person`;
  }
  return null;
}

/**
 * The rule as the ledger stands now: null with auth off; otherwise the approver's liveness and the live-human count
 * are read afresh, so an approver disabled since the request is refused. `protectedHit` is only asked with auth on.
 */
export async function recheck(
  store: Store,
  task: Pick<Task, 'createdBy'>,
  approverId: string,
  protectedHit: () => Promise<string | null>,
): Promise<string | null> {
  if (!authIsOn(store)) return null;
  const hit = await protectedHit();
  const creatorKind = task.createdBy === null ? null : store.principalKind(task.createdBy);
  return fourEyes(store.livePrincipal(approverId), task, hit, store.humanPrincipalCount(), creatorKind);
}
