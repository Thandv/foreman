import type { Store } from '../queue.ts';
import type { Sensitivity, Task } from '../types.ts';
import { RETRO_PREFIX, terms } from './memory.ts';

export interface RetroTicket {
  title: string;
  role: string;
  points: number;
  repairs: number;
  status: string;
}

/**
 * What one closed epic taught, composed from DB facts only — no model call, no
 * tokens. It is written once when the epic closes and read back as few-shot
 * precedent by the next decompose of the same playbook.
 */
export interface Retrospective {
  ask: string;
  playbook: string;
  /**
   * The epic's own sensitivity, stored because a retrospective is read back as
   * *prompt input to a hosted model*. Without it, precedent ranking cannot tell
   * which stored lessons are safe to ship out.
   */
  sensitivity: Sensitivity;
  tickets: RetroTicket[];
  /** Total repair rounds across the epic — the cost of getting it right. */
  reviewRounds: number;
  /** Playbook checks that actually failed a ticket; the ones worth keeping. */
  checksThatCaught: string[];
  /** Error strings of the tickets that did not land. */
  pitfalls: string[];
}

/** Hard cap on the stored value; memory is a prompt input, not an archive. */
const MAX_BYTES = 1024;
const CHECK_RE = /playbook check failed \(([^)]{1,120})\)/g;

export const retroKey = (epicId: string): string => `${RETRO_PREFIX}${epicId}`;

/** Deterministic composition: every field is read straight off the epic's rows. */
export function composeRetrospective(store: Store, epic: Task): Retrospective | null {
  if (!epic.isEpic || !epic.playbook) return null;
  const children = store.childrenOf(epic.id);
  if (!children.length) return null;

  const checks = new Set<string>();
  const pitfalls: string[] = [];
  for (const child of children) {
    for (const verdict of store.verdictsForTask(child.id)) {
      for (const m of (verdict.critique ?? '').matchAll(CHECK_RE)) checks.add(m[1]!);
    }
    if (child.status !== 'done' && child.error) pitfalls.push(`${child.title}: ${child.error.slice(0, 160)}`);
  }

  const retro: Retrospective = {
    ask: epic.prompt.slice(0, 400),
    playbook: epic.playbook,
    sensitivity: epic.sensitivity,
    tickets: children.map((c) => ({
      title: c.title.slice(0, 120),
      role: c.role ?? '',
      points: c.points ?? 0,
      repairs: c.repairs,
      status: c.status,
    })),
    reviewRounds: children.reduce((n, c) => n + c.repairs, 0),
    checksThatCaught: [...checks].slice(0, 5),
    pitfalls: pitfalls.slice(0, 3),
  };

  // Shed the least load-bearing detail first (pitfalls, then ticket tail) so a
  // wide epic still stores its shape rather than being dropped for being long.
  while (JSON.stringify(retro).length > MAX_BYTES) {
    if (retro.pitfalls.length) retro.pitfalls.pop();
    else if (retro.checksThatCaught.length) retro.checksThatCaught.pop();
    else if (retro.tickets.length > 1) retro.tickets.pop();
    else {
      retro.ask = retro.ask.slice(0, Math.max(40, retro.ask.length - 200));
      if (JSON.stringify(retro).length > MAX_BYTES) return null; // unstorable; skip rather than truncate into garbage
    }
  }
  return retro;
}

/**
 * Write-back on epic close. Scope is the playbook id (not a repo), because the
 * lesson is "this is how epics of this shape go", reusable across workspaces.
 *
 * S2 epics are never written: a retrospective is composed from their titles and
 * error strings, and precedent is fed straight to the hosted Owner CLI, so
 * storing one would leak local-only work into a later plan.
 */
export function writeRetrospective(store: Store, epicId: string): boolean {
  const epic = store.getTask(epicId);
  if (!epic) return false;
  if (epic.sensitivity === 'S2') return false;
  const retro = composeRetrospective(store, epic);
  if (!retro) return false;
  store.rememberFact({
    scope: retro.playbook,
    key: retroKey(epicId),
    value: JSON.stringify(retro),
    confidence: 0.6,
    source: epicId,
  });
  return true;
}

/**
 * Retire the live retrospective of an epic that left its terminal state. Its
 * ticket statuses and pitfalls describe a close that has been undone, and
 * precedent must never serve a lesson from an epic still in flight; the next
 * close writes a fresh one, which `rememberFact` supersedes into place.
 */
export function dropRetrospective(store: Store, epicId: string): boolean {
  const epic = store.getTask(epicId);
  if (!epic?.playbook) return false;
  const key = retroKey(epicId);
  const fact = store.recallFacts(epic.playbook, 500).find((f) => f.scope === epic.playbook && f.key === key);
  if (!fact) return false;
  store.forgetFact(fact.id);
  return true;
}

export interface Precedent {
  epicId: string;
  retro: Retrospective;
  score: number;
}

/**
 * Keyword-overlap ranking over stored retrospectives for one playbook. Free
 * and offline: matching precedent is what lets the Owner plan from a known
 * shape instead of from scratch.
 *
 * Residual injection surface, accepted knowingly: a retrospective's `pitfalls`
 * and `checksThatCaught` are error strings, and an error string can be steered
 * by whatever the ticket touched (a repo file, a fetched page, a tool's stderr).
 * That text is quoted into the next decompose prompt, so an attacker who can
 * shape one failure message gets a *semantic* nudge over how the next epic of
 * the same playbook is planned. It cannot execute anything: the bound is the
 * 1KB retro cap, the ≤2 precedents injected, full revalidation of every field
 * of the reply (roles remapped, testCmds re-scanned by admission, ticket count
 * capped), and a human confirming the plan before a ticket is queued. Note
 * `foreman build --auto` skips that human, so on --auto the revalidation is the
 * only thing between a poisoned precedent and queued work.
 */
export function precedentsFor(store: Store, playbookId: string, ask: string, limit = 2): Precedent[] {
  const wanted = new Set(terms(ask));
  const out: Precedent[] = [];
  for (const fact of store.recallFacts(playbookId, 200)) {
    if (!fact.key.startsWith(RETRO_PREFIX)) continue;
    let retro: Retrospective;
    try {
      retro = JSON.parse(fact.value) as Retrospective;
    } catch {
      continue; // a fact that is not a retrospective is simply not precedent
    }
    if (retro?.playbook !== playbookId || !Array.isArray(retro.tickets)) continue;
    // Precedent is shipped to the hosted Owner: only a retro that can *prove*
    // it is not S2 qualifies. A missing field predates the guard and cannot.
    if (retro.sensitivity !== 'S0' && retro.sensitivity !== 'S1') continue;
    const hay = new Set(terms(`${retro.ask} ${retro.tickets.map((t) => t.title).join(' ')}`));
    let overlap = 0;
    for (const term of wanted) if (hay.has(term)) overlap++;
    out.push({ epicId: fact.key.slice(RETRO_PREFIX.length), retro, score: overlap });
  }
  return out
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}
