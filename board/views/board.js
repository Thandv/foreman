/**
 * views/board.js — the four-lane kanban, migrated off the old app.js.
 *
 * Behaviour is deliberately unchanged: the same lanes, the same in-lane epic
 * grouping, the same drawer with its five tabs, the same approve/reject/
 * cancel/retry/delete actions and the same playbook filter. What changed is
 * that it draws on the shared tokens, gets its data from the shared SSE store
 * instead of owning an EventSource, and that every control now carries a tip
 * saying what it does.
 */
import { $, add, api, clear, el, emptyState, fmtAgo, fmtDur, fmtTime, fmtUsd, post } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { approvalOutcome, awaitReview, heldByReviewer, rejectionOutcome, splitNote, store, summaryHeading } from '../lib/store.js';
import { tip } from '../lib/tooltip.js';
import { goTo } from '../lib/nav.js';
import { runAction, toast } from '../lib/toast.js';

export const meta = {
  id: 'board',
  title: 'Board',
  icon: 'board',
  desc: 'Every task in flight, lane by lane, with the gate at the end.',
};

const STAGES = ['admit', 'isolate', 'plan', 'work', 'test', 'verify', 'gate'];
const LANES = [
  {
    name: 'Queue', cls: 'l-queue', statuses: ['queued', 'blocked'],
    tip: 'Admitted and waiting for a free worker — or blocked until a dependency finishes.',
    empty: ['Nothing queued', 'Press ⌘K or New task to add work.'],
  },
  {
    name: 'Working', cls: 'l-work', statuses: ['running', 'verifying'],
    tip: 'Executing inside an isolated jail, or being checked by the review council.',
    empty: ['No workers busy', 'Queued tasks start as soon as a worker frees up.'],
  },
  {
    name: 'Yours to do', cls: 'l-human', statuses: ['awaiting-human'],
    tip: 'Assigned to you, not to a model. No worker will ever claim these — do the work, then close it.',
    empty: ['Nothing on your desk', 'Tasks assigned to you land here instead of the queue.'],
  },
  {
    name: 'Your call', cls: 'l-gate', statuses: ['awaiting-approval'],
    tip: 'Finished and staged. Nothing merges until you approve it here. A card marked NO VERDICT is ' +
      'not a decision waiting for you — the council failed to reach one, and it wants a re-review.',
    empty: ['Nothing to review', 'Finished runs land here for your decision.'],
  },
  {
    name: 'Closed', cls: 'l-closed', statuses: ['done', 'failed', 'rejected', 'canceled'],
    tip: 'Done, failed, rejected or canceled. Ended tasks can be retried or deleted.',
    empty: ['Nothing closed yet', '—'],
  },
];
const VERDICT_CHIP = { pass: 'ok', fail: 'bad', split: 'split' };
const CHIP = {
  running: 'run', verifying: 'run', 'awaiting-approval': 'gate', 'awaiting-human': 'human',
  done: 'ok', failed: 'bad', rejected: 'bad', canceled: 'bad',
};
const ENDED = ['done', 'failed', 'rejected', 'canceled'];

const TAB_TIPS = {
  log: ['Activity', 'Every stage change, status line and error this run emitted, streaming live.'],
  council: ['Council review', 'The verification verdicts: each reviewer’s critique and the chair’s ruling.'],
  artifacts: ['Artifacts', 'Diffs, logs and files the run produced. View one to read it inline.'],
  receipts: ['Receipts', 'Every model call billed to this task — tokens in and out, cost and latency.'],
  prompt: ['Prompt', 'The exact prompt the worker was handed. Nothing else was in its context.'],
};

// View-local UI state. Deliberately not persisted — same as the old board.
let playbookFilter = null;
let openTaskId = null;
let openTab = 'log';
// The snapshot's task.prompt is a truncated stub (server.ts:snapshot — the
// board polls /api/state on every SSE event, and a crew epic's full prompts
// would balloon that payload). The drawer's Prompt tab needs the real text,
// which only GET /api/tasks/:id carries; this caches it for the task
// currently open so the per-poll snapshot render (renderDrawerHeader, called
// on every store update while the drawer is open) doesn't stomp it back to
// the stub in between polls.
let drawerPromptFull = null;

// ------------------------------------------------------------------ pieces

function stageRail(stage, status, withLabels) {
  const rail = el('div', `rail${withLabels ? '' : ' compact'}`);
  const idx = STAGES.indexOf(stage);
  const ended = ENDED.includes(status);
  for (const [i, s] of STAGES.entries()) {
    const cls = i < idx || (ended && status === 'done') ? 'st done'
      : i === idx ? (ended ? 'st done' : 'st now') : 'st';
    const node = el('div', cls);
    node.appendChild(el('i'));
    node.appendChild(el('span', null, s));
    rail.appendChild(node);
  }
  return rail;
}

function card(task) {
  const run = task.run;
  const node = el('button', `tcard s-${task.status}${task.id === openTaskId ? ' on' : ''}`);
  node.type = 'button';
  node.dataset.id = task.id;
  tip(
    node,
    task.title,
    `${task.status} · ${task.runner}${task.playbook ? ` · ${task.playbook}` : ''} — open for activity, council review, artifacts and receipts.`,
  );

  const top = el('div', 'tcard-top');
  top.appendChild(el('span', 'ttl', task.title));
  const chips = el('div', 'chips');
  if (task.sensitivity === 'S2') chips.appendChild(el('span', 'chip s2', 'S2'));
  if (task.role) chips.appendChild(el('span', 'chip chip-role', task.role));
  if (task.model) chips.appendChild(el('span', 'chip chip-model', task.model));
  // "split" names the mechanism; "no verdict" names what it means for the
  // person reading the lane. A card that says `split` next to one that says
  // `pass` reads as two verdicts, when one of them is the absence of a verdict.
  if (run?.verdict) {
    const held = heldByReviewer(task, run);
    const label = held ? 'held for you' : run.verdict === 'split' ? 'no verdict' : run.verdict;
    const chip = el('span', `chip ${VERDICT_CHIP[run.verdict]}`, label);
    if (held) {
      tip(chip, 'The reviewer could not sign this off',
        'The review found nothing to fail, but an acceptance item was not verified, was given no status, or is ' +
        'listed as not met. The note on the card says which. Re-review would replay the same answer: read the ' +
        'item yourself, then approve or reject.');
    } else if (run.verdict === 'split') {
      tip(chip, 'No verdict reached',
        'The reviewers disagreed, a reviewer gave no usable answer, or none could be reached at all. This ' +
        'is not a judgement on the work — it is the review failing. Open the card to see which, then decide ' +
        'or press Re-review.');
    }
    chips.appendChild(chip);
  }
  if (task.provisional) {
    const chip = el('span', 'chip warn', 'provisional');
    tip(chip, 'Reviewed on smaller models',
      'The full council did not fit in memory, so this was reviewed on stepped-down models. Foreman ' +
      're-reviews it automatically with the full council once the machine frees up — the work is kept. ' +
      'Approving now signs off a lighter review; the owner model never auto-approves it.');
    chips.appendChild(chip);
  }
  chips.appendChild(el('span', `chip ${CHIP[task.status] ?? ''}`, task.status));
  top.appendChild(chips);
  node.appendChild(top);

  const meta_ = el('div', 'meta');
  meta_.appendChild(el('span', null, task.runner));
  meta_.appendChild(el('span', null, task.kind));
  if (task.playbook) meta_.appendChild(el('span', null, task.playbook));
  if (task.priority) meta_.appendChild(el('span', null, `p${task.priority}`));
  if (task.deps.length) meta_.appendChild(el('span', null, `⛓ ${task.deps.length}`));
  if (run?.costUsd > 0) meta_.appendChild(el('span', null, fmtUsd(run.costUsd)));
  if (run?.tokensOut > 0) meta_.appendChild(el('span', null, `${run.tokensOut} out`));
  meta_.appendChild(el('span', null, run?.startedAt ? fmtDur(run.startedAt, run.endedAt) : fmtAgo(task.createdAt)));
  node.appendChild(meta_);

  if (run && ['running', 'verifying'].includes(task.status)) {
    node.appendChild(stageRail(run.stage, task.status, false));
    const bar = el('div', 'bar');
    const fill = el('span');
    fill.style.width = `${Math.round((run.progress || 0) * 100)}%`;
    bar.appendChild(fill);
    node.appendChild(bar);
  }
  if (task.error) node.appendChild(el('div', 'lastlog', task.errorTruncated ? `${task.error}…` : task.error));
  else if (run?.summary && task.status !== 'running') node.appendChild(el('div', 'lastlog', run.summary.split('\n')[0]));
  return node;
}

// ------------------------------------------------------------- epic groups
//
// Unchanged from the original: a true swimlane (one row per epic across every
// stage) fights the per-status columns, because an epic's status and its
// tickets' statuses routinely differ. So the grouping happens *within* a lane:
// wherever a lane holds an epic's tickets, one compact header is drawn for
// that epic in that lane, with its tickets nested under it.

const epicChildrenOf = (tasks, epicId) => tasks.filter((t) => t.parentId === epicId);

function epicFor(tasks, task) {
  const epicId = task.isEpic ? task.id : task.parentId;
  if (!epicId) return null;
  return tasks.find((t) => t.id === epicId && t.isEpic) ?? null;
}

function epicHeader(tasks, epicTask) {
  const kids = epicChildrenOf(tasks, epicTask.id);
  const done = kids.filter((k) => k.status === 'done').length;
  const points = kids.reduce((n, k) => n + (k.points || 0), 0);
  // An epic runs no work of its own (closeEpicIfComplete), so its statuses are
  // only blocked or done/failed/canceled — the closed ones have to read as
  // visually distinct rather than as another dashed accent box.
  const head = el('button', `epic-head s-${epicTask.status}`);
  head.type = 'button';
  head.dataset.id = epicTask.id;
  tip(head, epicTask.title, `Epic — ${done} of ${kids.length} ticket(s) done. Open it for the plan, the retrospective and the rollup.`);

  const top = el('div', 'epic-head-top');
  top.appendChild(el('b', null, epicTask.title));
  const chips = el('div', 'chips');
  if (epicTask.playbook) chips.appendChild(el('span', 'chip chip-role', epicTask.playbook));
  chips.appendChild(el('span', `chip ${CHIP[epicTask.status] ?? ''}`, epicTask.status));
  top.appendChild(chips);
  head.appendChild(top);
  head.appendChild(el(
    'div',
    'epic-head-meta',
    `${done}/${kids.length} ticket${kids.length === 1 ? '' : 's'} done${points ? ` · ${points} pts` : ''}`,
  ));
  // A failed epic has to show *why* on the header, or it reads as just another
  // closed epic with no failure signal at all.
  if (epicTask.error) head.appendChild(el('div', 'lastlog', epicTask.errorTruncated ? `${epicTask.error}…` : epicTask.error));
  return head;
}

// ------------------------------------------------------------------ drawer

function logLine(ev) {
  const line = el('div', `ln t-${ev.type}`);
  line.appendChild(el('time', null, fmtTime(ev.ts)));
  const prefix = ev.type === 'stage' ? `[${ev.stage}] ` : ev.type === 'status' ? '● ' : ev.type === 'error' ? '✖ ' : ev.type === 'warning' ? '⚠ ' : '';
  line.appendChild(document.createTextNode(prefix + ev.message));
  return line;
}

function renderArtifacts(artifacts) {
  const wrap = clear($('dArtifacts'));
  $('dArtifactBody').hidden = true;
  if (!artifacts.length) {
    wrap.appendChild(emptyState('No artifacts yet', 'Diffs and logs appear here once the worker writes them.', { inline: true }));
    return;
  }
  for (const a of artifacts) {
    const row = el('div', 'art');
    const left = el('div');
    const state = a.approved === 1 ? ' ✓ approved' : a.approved === 0 ? ' ✕ rejected' : '';
    left.appendChild(el('div', 'art-title', `${a.type}${a.summary ? ` — ${a.summary}` : ''}${state}`));
    left.appendChild(el('div', 'p', a.path));
    row.appendChild(left);

    const b = el('button', 'btn sm');
    b.type = 'button';
    add(b, icon('eye'), el('span', null, 'View'));
    tip(b, 'View artifact', 'Read this file inline. Anything over 512 KB shows its last 512 KB.');
    b.addEventListener('click', () => void runAction(b, async () => {
      const body = await api(`/api/artifacts/${a.id}/content`);
      const pre = clear($('dArtifactBody'));
      pre.hidden = false;
      for (const line of body.content.split('\n')) {
        const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : null;
        pre.appendChild(el('div', cls, line));
      }
    }));
    row.appendChild(b);
    wrap.appendChild(row);
  }
}

function renderCouncil(verdicts) {
  const wrap = clear($('dCouncil'));
  if (!verdicts.length) {
    wrap.appendChild(emptyState('No verdict yet', 'Verification runs after the worker finishes.', { inline: true }));
    return;
  }
  for (const v of verdicts) {
    const isCrew = v.source === 'crew';
    const head = el('div', `op ${v.verdict === 'pass' ? 'pass' : v.verdict === 'fail' ? 'fail' : 'err'}`);
    const h = el('h5');
    h.appendChild(el('span', null, `${isCrew ? 'crew review' : 'council'} verdict: ${v.verdict}${splitNote(v)}`));
    h.appendChild(el('span', null, `${fmtUsd(v.costUsd, 4)} · ${fmtTime(v.createdAt)}`));
    head.appendChild(h);
    // The chair's reasoning gets its own block below; don't print it twice.
    if (v.critique && v.critique !== v.chairSummary) head.appendChild(el('p', null, v.critique));
    wrap.appendChild(head);

    for (const o of v.council) {
      const box = el('div', `op ${o.error ? 'err' : o.verdict}`);
      const title = el('h5');
      if (isCrew) {
        // A crew reviewer is a playbook role playing a review style, not a
        // timed council advisor — role/style + model identify it, and a
        // fabricated 0ms latency is omitted rather than shown as meaningful.
        title.appendChild(el('span', null, `${o.role ?? 'reviewer'} · ${o.style ?? 'review'} (${o.model})`));
        title.appendChild(el('span', null, o.error ? 'unavailable' : `${o.verdict} · ${fmtUsd(o.costUsd, 4)}`));
      } else {
        title.appendChild(el('span', null, `${o.model} (${o.provider}${o.local ? ', local' : ', cloud'})`));
        title.appendChild(el('span', null, o.error ? 'unavailable' : `${o.verdict} · confidence ${o.confidence.toFixed(2)} · ${o.latencyMs}ms`));
      }
      box.appendChild(title);
      box.appendChild(el('p', null, o.error || o.critique || '(no critique given)'));
      wrap.appendChild(box);
    }
    if (v.chairSummary) {
      const chair = el('div', 'op chair');
      chair.appendChild(el('h5', null, summaryHeading(v)));
      chair.appendChild(el('p', null, v.chairSummary));
      wrap.appendChild(chair);
    }
  }
}

function renderReceipts(receipts) {
  const wrap = clear($('dReceipts'));
  if (!receipts.length) {
    wrap.appendChild(emptyState('No model calls', 'Nothing has been billed to this task yet.', { inline: true }));
    return;
  }
  const table = el('table', 'tbl');
  const thead = el('thead');
  const head = el('tr');
  for (const h of ['time', 'kind', 'model', 'where', 'in', 'out', 'cost', 'ms']) head.appendChild(el('th', null, h));
  thead.appendChild(head);
  table.appendChild(thead);

  const body = el('tbody');
  let total = 0;
  for (const r of receipts) {
    total += Number(r.cost_usd);
    const tr = el('tr');
    tr.appendChild(el('td', null, fmtTime(r.created_at)));
    tr.appendChild(el('td', null, r.kind));
    tr.appendChild(el('td', null, r.model));
    tr.appendChild(el('td', Number(r.local) ? 'dim' : 'cloud', Number(r.local) ? 'local' : 'cloud'));
    tr.appendChild(el('td', 'num', String(r.tokens_in)));
    tr.appendChild(el('td', 'num', String(r.tokens_out)));
    tr.appendChild(el('td', 'num', fmtUsd(r.cost_usd, 4)));
    tr.appendChild(el('td', 'num', String(r.latency_ms)));
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  wrap.appendChild(el('p', 'rc-total', `${receipts.length} call(s), ${fmtUsd(total, 4)} total`));
}

function renderDrawerHeader(state) {
  const task = state.tasks.find((t) => t.id === openTaskId);
  if (!task) {
    // An *empty* snapshot is "not loaded yet", not "the task is gone": the
    // router mounts a deep link (#/board/<id>) before store.start() has
    // answered, and closing the drawer there would throw away the one thing
    // the URL asked for. render() calls back through here on the snapshot.
    if (state.tasks.length) closeDrawer();
    return;
  }
  $('dTitle').textContent = task.title;
  const run = task.run;
  $('dSub').textContent = [
    task.id, task.status, task.runner,
    run?.branch ? `branch ${run.branch}` : null,
    run?.worktreePath,
    run?.costUsd ? fmtUsd(run.costUsd, 4) : null,
    `${run?.tokensIn ?? 0}/${run?.tokensOut ?? 0} tok`,
  ].filter(Boolean).join(' · ');

  clear($('dRail')).appendChild(stageRail(run?.stage ?? 'admit', task.status, true));

  const actions = clear($('dActions'));
  const action = (label, cls, iconName, desc, fn, okMessage) => {
    const b = el('button', `btn ${cls}`.trim());
    b.type = 'button';
    add(b, icon(iconName), el('span', null, label));
    tip(b, label, desc, { place: 'bottom' });
    b.addEventListener('click', () => void runAction(b, async () => {
      const r = await fn();
      await store.refresh();
      return r;
    }, okMessage));
    actions.appendChild(b);
  };

  if (task.status === 'awaiting-approval') {
    // A split is not a decision waiting for you — it is the council failing to
    // reach one. Approving it signs off work nobody reviewed, and retrying
    // throws away work that is probably fine. Offer the thing the situation
    // actually calls for, first and as the primary action.
    if ((run?.verdict === 'split' || run?.verdict == null) && !heldByReviewer(task, run)) {
      action('Re-review', 'primary', 'refresh',
        'Ask the council again, keeping the work. A split means no verdict was reached — usually the ' +
        'reviewer failed, not the work. This re-reads the stored diff; it does not re-run the task.',
        // The endpoint only starts the review (202); the verdict comes later.
        async () => awaitReview(task.id, await post(`/api/tasks/${task.id}/reverify`)),
        (outcome) => outcome);
    }
    // Approving and landing are two outcomes on one 200: a conflicting merge
    // is aborted and reported in `merge`, and saying only "Approved" there
    // leaves the operator believing a branch landed that did not.
    action('Approve', 'primary', 'check',
      'Accept the staged diff; merges the branch if merge-on-approve is set.',
      () => post(`/api/tasks/${task.id}/approve`),
      (r) => approvalOutcome(r, 'Approved'));
    action('Reject', 'danger', 'ban',
      'Send it back with a note — the critique feeds the next repair round.',
      () => post(`/api/tasks/${task.id}/reject`, { note: 'rejected on the board' }),
      (r) => rejectionOutcome(r, 'Rejected — the note goes to the next repair round'));
  }
  if (task.status === 'awaiting-human') {
    // Same two verbs as the gate, and deliberately the same endpoints: the
    // operator reporting on their own work and the operator judging a model's
    // are one decision path, so a human-worked ticket closes with the same
    // event, the same artifact stamping and the same epic bookkeeping.
    action('Mark done', 'primary', 'check',
      'You did this one. Closes it as done. Nothing from an earlier run lands by itself — if an interrupted run left its worktree, you are told where it is.',
      () => post(`/api/tasks/${task.id}/approve`, { note: 'completed by the operator' }),
      (r) => approvalOutcome(r, 'Closed'));
    action('Drop', 'danger', 'ban',
      'You are not doing this one. Closes it as rejected, with a note.',
      () => post(`/api/tasks/${task.id}/reject`, { note: 'dropped by the operator' }),
      (r) => rejectionOutcome(r, 'Dropped'));
  }
  // Who works it, flipped in place. Only offered where it is actually legal —
  // a started task is refused server-side, and offering a control that always
  // errors is worse than not offering it.
  if (['queued', 'blocked', 'awaiting-human'].includes(task.status) && !task.isEpic) {
    const to = task.status === 'awaiting-human' ? 'ai' : 'human';
    action(to === 'human' ? 'Give to me' : 'Give to AI', '', to === 'human' ? 'user' : 'bot',
      to === 'human'
        ? 'Take this off the queue and onto your desk. No worker will claim it.'
        : 'Hand it back to the queue for a worker to pick up.',
      () => post(`/api/tasks/${task.id}/assign`, { assignee: to }),
      to === 'human' ? 'Yours now' : 'Back in the queue');
  }
  if (['queued', 'blocked', 'running', 'verifying'].includes(task.status)) {
    action('Cancel', 'danger', 'ban',
      'Stop this run now and kill its process group. Nothing it did lands; work that had already reached review is kept for inspection.',
      () => post(`/api/tasks/${task.id}/cancel`),
      'Canceled');
  }
  if (ENDED.includes(task.status)) {
    action('Retry', '', 'refresh',
      'Re-queue from scratch: the attempt counter resets and the old gate decision is cleared.',
      () => post(`/api/tasks/${task.id}/retry`),
      'Re-queued');
    action('Delete', 'danger', 'trash',
      'Remove this task and its history from the queue. There is no undo.',
      async () => {
        await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
        closeDrawer();
      },
      'Deleted');
  }
  // task.prompt is the snapshot's truncated stub (see server.ts:snapshot);
  // once the detail fetch below lands, drawerPromptFull holds the real text
  // and wins here so a live poll mid-view can't stomp it back to the stub.
  $('dPrompt').textContent = drawerPromptFull ?? (task.promptTruncated ? `${task.prompt}…` : task.prompt);
}

async function openDrawer(taskId) {
  openTaskId = taskId;
  drawerPromptFull = null;
  $('drawer').hidden = false;
  renderDrawerHeader(store.state);
  try {
    const detail = await api(`/api/tasks/${taskId}`);
    // A slow response for a drawer the user already switched away from must
    // not populate the new task's panels with the old task's data.
    if (openTaskId !== taskId) return;
    // The one field on this response the header didn't already have from the
    // snapshot: the full, untruncated prompt. Set directly rather than
    // through renderDrawerHeader() so a slow fetch can't race a snapshot poll
    // that fires in between and clobber this.
    drawerPromptFull = detail.task.prompt;
    $('dPrompt').textContent = drawerPromptFull;
    const log = clear($('dLog'));
    for (const ev of detail.events) if (ev.type !== 'progress' && ev.type !== 'metrics') log.appendChild(logLine(ev));
    log.parentElement.scrollTop = log.parentElement.scrollHeight;
    renderArtifacts(detail.artifacts);
    renderCouncil(detail.verdicts ?? []);
    renderReceipts(detail.receipts ?? []);
  } catch (err) {
    toast.err(err);
  }
}

/**
 * The drawer opens two ways and has to close exactly one way.
 *
 * A card click opens it without touching the hash (a click inside a view is
 * not navigation, and rewriting the URL there would push a history entry per
 * card). The palette's "Open task" and a deep link arrive as #/board/<id>
 * instead. So closing has to reconcile: leaving the hash at #/board/<id> with
 * no drawer on screen means the URL names a task nobody is looking at, the
 * next reload re-opens it, and the sidebar's Board item — which is what an
 * operator presses to "get back to the board" — is pointing somewhere else
 * than where they already are.
 *
 * replaceState rather than `location.hash = '#/board'`, for two reasons: no
 * history entry to press Back through for every drawer the operator glanced
 * at, and no hashchange, so the router does not remount the board (and
 * rebuild the drawer we are in the middle of closing) underneath us.
 */
function syncHashToBoard() {
  if (typeof location === 'undefined' || !/^#\/board\/.+/.test(location.hash)) return;
  history.replaceState(null, '', `${location.pathname}${location.search}#/board`);
}

function closeDrawer() {
  openTaskId = null;
  drawerPromptFull = null;
  const d = $('drawer');
  if (d) d.hidden = true;
  syncHashToBoard();
  store.emit();
}

/** Exposed so the palette and the router can jump straight to a task. */
export const openTask = (id) => void openDrawer(id);

// ------------------------------------------------------------------- mount

export function mount(root, ctx = {}) {
  root.className = 'view';

  const filterRow = el('div', 'pbfilter');
  const lanes = el('div', 'lanes');
  add(root, filterRow, lanes, drawerMarkup());

  function renderFilter(state) {
    const playbooks = [...new Set(state.tasks.map((t) => t.playbook).filter(Boolean))].sort();
    clear(filterRow);
    if (!playbooks.length) {
      filterRow.hidden = true;
      return;
    }
    filterRow.hidden = false;
    // The filter may point at a playbook no task carries anymore (its last
    // task closed, or tasks reloaded) — fall back to "all" rather than showing
    // an empty board with no visible chip.
    if (playbookFilter && !playbooks.includes(playbookFilter)) playbookFilter = null;
    const chip = (label, value, desc) => {
      const b = el('button', `fchip${playbookFilter === value ? ' on' : ''}`, label);
      b.type = 'button';
      tip(b, label, desc);
      b.addEventListener('click', () => { playbookFilter = value; render(store.state); });
      filterRow.appendChild(b);
    };
    chip('All', null, 'Show every task, whatever playbook it runs under.');
    for (const pb of playbooks) chip(pb, pb, `Show only tasks running under the ${pb} playbook.`);
  }

  function render(state) {
    renderFilter(state);
    const visible = playbookFilter ? state.tasks.filter((t) => t.playbook === playbookFilter) : state.tasks;
    clear(lanes);
    for (const lane of LANES) {
      const col = el('div', `lane ${lane.cls}`);
      const tasks = visible.filter((t) => lane.statuses.includes(t.status));
      const h = el('h3');
      h.appendChild(el('span', null, lane.name));
      h.appendChild(el('span', 'count', String(tasks.length)));
      tip(h, lane.name, lane.tip, { place: 'bottom' });
      col.appendChild(h);

      if (!tasks.length) col.appendChild(emptyState(lane.empty[0], lane.empty[1], { inline: true }));

      const shownEpics = new Set();
      for (const t of tasks) {
        const epicTask = epicFor(state.tasks, t);
        if (!epicTask) {
          col.appendChild(card(t));
          continue;
        }
        if (shownEpics.has(epicTask.id)) continue; // already grouped in this lane
        shownEpics.add(epicTask.id);
        col.appendChild(epicHeader(state.tasks, epicTask));
        const group = el('div', 'epic-group');
        for (const member of tasks.filter((x) => x.parentId === epicTask.id)) group.appendChild(card(member));
        col.appendChild(group);
      }
      // The Closed lane is "what just happened", and it stays that length only
      // because everything older has been folded away. Say so, and give the
      // operator one click to the rest — an invisible archive reads as lost
      // history, which is exactly what it is not.
      if (lane.cls === 'l-closed' && state.archivedCount) {
        const more = el('button', 'lane-more');
        more.type = 'button';
        add(more, icon('archive'), el('span', null, `${state.archivedCount} archived`));
        tip(more, 'Archive',
          'Everything that closed more than a week ago. Nothing was deleted — the archive also carries what each task actually cost, which is what estimates are built from.',
          { place: 'top' });
        more.addEventListener('click', () => goTo('archive'));
        col.appendChild(more);
      }
      lanes.appendChild(col);
    }
    if (openTaskId) renderDrawerHeader(state);
  }

  lanes.addEventListener('click', (e) => {
    const node = e.target.closest('.tcard, .epic-head');
    if (node) void openDrawer(node.dataset.id);
  });

  const onKey = (e) => { if (e.key === 'Escape' && openTaskId) closeDrawer(); };
  document.addEventListener('keydown', onKey);

  const offSnapshot = store.subscribe(render);
  const offEvent = store.onEvent((ev) => {
    if (ev.taskId !== openTaskId || ev.type === 'progress' || ev.type === 'metrics') return;
    const log = $('dLog');
    if (!log) return;
    log.appendChild(logLine(ev));
    const panel = log.parentElement;
    if (panel.scrollHeight - panel.scrollTop - panel.clientHeight < 120) panel.scrollTop = panel.scrollHeight;
    if (ev.type === 'artifact' || ev.type === 'verdict') {
      api(`/api/tasks/${openTaskId}`)
        .then((d) => { renderArtifacts(d.artifacts); renderCouncil(d.verdicts ?? []); renderReceipts(d.receipts ?? []); })
        .catch(() => {});
    }
  });

  // Durations have to tick even when no event is arriving.
  const ticker = setInterval(() => {
    if (store.state.tasks.some((t) => t.status === 'running')) render(store.state);
  }, 1000);

  render(store.state);
  if (ctx.params?.[0]) void openDrawer(ctx.params[0]);

  return () => {
    clearInterval(ticker);
    document.removeEventListener('keydown', onKey);
    offSnapshot();
    offEvent();
    openTaskId = null;
    drawerPromptFull = null;
  };
}

// --------------------------------------------------------- drawer skeleton

function drawerMarkup() {
  const drawer = el('aside', 'drawer glass');
  drawer.id = 'drawer';
  drawer.hidden = true;

  const head = el('div', 'drawer-head');
  const heading = el('div');
  const h2 = el('h2', null, '—');
  h2.id = 'dTitle';
  const sub = el('div', 'sub');
  sub.id = 'dSub';
  add(heading, h2, sub);
  const closeBtn = el('button', 'icon-btn');
  closeBtn.type = 'button';
  closeBtn.appendChild(icon('close'));
  tip(closeBtn, 'Close', 'Back to the board. The run keeps going either way.', { keys: ['Esc'], place: 'left' });
  closeBtn.addEventListener('click', closeDrawer);
  add(head, heading, closeBtn);

  const rail = el('div');
  rail.id = 'dRail';
  const actions = el('div', 'drawer-actions');
  actions.id = 'dActions';

  const tabs = el('div', 'tabs');
  tabs.id = 'dTabs';
  const panels = [];
  for (const [key, panelId] of [['log', 'pLog'], ['council', 'pCouncil'], ['artifacts', 'pArtifacts'], ['receipts', 'pReceipts'], ['prompt', 'pPrompt']]) {
    const [label, desc] = TAB_TIPS[key];
    const b = el('button', key === openTab ? 'on' : '', label);
    b.type = 'button';
    b.dataset.tab = key;
    tip(b, label, desc, { place: 'bottom' });
    tabs.appendChild(b);

    const panel = el('div', 'panel');
    panel.id = panelId;
    panel.hidden = key !== openTab;
    panels.push([key, panel]);
  }

  const logPanel = panels.find(([k]) => k === 'log')[1];
  const logPre = el('pre');
  logPre.id = 'dLog';
  logPanel.appendChild(logPre);
  panels.find(([k]) => k === 'council')[1].appendChild(Object.assign(el('div'), { id: 'dCouncil' }));
  const artPanel = panels.find(([k]) => k === 'artifacts')[1];
  artPanel.appendChild(Object.assign(el('div'), { id: 'dArtifacts' }));
  const artBody = el('pre');
  artBody.id = 'dArtifactBody';
  artBody.hidden = true;
  artPanel.appendChild(artBody);
  panels.find(([k]) => k === 'receipts')[1].appendChild(Object.assign(el('div'), { id: 'dReceipts' }));
  const promptPre = el('pre');
  promptPre.id = 'dPrompt';
  panels.find(([k]) => k === 'prompt')[1].appendChild(promptPre);

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    openTab = b.dataset.tab;
    for (const btn of tabs.children) btn.classList.toggle('on', btn === b);
    for (const [key, panel] of panels) panel.hidden = key !== openTab;
  });

  add(drawer, head, rail, actions, tabs, ...panels.map(([, p]) => p));
  return drawer;
}
