/**
 * main.js — the app shell: sidebar, topbar, hash router, and the wiring that
 * connects the shared store, tooltip, toast and palette components to it.
 *
 * ## The view contract
 *
 * Every module in views/ exports:
 *
 *   export const meta = { id, title, icon, desc };
 *   export function mount(root, ctx) { …; return optionalTeardown; }
 *
 * `ctx.params` is the rest of the hash split on '/', so #/board/t_ab12 mounts
 * the board with params ['t_ab12']. The router calls the teardown before
 * mounting the next view, which is how a view unsubscribes from the store —
 * there is exactly one EventSource per tab no matter how much navigating
 * happens.
 *
 * ## Routing
 *
 * Hash-based (#/board, #/receipts, …) with no build step and no history API,
 * so every file under board/ is a plain static asset the daemon can serve as-is
 * and a deep link survives a reload.
 */
import { add, clear, el, fmtUsd, post } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { approvalOutcome, budgetRatio, rejectionOutcome, store, tasksAwaitingApproval } from './lib/store.js';
import { installTooltips, tip, hide as hideTip } from './lib/tooltip.js';
import { toast } from './lib/toast.js';
import { installPalette, openPalette, registerCommands } from './lib/palette.js';
import { setNavigator } from './lib/nav.js';
import { openNewTask } from './lib/newtask.js';
import { openAsk } from './lib/ask.js';

import * as boardView from './views/board.js';
import * as buildView from './views/build.js';
import * as playbooksView from './views/playbooks.js';
import * as toolsView from './views/tools.js';
import * as memoryView from './views/memory.js';
import * as schedulesView from './views/schedules.js';
import * as receiptsView from './views/receipts.js';
import * as doctorView from './views/doctor.js';
import * as proseView from './views/prose.js';
import * as archiveView from './views/archive.js';

/** Sidebar order is deliberate: do the work, then inspect the machine. */
const VIEWS = [
  boardView, buildView, playbooksView, toolsView,
  memoryView, schedulesView, receiptsView, doctorView, proseView, archiveView,
];
const BY_ID = new Map(VIEWS.map((v) => [v.meta.id, v]));
const DEFAULT_VIEW = 'board';

const shell = el('div', 'shell');
const outlet = el('main', 'outlet');
let teardown = null;
let currentId = null;
/** In memory only — the board keeps no client-side persistence anywhere. */
let railed = false;

// ---------------------------------------------------------------- sidebar

const navItems = new Map();

function buildSidebar() {
  const side = el('nav', 'sidebar');
  side.setAttribute('aria-label', 'Views');

  const brand = el('div', 'brand');
  const mark = el('div', 'mark');
  mark.appendChild(icon('hardhat'));
  brand.appendChild(mark);
  const text = el('div', 'brand-text');
  text.appendChild(el('div', 'name', 'Foreman'));
  text.appendChild(el('div', 'tag', 'mission control'));
  brand.appendChild(text);
  tip(brand, 'Foreman', 'Parallel agent mission control: queue work, run it isolated, gate every result on a human click.');
  side.appendChild(brand);

  const nav = el('div', 'nav');
  for (const view of VIEWS) {
    const item = el('button', 'nav-item');
    item.type = 'button';
    item.dataset.view = view.meta.id;
    item.appendChild(icon(view.meta.icon));
    item.appendChild(el('span', 'nav-label', view.meta.title));
    tip(item, view.meta.title, view.meta.desc, { place: 'right' });
    item.addEventListener('click', () => navigate(view.meta.id));
    nav.appendChild(item);
    navItems.set(view.meta.id, item);
  }
  side.appendChild(nav);

  const foot = el('div', 'sidebar-foot');
  const collapse = el('button', 'icon-btn collapse');
  collapse.type = 'button';
  const collapseIcon = icon('collapse');
  collapse.appendChild(collapseIcon);
  tip(collapse, 'Collapse sidebar', 'Shrink the sidebar to icons. Hovering an icon still names the view.', { place: 'right' });
  collapse.addEventListener('click', () => {
    railed = !railed;
    shell.classList.toggle('rail', railed);
    clear(collapse).appendChild(icon(railed ? 'expand' : 'collapse'));
    tip(
      collapse,
      railed ? 'Expand sidebar' : 'Collapse sidebar',
      railed ? 'Show the view names again.' : 'Shrink the sidebar to icons. Hovering an icon still names the view.',
      { place: 'right' },
    );
    hideTip();
  });
  foot.appendChild(collapse);
  side.appendChild(foot);

  return side;
}

// ----------------------------------------------------------------- topbar

const topbarTitle = el('div', 'view-title', '');
const workersStat = el('div', 'stat');
const verifyStat = el('div', 'stat wide');
const spendStat = el('div', 'stat wide');
const connDot = el('div', 'conn');
const assigneeToggle = el('button', 'assignee-toggle');
const gateToggle = el('button', 'assignee-toggle');
const modeChip = el('div', 'mode-chip');

function buildTopbar() {
  const bar = el('header', 'topbar');

  tip(workersStat, 'Worker pool', 'Tasks executing right now, out of the maximum this daemon runs at once.', { place: 'bottom' });
  tip(verifyStat, 'Verify lane', 'Finished runs queued for council verification. They do not hold a worker slot.', { place: 'bottom' });
  tip(spendStat, 'Spend today', 'Model cost billed today against the daily cap. It colours once you pass 80% of it.', { place: 'bottom' });
  tip(connDot, 'Live connection', 'The event stream from the daemon. Green is live; amber means it is reconnecting from the last event it saw.', { place: 'bottom' });

  const right = el('div', 'right');

  const paletteBtn = el('button', 'icon-btn');
  paletteBtn.type = 'button';
  paletteBtn.appendChild(icon('search'));
  tip(paletteBtn, 'Command palette', 'Jump to any view or run any action from the keyboard.', { keys: ['⌘', 'K'], place: 'bottom' });
  paletteBtn.addEventListener('click', openPalette);

  const newBtn = el('button', 'btn primary');
  newBtn.type = 'button';
  add(newBtn, icon('plus'), el('span', null, 'New task'));
  tip(newBtn, 'New task', 'Queue a single task — prompt, runner, repo, budget and gate, all in one form.', { keys: ['N'], place: 'bottom' });
  newBtn.addEventListener('click', () => void openNewTask());

  // The house default for who works a task. It belongs in the topbar rather
  // than in a settings view because it is a mode the operator switches between,
  // and a mode you cannot see is one you forget you are in.
  assigneeToggle.type = 'button';
  assigneeToggle.addEventListener('click', () => void flipAssignee());

  gateToggle.type = 'button';
  gateToggle.addEventListener('click', () => void flipGate());

  add(right, modeChip, assigneeToggle, gateToggle, connDot, paletteBtn, newBtn);
  add(bar, topbarTitle, workersStat, verifyStat, spendStat, right);
  return bar;
}

function paintStatus(state) {
  paintMode(state);
  paintAssignee(state);
  paintGate(state);
  const w = state.workers ?? {};
  clear(workersStat);
  const pool = el('div', 'pool-bar');
  for (let i = 0; i < (w.max ?? 0); i++) pool.appendChild(el('i', i < (w.active ?? 0) ? 'busy' : ''));
  workersStat.appendChild(pool);
  const wc = el('span');
  wc.appendChild(el('b', null, String(w.active ?? 0)));
  wc.appendChild(document.createTextNode(` / ${w.max ?? 0} workers`));
  workersStat.appendChild(wc);

  clear(verifyStat);
  const verifying = w.verifying ?? 0;
  const lane = w.verifyLane ?? 0;
  verifyStat.appendChild(el('b', null, String(verifying)));
  verifyStat.appendChild(document.createTextNode(lane ? ` verifying · ${lane} waiting` : ' verifying'));

  const b = state.budget ?? { spentToday: 0, dailyCapUsd: 0, callsToday: 0, nonLocalCallsToday: 0 };
  const ratio = budgetRatio(b);
  spendStat.className = `stat wide${ratio == null ? '' : ratio >= 1 ? ' over' : ratio >= 0.8 ? ' hot' : ''}`;
  clear(spendStat);
  spendStat.appendChild(el('b', null, fmtUsd(b.spentToday)));
  spendStat.appendChild(document.createTextNode(
    b.dailyCapUsd > 0
      ? ` / ${fmtUsd(b.dailyCapUsd, 2)} today · ${b.callsToday} calls, ${b.nonLocalCallsToday} cloud`
      : ` today · ${b.callsToday} calls`,
  ));
  // The roster is the answer to "which model would run this?", so it belongs
  // on the spend readout rather than in a view nobody would think to open.
  tip(
    spendStat,
    'Spend today',
    state.roster
      ? `Against the daily cap. Bench roster — ${Object.entries(state.roster).map(([k, v]) => `${k}: ${v}`).join(', ')}.`
      : 'Against the daily cap. No bench yet — run: foreman doctor --bench.',
    { place: 'bottom' },
  );
}

/**
 * Flip the house default between AI and me.
 *
 * It changes what a NEW task with no opinion of its own gets. It deliberately
 * does not touch work already queued — retro-assigning a running backlog to a
 * human is not a toggle, it is a decision per ticket, and the drawer is where
 * that is made.
 */
async function flipAssignee() {
  const current = store.state?.assignee?.effective ?? 'ai';
  const next = current === 'ai' ? 'human' : 'ai';
  assigneeToggle.disabled = true;
  try {
    await post('/api/settings/assignee', { assignee: next });
    await store.refresh();
    toast(next === 'ai'
      ? 'New tasks go to the AI'
      : 'New tasks now wait for you in “Yours to do”');
  } catch (err) {
    toast(`Could not change it: ${err.message}`, 'bad');
  } finally {
    assigneeToggle.disabled = false;
  }
}

/**
 * Flip who decides at the gate, and hand the current backlog over with it.
 *
 * Switching TO the owner model applies to what is already waiting — which is
 * the retroactive step an exported FOREMAN_GATE is deliberately not allowed to
 * take. A person pressing this button is the sanctioned path for it. Switching
 * back to human only changes what happens next; nothing already decided is
 * undecided.
 */
async function flipGate() {
  const current = store.state?.gate?.effective ?? 'human';
  const next = current === 'human' ? 'owner' : 'human';
  const waiting = store.state?.gate?.waiting ?? 0;
  gateToggle.disabled = true;
  try {
    const r = await post('/api/settings/gate', { gate: next, applyToWaiting: next === 'owner' });
    await store.refresh();
    toast(next === 'owner'
      ? `Owner model decides${r.applied ? ` — ${r.applied} waiting task(s) handed over` : ''}. Green work only.`
      : `You decide again${waiting ? ` — ${waiting} still waiting` : ''}`);
  } catch (err) {
    toast(`Could not change it: ${err.message}`, 'bad');
  } finally {
    // The refresh above may have repainted it as forced to the human.
    gateToggle.disabled = Boolean(store.state?.gate?.forcedHuman);
  }
}

/**
 * Which model plane is live. Shown only when it is NOT the normal mixed mode:
 * local-only changes what every ticket routes to, what the gate does and which
 * runners are refused, so it has to be visible from every view.
 */
function paintMode(state) {
  const m = state.mode ?? { localOnly: false, fallback: false };
  modeChip.hidden = !m.localOnly && !m.fallback;
  if (modeChip.hidden) return;
  clear(modeChip);
  add(modeChip, icon('alert'), el('span', null, m.localOnly ? 'Local-only' : 'Claude offline'));
  tip(
    modeChip,
    m.localOnly ? 'Running on local models only' : 'Falling back to local models',
    m.localOnly
      ? 'FOREMAN_LOCAL_ONLY is set. Every tier routes to a local model, hosted runners are refused, and every gate is yours.'
      : `The Claude CLI is unreachable: ${m.cloudDown ?? 'unknown'}. Work that used Claude models runs on local ones, ` +
        'claude-code tickets wait in the queue untouched, and every gate is yours. Codex and gateway models are ' +
        'unaffected. Foreman checks again every five minutes and switches back once a real call succeeds — ' +
        'sign the CLI in (run claude, then /login).',
    { place: 'bottom' },
  );
}

function paintGate(state) {
  const g = state.gate ?? { effective: 'human', houseDefault: null, waiting: 0 };
  const owner = g.effective === 'owner';
  gateToggle.className = `assignee-toggle${owner ? ' human' : ''}`;
  gateToggle.disabled = Boolean(g.forcedHuman);
  clear(gateToggle);
  add(gateToggle, icon(owner ? 'bot' : 'check'), el('span', null, owner ? 'Auto-gate' : 'You gate'));
  if (g.forcedHuman) {
    tip(
      gateToggle,
      'You sign off — no owner model',
      'With no cloud owner model available every gate is yours: a local model does not approve its own crew’s ' +
      'work. The house setting is kept and applies again once the cloud is back.',
      { place: 'bottom' },
    );
    return;
  }
  tip(
    gateToggle,
    owner ? 'The owner model signs off' : 'You sign off',
    (owner
      ? 'Finished work that already went green is approved by the owner model instead of waiting for you. '
      : 'Every finished run waits for your approval. ') +
    'Click to switch — switching to auto-gate also hands over whatever is waiting now.\n\n' +
    'It only ever signs off GREEN work. Anything S2, anything carrying allowCore, anything that ' +
    'stopped on the budget, failed its checks, or came back fail or split still parks for you — ' +
    'and so does anything it is unsure about, with its reasoning on the task timeline. ' +
    'A playbook that gates on the human still wins over this.',
    { place: 'bottom' },
  );
}

function paintAssignee(state) {
  const a = state.assignee ?? { effective: 'ai', houseDefault: null, fromEnv: null };
  const human = a.effective === 'human';
  assigneeToggle.className = `assignee-toggle${human ? ' human' : ''}`;
  clear(assigneeToggle);
  add(assigneeToggle, icon(human ? 'user' : 'bot'), el('span', null, human ? 'You' : 'AI'));
  tip(
    assigneeToggle,
    human ? 'New work waits for you' : 'New work goes to the AI',
    (human
      ? 'New tasks park in “Yours to do” and no worker will ever claim them. '
      : 'New tasks are queued for a worker, which is what Foreman is for. ') +
    'Click to switch. This sets the house default only: a task with its own assignee, ' +
    'and a playbook role that claims its tickets, both still win over it. Work already ' +
    'queued is untouched — reassign that from a task’s drawer.' +
    (a.houseDefault === null && a.fromEnv
      ? ` Currently following FOREMAN_ASSIGNEE=${a.fromEnv}.`
      : ''),
    { place: 'bottom' },
  );
}

function paintConnection(status) {
  connDot.className = `conn ${status}`;
  clear(connDot);
  connDot.appendChild(el('i'));
  connDot.appendChild(el('span', null, status === 'live' ? 'live' : status));
}

// ----------------------------------------------------------------- router

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const id = parts[0] && BY_ID.has(parts[0]) ? parts[0] : DEFAULT_VIEW;
  return { id, params: parts.slice(1) };
}

/**
 * The one way anything in the app changes view.
 *
 * Assigning `location.hash` a value it already holds fires no hashchange, so
 * route() never runs and the click does *nothing*. That is not a harmless
 * no-op: the sidebar's own item is the control an operator reaches for when a
 * view has gone wrong — the board hidden behind an open drawer, a view whose
 * mount() threw and left an empty outlet — and it was the one control that
 * could not fix it. Re-routing by hand on a same-hash navigation makes every
 * view remountable from its own nav item, so no wedged view is a dead end.
 *
 * This is deliberately the single place that guard lives: the sidebar, the
 * palette's `go:` commands and runViewAction() all come through here.
 */
function navigate(id, ...params) {
  const next = `#/${[id, ...params].join('/')}`;
  if (location.hash === next) route();
  else location.hash = next;
}

/**
 * Run a view's own action from outside it (the palette).
 *
 * Views expose their entry points as `request*()` module functions that set a
 * one-shot intent, consumed on the next mount — so the palette never reaches
 * into a view's DOM. navigate() re-routes when the hash would not change, so
 * the intent is always claimed by a mount, whichever view we started on.
 */
function runViewAction(id, prepare) {
  prepare();
  navigate(id);
}

/**
 * Runs `fn` with store.subscribe/onEvent/onConnection temporarily patched to
 * remember every disposer they hand back. If `fn` throws, every subscription
 * made during the call is released before the error is rethrown — a view
 * that subscribes and then throws partway through mount() would otherwise
 * leak that subscription forever, since its own teardown closure never gets
 * built (and so is never captured, since mount() never returns).
 */
function withTrackedSubscriptions(fn) {
  const disposers = [];
  const methods = ['subscribe', 'onEvent', 'onConnection'];
  const originals = methods.map((name) => store[name].bind(store));
  methods.forEach((name, i) => {
    const original = originals[i];
    store[name] = (...args) => {
      const off = original(...args);
      disposers.push(off);
      return off;
    };
  });
  try {
    return fn();
  } catch (err) {
    for (const off of disposers) off();
    throw err;
  } finally {
    methods.forEach((name, i) => { store[name] = originals[i]; });
  }
}

function route() {
  const { id, params } = parseHash();
  const view = BY_ID.get(id);
  // Same view, new params: remount so the view sees them (cheap — the board
  // is the only one with params today, and it rebuilds from the store).
  teardown?.();
  teardown = null;
  hideTip();
  clear(outlet);
  currentId = id;

  for (const [viewId, item] of navItems) {
    if (viewId === id) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  topbarTitle.textContent = view.meta.title;
  document.title = `${view.meta.title} · Foreman`;

  const root = el('div');
  outlet.appendChild(root);
  try {
    teardown = withTrackedSubscriptions(() => view.mount(root, { params, navigate })) ?? null;
  } catch (err) {
    toast.err(`${view.meta.title} failed to render: ${err.message}`);
  }
  outlet.scrollTop = 0;
}

// --------------------------------------------------------------- commands

function taskPicker(filter, run, kind) {
  return async () => store.state.tasks
    .filter(filter)
    .slice(0, 50)
    .map((t) => ({
      id: t.id,
      name: t.title,
      desc: `${t.id} · ${t.status} · ${t.runner}`,
      kind,
      icon: 'board',
      run: () => run(t),
    }));
}

function registerShellCommands() {
  registerCommands(() => VIEWS.map((v) => ({
    id: `go:${v.meta.id}`,
    name: v.meta.title,
    desc: v.meta.desc,
    kind: 'Go',
    icon: v.meta.icon,
    run: () => navigate(v.meta.id),
  })));

  registerCommands(() => [
    {
      id: 'act:new',
      name: 'New task',
      desc: 'Queue a single task — prompt, runner, repo, budget and gate.',
      kind: 'Action',
      icon: 'plus',
      run: () => openNewTask(),
    },
    {
      id: 'act:ask',
      name: 'Ask Foreman',
      desc: 'Describe an outcome; read the task breakdown it proposes before anything is queued.',
      kind: 'Action',
      icon: 'bolt',
      run: () => openAsk(),
    },
    {
      id: 'act:build',
      name: 'Build epic…',
      desc: 'Plan a crew epic from one ask: tickets, roles, dependencies and the plan check, all before anything is queued.',
      kind: 'Action',
      icon: 'build',
      run: () => runViewAction('build', () => buildView.requestFocus()),
    },
    {
      id: 'act:forge',
      name: 'Forge playbook…',
      desc: 'Draft an org chart for a domain nothing covers. The draft parks in pending; only you can install it.',
      kind: 'Action',
      icon: 'playbooks',
      run: () => runViewAction('playbooks', () => playbooksView.requestForge()),
    },
    {
      id: 'act:audit',
      name: 'Audit manuscript…',
      desc: 'Run the prose audit over a manuscript directory: tics, echoes, name drift and bible consistency. Costs nothing.',
      kind: 'Action',
      icon: 'prose',
      run: () => runViewAction('prose', () => proseView.requestAudit()),
    },
    {
      id: 'act:improve',
      name: 'Propose improvement…',
      desc: 'Let Foreman read its own failure evidence and propose one change to itself. Spends a model call; queues nothing until you say so.',
      kind: 'Action',
      icon: 'bolt',
      run: () => runViewAction('doctor', () => doctorView.requestImprove()),
    },
    {
      id: 'act:refresh',
      name: 'Refresh',
      desc: 'Re-read the daemon snapshot now instead of waiting for the next event.',
      kind: 'Action',
      icon: 'refresh',
      run: async () => { await store.refresh(); toast.ok('Refreshed'); },
    },
    {
      id: 'act:open',
      name: 'Open task',
      desc: 'Jump to a task’s drawer — activity, council review, artifacts, receipts.',
      kind: 'Action',
      icon: 'eye',
      emptyMessage: 'No tasks yet.',
      children: taskPicker(() => true, (t) => navigate('board', t.id), 'Open'),
    },
    {
      id: 'act:approve',
      name: 'Approve task',
      desc: 'Accept a staged diff; merges the branch if merge-on-approve is set.',
      kind: 'Action',
      icon: 'check',
      emptyMessage: 'Nothing is waiting for your approval.',
      children: taskPicker(
        (t) => t.status === 'awaiting-approval',
        async (t) => {
          const r = await post(`/api/tasks/${t.id}/approve`);
          await store.refresh();
          // Same rule as the drawer's Approve: an aborted merge comes back on
          // a 200 and has to read as a failure, not as "Approved".
          const outcome = approvalOutcome(r, `Approved "${t.title}"`);
          (outcome.ok ? toast.ok : toast.err)(outcome.message);
        },
        'Approve',
      ),
    },
    {
      id: 'act:reject',
      name: 'Reject task',
      desc: 'Send a staged result back with a note; the critique feeds the next repair round.',
      kind: 'Action',
      icon: 'ban',
      emptyMessage: 'Nothing is waiting for your approval.',
      children: taskPicker(
        (t) => t.status === 'awaiting-approval',
        async (t) => {
          const r = await post(`/api/tasks/${t.id}/reject`, { note: 'rejected from the command palette' });
          await store.refresh();
          const outcome = rejectionOutcome(r, `Rejected "${t.title}"`);
          (outcome.ok ? toast.ok : toast.err)(outcome.message);
        },
        'Reject',
      ),
    },
    {
      id: 'act:cancel',
      name: 'Cancel task',
      desc: 'Stop a queued or running task and kill its process group.',
      kind: 'Action',
      icon: 'ban',
      emptyMessage: 'Nothing is queued or running.',
      children: taskPicker(
        (t) => ['queued', 'blocked', 'running', 'verifying'].includes(t.status),
        async (t) => {
          await post(`/api/tasks/${t.id}/cancel`);
          await store.refresh();
          toast.ok(`Canceled "${t.title}"`);
        },
        'Cancel',
      ),
    },
    {
      id: 'act:retry',
      name: 'Retry task',
      desc: 'Re-queue an ended task: attempts reset and the old gate decision is cleared.',
      kind: 'Action',
      icon: 'refresh',
      emptyMessage: 'No failed, rejected or canceled tasks to retry.',
      children: taskPicker(
        (t) => ['failed', 'rejected', 'canceled'].includes(t.status),
        async (t) => {
          await post(`/api/tasks/${t.id}/retry`);
          await store.refresh();
          toast.ok(`Re-queued "${t.title}"`);
        },
        'Retry',
      ),
    },
    {
      id: 'act:prune',
      name: 'Prune jails and ledgers',
      desc: 'Delete worktrees and branches left by ended tasks, trim old receipts and dependency caches.',
      kind: 'Action',
      icon: 'trash',
      run: async () => {
        const r = await post('/api/prune', {});
        toast.ok(`Pruned ${r.removed?.length ?? 0} jail(s), ${r.ledgers?.receipts ?? 0} receipt(s), ${r.depsCachesDropped ?? 0} dep cache(s)`);
        await store.refresh();
      },
    },
    {
      id: 'act:rail',
      name: 'Toggle sidebar',
      desc: 'Collapse the sidebar to icons, or expand it again.',
      kind: 'Action',
      icon: 'collapse',
      run: () => {
        railed = !railed;
        shell.classList.toggle('rail', railed);
      },
    },
  ]);
}

// ------------------------------------------------------------------- boot

installTooltips();
installPalette();
registerShellCommands();

add(shell, buildSidebar(), add(el('div', 'main'), buildTopbar(), outlet));
document.body.appendChild(shell);

store.subscribe(paintStatus);
store.onConnection(paintConnection);
// Paint the zeroed gauges before the first snapshot lands, so the topbar is
// never a row of blank space while /api/state is in flight.
paintStatus(store.state);

// Views reach the router through lib/nav.js rather than the hash, so this
// function stays the only same-hash guard in the board.
setNavigator(navigate);
window.addEventListener('hashchange', route);

// 'N' opens the new-task form, but never while the user is typing into
// something — a shortcut that eats a keystroke in a textarea is a bug.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    void openNewTask();
  }
});

// Setting location.hash when it is empty queues a hashchange event, which the
// listener above turns into a route() call — calling route() again here too
// would double-mount the first view (and double-fire whatever it fetches on
// mount). Only call it directly when we are *not* about to change the hash,
// since in that case no hashchange is coming.
if (!location.hash) location.hash = `#/${DEFAULT_VIEW}`;
else route();

await store.start();

// A daemon that never answers should say so rather than showing an empty board.
if (store.error) toast.err(`Cannot reach the daemon: ${store.error}`);

// Nudge the operator toward the one thing only they can do.
const waiting = tasksAwaitingApproval(store.state).length;
if (waiting > 0 && currentId === 'board') {
  toast.info(`${waiting} task${waiting === 1 ? '' : 's'} waiting on your approval`);
}
