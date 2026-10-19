import { getPlaybook, type PlaybookCatalog } from './playbooks.ts';
import type { Assignee, Task } from './types.ts';

/**
 * Who does the WORK — as opposed to `gate.ts:effectiveGate`, which only decides
 * who signs it off. The two are orthogonal on purpose: an AI-worked ticket
 * normally still parks at a human gate, and a human-worked ticket still gets a
 * decision recorded against it.
 *
 * Resolution order, most specific first:
 *
 *   1. the task's own `assignee` (set by `--assignee`, or `foreman assign`)
 *   2. the playbook role's `assignee`
 *   3. the playbook's `assignee` default
 *   4. `FOREMAN_ASSIGNEE`
 *   5. `'ai'`
 *
 * Default is `ai` because that is what Foreman is for: unattended parallel
 * work. `human` exists for the tickets a model must not take — the ones the
 * degradation contract refuses (the local-only policy), and the ones the
 * operator simply wants to do themselves.
 */
export function effectiveAssignee(
  task: Pick<Task, 'assignee' | 'role' | 'playbook'>,
  catalog?: PlaybookCatalog,
  /**
   * The board's toggle, or null when it has never been flipped. It sits BELOW
   * the playbook on purpose: a playbook that claims a role for the operator is
   * a standing decision about that kind of work, and a global switch must not
   * silently override it.
   */
  houseDefault?: Assignee | null,
): Assignee {
  if (task.assignee === 'ai' || task.assignee === 'human') return task.assignee;
  if (task.playbook) {
    const pb = catalog
      ? catalog.playbooks.find((p) => p.id === task.playbook) ?? null
      : getPlaybook(task.playbook);
    if (pb) {
      const roleAssignee = task.role ? pb.roles[task.role]?.assignee : undefined;
      if (roleAssignee) return roleAssignee;
      if (pb.assignee) return pb.assignee;
    }
  }
  return houseDefault ?? envAssignee() ?? 'ai';
}

/**
 * Read lazily, never captured at module load, so a test or an operator can flip
 * it per case — the same contract `tierModel` and `effectiveGate` keep.
 * An unrecognised value is ignored rather than thrown: the daemon must not
 * refuse to boot over a typo in an optional knob, and `ai` is the safe default
 * in the sense that matters here (work keeps moving).
 */
export function envAssignee(): Assignee | null {
  const raw = (process.env['FOREMAN_ASSIGNEE'] ?? '').trim().toLowerCase();
  return raw === 'human' || raw === 'ai' ? raw : null;
}

/** The status a task should be born into (or promoted to) given its assignee. */
export function readyStatus(assignee: Assignee): 'queued' | 'awaiting-human' {
  return assignee === 'human' ? 'awaiting-human' : 'queued';
}
