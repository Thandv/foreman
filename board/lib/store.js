/**
 * store.js — one EventSource and one /api/state snapshot for the whole app.
 *
 * This used to live inside the board view, which meant the stream existed only
 * while the kanban was on screen and a second view would have opened a second
 * connection. It is a module singleton now: the shell starts it once, views
 * subscribe on mount and unsubscribe on route change, and the daemon sees
 * exactly one client per tab no matter how much navigating happens.
 *
 *   const off = store.subscribe((state) => render(state));   // snapshots
 *   const off2 = store.onEvent((ev) => appendLogLine(ev));    // raw SSE rows
 *   const off3 = store.onConnection((status) => paintDot(status));
 *   off(); off2(); off3();
 *
 * Reconnection is manual rather than EventSource's own retry: the browser
 * would reopen the *same* URL, replaying `?since=` from whatever the id was
 * when the page loaded. Reopening by hand lets each attempt carry the id we
 * actually reached, so a reconnect resumes instead of re-streaming.
 */
import { api } from './dom.js';

const REFRESH_DEBOUNCE_MS = 350;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

const EMPTY = {
  tasks: [],
  stats: {},
  stages: [],
  workers: { max: 0, active: 0, verifying: 0, verifyLane: 0 },
  budget: { spentToday: 0, dailyCapUsd: 0, callsToday: 0, nonLocalCallsToday: 0 },
  roster: null,
  lastEventId: 0,
};

class Store {
  constructor() {
    this.state = EMPTY;
    /** 'connecting' | 'live' | 'reconnecting' | 'down' */
    this.connection = 'connecting';
    this.lastEventId = 0;
    this.error = null;

    this._snapshotSubs = new Set();
    this._eventSubs = new Set();
    this._connSubs = new Set();
    this._source = null;
    this._backoff = BACKOFF_MIN_MS;
    this._refreshQueued = false;
    this._started = false;
  }

  // --------------------------------------------------------- subscriptions

  subscribe(fn) {
    this._snapshotSubs.add(fn);
    // Late subscribers (a view mounted after boot) get the current snapshot
    // immediately rather than waiting for the next event to arrive.
    if (this.state !== EMPTY) fn(this.state);
    return () => this._snapshotSubs.delete(fn);
  }

  onEvent(fn) {
    this._eventSubs.add(fn);
    return () => this._eventSubs.delete(fn);
  }

  onConnection(fn) {
    this._connSubs.add(fn);
    fn(this.connection);
    return () => this._connSubs.delete(fn);
  }

  // ---------------------------------------------------------------- state

  async refresh() {
    try {
      const next = await api('/api/state');
      this.state = next;
      this.error = null;
      this.lastEventId = Math.max(this.lastEventId, next.lastEventId ?? 0);
      for (const fn of this._snapshotSubs) fn(next);
    } catch (err) {
      this.error = err.message;
    }
    return this.state;
  }

  /** Coalesce the burst of events a single task transition produces. */
  scheduleRefresh() {
    if (this._refreshQueued) return;
    this._refreshQueued = true;
    setTimeout(() => {
      this._refreshQueued = false;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Re-emit the current snapshot without hitting the network (tick redraws). */
  emit() {
    for (const fn of this._snapshotSubs) fn(this.state);
  }

  // ----------------------------------------------------------- connection

  _setConnection(status) {
    if (this.connection === status) return;
    this.connection = status;
    for (const fn of this._connSubs) fn(status);
  }

  async start() {
    if (this._started) return;
    this._started = true;
    await this.refresh();
    this._connect();
    // Page hidden for a while → the socket is usually dead and the snapshot
    // stale. Re-check on the way back rather than waiting for a live event.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.scheduleRefresh();
    });
  }

  _connect() {
    this._source?.close();
    const src = new EventSource(`/api/events?since=${this.lastEventId}`);
    this._source = src;

    src.onopen = () => {
      this._backoff = BACKOFF_MIN_MS;
      this._setConnection('live');
    };

    src.onmessage = (msg) => {
      let ev;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        return; // a heartbeat or a truncated frame is not a fatal error
      }
      this.lastEventId = Math.max(this.lastEventId, ev.id ?? 0);
      for (const fn of this._eventSubs) fn(ev);
      this.scheduleRefresh();
    };

    src.onerror = () => {
      // EventSource would retry this URL itself, with the stale `since` baked
      // in; close it and own the retry so the next attempt resumes correctly.
      src.close();
      this._setConnection('reconnecting');
      setTimeout(() => this._connect(), this._backoff);
      this._backoff = Math.min(BACKOFF_MAX_MS, this._backoff * 2);
    };
  }
}

export const store = new Store();

// --------------------------------------------------------------- selectors
// Small derived reads shared by the topbar, the palette and the views, so no
// two of them can disagree about what "awaiting approval" or "over cap" means.

export const tasksAwaitingApproval = (state) =>
  state.tasks.filter((t) => t.status === 'awaiting-approval');

export const activeTasks = (state) =>
  state.tasks.filter((t) => ['running', 'verifying'].includes(t.status));

/** null when no cap is configured — the topbar shows spend without a ratio. */
export function budgetRatio(budget) {
  if (!budget?.dailyCapUsd) return null;
  return budget.spentToday / budget.dailyCapUsd;
}

// ------------------------------------------------------------- gate results
//
// POST /api/tasks/:id/approve answers 200 with `{ ...task, merge, registration }`
// (server.ts → gate.ts applyApproval). Approving and *landing* are two different
// outcomes: mergeApproved() aborts a conflicting merge and returns
// `{ merged: false, reason: 'merge conflict, aborted — resolve <branch> by
// hand: …', branch }` on the same 200. A tool task lands by registration
// instead, and `{ registered: false, reason }` comes back the same way.
//
// Reporting either of those as a bare "Approved" is how an un-landed branch
// goes unnoticed until someone wonders why main never moved, so the message
// the operator reads is derived here — once — for the drawer and the palette.

/** Merge outcomes that are a deliberate skip, not a failure to shout about. */
const BENIGN_MERGE = /^(nothing to merge|merge-on-approve disabled|branch has no commits ahead|closed: nothing to change|task is )/;
/** Same, for the tool registry: a code task is simply not a tool task. */
const BENIGN_REGISTRATION = /^not a tool task/;

/** Collapse git's multi-line stderr into something a toast can hold. */
function oneLine(reason, max = 200) {
  const flat = String(reason ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Whether a verdict's chairSummary is a chair's actual ruling, or a status line
 * the council wrote in the same field: a lone reachable advisor, a seat that
 * answered nothing usable, a chair that was unreachable, answered off-contract
 * or had argued a side. Showing those as a ruling tells the operator a decision
 * was made when none was. A council chair rules only on a disagreement, and
 * only a pass/fail is a ruling (council.ts); a crew row's chairSummary is only
 * ever written by a chair (crewReview.ts). Mirrors src/types.ts
 * chairRuled — test/board.test.ts holds the two equal.
 */
export function chairRuled(v) {
  if (!v?.chairSummary) return false;
  if (v.source === 'crew') return true;
  return Boolean(v.disagreement) && (v.verdict === 'pass' || v.verdict === 'fail');
}

/** The verdict header's tail: "reviewers split" is a fact; "chair decided" only when one did. */
export function splitNote(v) {
  if (!v?.disagreement) return '';
  return chairRuled(v) ? ' — reviewers split, chair decided' : ' — reviewers split, no ruling';
}

/**
 * A crew review that reached a verdict it may not give as a pass: the reviewer could not verify an acceptance item,
 * gave it no status, or listed it as not met while a chair passed the work (crewReview.ts heldReason writes the park
 * note this reads). Recorded as `split`, but nobody failed to answer: asking the same reviewer again replays the
 * same reply, so the card must not say "press Re-review". A person reads the note and decides.
 */
export function heldByReviewer(task, run) {
  return run?.verdict === 'split'
    && /\bthe reviewer (?:says|could not verify|gave no status for) acceptance items? \d/.test(task?.error ?? '');
}

/** The heading over a verdict's chairSummary block. */
export function summaryHeading(v) {
  if (!chairRuled(v)) return 'council note';
  return v.chairModel ? `chair ruling (${v.chairModel})` : 'chair ruling';
}

/**
 * What a Re-review did. The endpoint answers 202 at once and the review runs in
 * the daemon — a chapter takes minutes, and a climb writes one verdict row per
 * rung — so this polls the task until the daemon says the re-review is over,
 * then reports the newest verdict if one was written. An older daemon never
 * says (no `reverifying` field), so the wait is bounded either way.
 */
export async function awaitReview(taskId, started, opts = {}) {
  const fetchTask = opts.fetchTask ?? ((id) => api(`/api/tasks/${id}`));
  const wait = opts.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const every = opts.every ?? 3_000;
  const attempts = opts.attempts ?? 300;
  const before = started?.verdictsBefore ?? 0;
  let misses = 0;
  for (let i = 0; i < attempts; i++) {
    await wait(every);
    let d;
    try {
      d = await fetchTask(taskId);
      misses = 0;
    } catch (err) {
      // One failed poll (a daemon restart, a blip) is not the re-review failing.
      if (++misses >= 5) return { ok: false, message: `Lost touch with the daemon while it re-reviewed: ${err?.message ?? err}` };
      continue;
    }
    if (d?.reverifying) continue;
    if ((d?.verdicts?.length ?? 0) > before) {
      return { ok: true, message: `Re-reviewed: ${d.verdicts[0]?.verdict ?? 'no verdict'}` };
    }
    if (d?.reverifying === false) {
      return { ok: false, message: 'Re-review finished without a new verdict — see the timeline' };
    }
  }
  return { ok: true, message: 'Re-review is still running — the verdict will show here when it lands' };
}

/**
 * What actually happened when a gate decision was applied.
 *
 *   const { ok, message } = approvalOutcome(response, 'Approved "Fix login"');
 *   (ok ? toast.ok : toast.err)(message);
 *
 * `ok: false` means the decision stuck but the landing did not — the operator
 * has a branch to resolve by hand and has to be told so.
 */
export function approvalOutcome(result, label = 'Approved') {
  const merge = result?.merge;
  const registration = result?.registration;

  if (merge?.branch) {
    if (merge.merged) return { ok: true, message: `${label} — merged ${merge.branch}` };
    const reason = oneLine(merge.reason) || 'the branch did not land';
    if (!BENIGN_MERGE.test(reason)) {
      return { ok: false, message: `${label}, but ${merge.branch} did not land: ${reason}` };
    }
    return { ok: true, message: `${label} — ${reason}` };
  }

  if (registration && !registration.registered && !BENIGN_REGISTRATION.test(String(registration.reason ?? ''))) {
    return { ok: false, message: `${label}, but the tool was not registered: ${oneLine(registration.reason)}` };
  }
  if (registration?.registered) return { ok: true, message: `${label} — ${oneLine(registration.reason)}` };

  return { ok: true, message: label };
}

/**
 * Reject answers with the bare task and never merges, so this is only ever the
 * label — but it goes through the same shape as approvalOutcome() so the two
 * handlers stay symmetrical and neither can drift into assuming a response
 * field the other one does not have.
 */
export function rejectionOutcome(result, label = 'Rejected') {
  return { ok: true, message: result?.status === 'rejected' || !result ? label : `${label} (task is ${result.status})` };
}
