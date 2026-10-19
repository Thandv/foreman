/**
 * views/build.js — the crew planning cockpit.
 *
 * One ask goes in; a whole epic comes back as a *preview* — the tickets, the
 * lint findings, the senior critique — and nothing is queued until the operator
 * looks at that and presses Queue. That two-call shape is the daemon's, not the
 * board's: POST /api/build without `confirm` plans and returns, POST /api/build
 * with `confirm` materialises. The second call carries the plan we already
 * showed, so confirming re-parses it rather than re-planning and re-billing.
 *
 * The simple, non-epic path (one ask → a handful of plain tasks) is lib/ask.js
 * and stays reachable from the header here rather than being duplicated.
 */
import { add, api, clear, el, emptyState, fmtUsd, post, scrollIntoViewSmooth } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { store } from '../lib/store.js';
import { tip } from '../lib/tooltip.js';
import { toast } from '../lib/toast.js';
import { openAsk } from '../lib/ask.js';
import {
  actionBar, banner, button, chip, chipGroup, chipRow, field, input, linkButton,
  section, select, textarea, viewHead,
} from '../lib/view.js';

export const meta = {
  id: 'build',
  title: 'Build',
  icon: 'build',
  desc: 'Turn one ask into a crew epic: a planned set of tickets under a playbook, checked before anything is queued.',
};

/**
 * What each lint code (planCheck.ts, layer A) is actually complaining about.
 * The finding's own message names the ticket; this names the *rule*, so a code
 * seen for the first time explains itself without a trip to the source.
 */
const FINDING_TIPS = {
  'empty-plan': 'The planner produced no tickets at all. There is nothing to queue, and this is the one finding that blocks queueing outright.',
  'thin-prompt': 'A ticket brief is under 60 characters. The worker sees that brief and nothing else, so a thin one guarantees garbage.',
  'no-acceptance': 'A ticket has no acceptance criteria, but this playbook has reviewers who will judge the work against something.',
  'points-outlier': 'A single ticket is 8 points or more — big enough that it should have been split before anyone started it.',
  'missing-testcmd': 'A code ticket with no test command, under a playbook with no checks of its own: nothing gates its test stage.',
  'dup-title': 'Two tickets carry the same title — usually the planner said the same thing twice rather than meaning it twice.',
  'unreviewed-terminal': 'A ticket nothing depends on, with no qa or review ticket after it. Nothing verifies the end state.',
  'orphan-island': 'The dependency graph falls into disconnected groups. Usually a missed dependency, not deliberate parallelism.',
  'deep-chain': 'The longest dependency chain runs more than six tickets deep — a serial bottleneck the crew cannot work around.',
  'fat-epic': 'More than nine tickets. Decomposition this fine costs more in coordination than it saves in parallelism.',
};

const CHECK_MODES = [
  ['auto', 'Auto', 'Critique only when it is likely to earn its keep: five or more tickets, or a plan the lint already flagged.', 'Check: auto'],
  ['always', 'Always', 'Always spend a senior model call reviewing the plan itself before you see it.', 'Check: always'],
  ['never', 'Never', 'Skip the senior critique entirely. The free lint findings still run.', 'Check: never'],
];

/** Set by the palette so the ask is focused on arrival. */
let wantFocus = false;
export function requestFocus() { wantFocus = true; }

// ------------------------------------------------------------------ preview

function ticketCard(ticket, byRef) {
  const node = el('div', 'ticket');

  const top = el('div', 'ticket-top');
  top.appendChild(el('div', 'ticket-title', ticket.title));
  const chips = chipRow(
    chip(ticket.role, 'chip-role', `Role: ${ticket.role}`, 'The playbook role that does this ticket. The role picks the model tier the worker runs on.'),
    chip(ticket.kind, null, `Kind: ${ticket.kind}`, 'What sort of work this is. A code ticket is cut into its own git worktree; the others run without one.'),
  );
  if (ticket.points != null) {
    chips.appendChild(chip(`${ticket.points} pts`, null, 'Points', 'The planner’s size estimate for this ticket. Anything 8 or over should have been split.'));
  }
  top.appendChild(chips);
  node.appendChild(top);

  // Dependencies read as text, not as a graph: an epic is at most twelve
  // tickets and "t1, t2 → t4" says everything a box-and-arrow drawing would.
  const deps = el('div', 'deps', ticket.after.length
    ? `${ticket.after.map((r) => byRef.get(r)?.title ?? r).join(' · ')}  →  ${ticket.ref}`
    : `${ticket.ref} — starts immediately`);
  tip(deps, 'Dependencies', ticket.after.length
    ? 'This ticket stays blocked until every ticket named here has finished.'
    : 'Nothing blocks this ticket; it is admitted as soon as the epic is queued.');
  node.appendChild(deps);

  if (ticket.prompt) node.appendChild(el('div', 'brief', ticket.prompt));
  if (ticket.acceptance) {
    const acc = el('div', 'ticket-line', `Accepted when: ${ticket.acceptance}`);
    tip(acc, 'Acceptance', 'What the reviewer checks this ticket against. Written into the ticket, not invented at review time.');
    node.appendChild(acc);
  }
  // The test command is editable in place: the plan you queue is the plan you
  // see, and confirming re-sends this plan, so an edit here IS the ticket's
  // gate. The daemon re-parses and admission-screens every command on confirm —
  // a blocked command is dropped, not run.
  const testIn = input({ placeholder: 'none — nothing gates the test stage', value: ticket.testCmd ?? '' });
  testIn.addEventListener('input', () => { ticket.testCmd = testIn.value.trim() || null; });
  const t = field('Test command', 'Run inside the jail at the test stage; a non-zero exit fails the ticket before it reaches review or your gate — so wire your cheapest, strictest check here (a lint, a prose gate, a suite). Edits apply when you queue; the daemon still screens the command at admission.', testIn, { hint: 'editable' });
  t.classList.add('ticket-line');
  node.appendChild(t);
  return node;
}

function findingsList(findings) {
  const wrap = el('div', 'stack');
  for (const f of findings) {
    const row = el('div', 'finding');
    row.appendChild(chip(
      f.code,
      f.level === 'error' ? 'bad' : 'split',
      `${f.level === 'error' ? 'Blocking' : f.level === 'note' ? 'Note' : 'Warning'}: ${f.code}`,
      FINDING_TIPS[f.code] ?? 'A plan-check rule fired on this plan.',
    ));
    row.appendChild(el('div', 'finding-msg', f.message));
    wrap.appendChild(row);
  }
  return wrap;
}

// -------------------------------------------------------------------- mount

export function mount(root) {
  root.className = 'view';

  const askIn = textarea({
    rows: 4,
    placeholder: 'Take the draft in ./manuscript through a developmental edit and a line edit, and leave a style sheet behind.',
  });
  const repoIn = input({ placeholder: '/Users/you/Projects/thing' });
  const pbSel = select([['', 'Auto-classify from the ask']], '');
  const gateSel = select([
    ['', 'Playbook default'],
    ['human', 'Human — you sign every ticket'],
    ['owner', 'Owner — the owner model may sign green work'],
  ], '');
  const epicSel = select([['', '— plan from the ask —']], '');
  const budgetIn = input({ type: 'number', placeholder: 'e.g. 25' });
  budgetIn.step = '0.5';
  budgetIn.min = '0';
  const checks = chipGroup(CHECK_MODES, 'auto');

  const planBtn = el('button', 'btn primary');
  planBtn.type = 'submit';
  planBtn.setAttribute('form', 'buildForm');
  add(planBtn, icon('bolt'), el('span', null, 'Plan the epic'));
  tip(planBtn, 'Plan the epic', 'Asks the owner model for a decomposition and shows it here. Nothing is queued and no worker starts.', { keys: ['⌘', 'Enter'] });

  const err = el('p', 'err-text');
  err.hidden = true;

  const form = el('form', 'form-grid');
  form.id = 'buildForm';
  add(
    form,
    field('The ask', 'An outcome, not a command. The owner model turns it into an epic and its tickets, using the playbook’s roles.', askIn),
    add(
      el('div', 'grid-2'),
      field('Repo', 'Absolute path to a git repo. Code tickets get their own worktree cut from it; your working tree is never touched.', repoIn, { hint: 'optional' }),
      field('Playbook', 'The domain org chart the epic runs under: its roles, review chain, checks and gate policy. Auto-classify lets the daemon pick from the ask.', pbSel),
    ),
    add(
      el('div', 'grid-2'),
      field('Gate', 'Who signs a finished ticket off. The owner gate only signs work that came back green — anything failed, split or touching the playbook’s hard-human list still lands on your desk.', gateSel),
      field('Clone an epic', 'Start from an epic you already ran instead of planning a new one. This is the zero-planning-token path: no model call is made at all.', epicSel, { hint: 'optional' }),
    ),
    add(
      el('div', 'grid-2'),
      field('Budget per ticket', 'Hard USD ceiling written onto the epic and every ticket. A breach parks the ticket at your gate rather than failing it; local model calls are free and never blocked. Blank means the daily cap alone.', budgetIn, { hint: 'USD, optional' }),
      field('Plan check', 'Whether to spend a senior model call critiquing the plan before you see it. The free lint findings run either way.', checks.node),
    ),
    err,
  );

  const setup = section(
    'The ask',
    'Everything the planner is given. Hover any field to see what it changes about the epic.',
    { actions: [{
      label: 'Ask (simple plan)',
      icon: 'bolt',
      desc: 'For work that is not an epic: describe an outcome and read the plain task breakdown before queueing it.',
      run: async () => { openAsk(); },
    }] },
  );
  setup.body.appendChild(form);
  setup.body.appendChild(actionBar([planBtn]));

  const preview = section('Plan preview', 'The epic the planner proposes. Nothing here exists yet — the tickets are created only when you queue them.');
  preview.body.appendChild(emptyState(
    'No plan yet',
    'Describe an outcome above and press Plan the epic. You see every ticket, every finding and the critique before anything is queued.',
    { icon: icon('build') },
  ));

  add(root, viewHead(meta.title, meta.desc), setup.node, preview.node);

  // ---------------------------------------------------------------- data

  let currentPlan = null;

  /** The body both calls share, so confirming cannot silently change the ask. */
  const requestBody = (extra = {}) => ({
    ask: askIn.value.trim(),
    repo: repoIn.value.trim() || null,
    playbook: pbSel.value || null,
    gate: gateSel.value || null,
    budgetUsd: budgetIn.value.trim() === '' ? undefined : Number(budgetIn.value),
    fromEpic: epicSel.value || null,
    // undefined is 'auto' — JSON.stringify drops the key and the daemon
    // applies its own trigger policy.
    check: checks.value === 'auto' ? undefined : checks.value === 'always',
    ...extra,
  });

  void api('/api/playbooks')
    .then((catalog) => {
      for (const pb of catalog.playbooks ?? []) {
        const o = el('option', null, `${pb.id} — ${pb.description}`);
        o.value = pb.id;
        pbSel.appendChild(o);
      }
    })
    .catch(() => { /* auto-classify still works; the daemon picks */ });

  function syncEpics(state) {
    const epics = state.tasks.filter((t) => t.isEpic);
    const keep = epicSel.value;
    clear(epicSel);
    const none = el('option', null, '— plan from the ask —');
    none.value = '';
    epicSel.appendChild(none);
    for (const e of epics) {
      const o = el('option', null, `${e.title} · ${e.status}`);
      o.value = e.id;
      epicSel.appendChild(o);
    }
    if (epics.some((e) => e.id === keep)) epicSel.value = keep;
  }

  // ------------------------------------------------------------- render

  function renderPlan(data) {
    const { plan, findings = [], critique } = data;
    currentPlan = plan;
    const body = clear(preview.body);

    if (plan.degraded) {
      body.appendChild(banner('warn', 'The owner model was unreachable — this is the fallback plan', plan.notes));
    }

    const head = el('div', 'card');
    head.appendChild(el('h3', null, plan.epic.title));
    if (plan.epic.summary) head.appendChild(el('div', 'card-desc', plan.epic.summary));
    const facts = chipRow(
      chip(plan.playbook, 'chip-role', `Playbook: ${plan.playbook}`, 'The playbook this epic runs under. Its roles, review chain, checks and gate policy apply to every ticket.'),
      chip(`${plan.tickets.length} ticket${plan.tickets.length === 1 ? '' : 's'}`, null, 'Ticket count', 'How many tasks this epic becomes. Twelve is the planner’s hard ceiling.'),
    );
    if (plan.costUsd > 0) {
      facts.appendChild(chip(fmtUsd(plan.costUsd, 4), 'chip-model', 'Planning cost', 'What the decomposition call itself cost. Queueing does not re-plan, so it does not charge this twice.'));
    }
    if (plan.precedents?.length) {
      facts.appendChild(chip(`${plan.precedents.length} precedent${plan.precedents.length === 1 ? '' : 's'}`, null, 'Precedents used', `Retrospectives from past epics fed to the planner as prior art: ${plan.precedents.join(', ')}.`));
    }
    head.appendChild(facts);
    if (plan.notes && !plan.degraded) head.appendChild(el('div', 'card-desc', plan.notes));
    body.appendChild(head);

    const byRef = new Map(plan.tickets.map((t) => [t.ref, t]));
    const tickets = el('div', 'stack');
    if (!plan.tickets.length) {
      tickets.appendChild(emptyState('The planner returned no tickets', 'Nothing can be queued from this. Try a more concrete ask, or pick the playbook by hand.', { inline: true }));
    }
    for (const t of plan.tickets) tickets.appendChild(ticketCard(t, byRef));
    body.appendChild(tickets);

    // Findings.
    const errors = findings.filter((f) => f.level === 'error');
    const fsec = el('div', 'stack');
    const ftitle = el('div', 'section-title', findings.length
      ? `Plan check — ${errors.length} blocking, ${findings.length - errors.length} warning`
      : 'Plan check — clean');
    tip(ftitle, 'Plan check', 'The free lint pass over the plan: shape, dependencies, sizing and review coverage. Blocking findings refuse the queue; warnings do not.');
    fsec.appendChild(ftitle);
    fsec.appendChild(findings.length
      ? findingsList(findings)
      : emptyState('No findings', 'The lint found nothing to complain about in this plan’s shape.', { inline: true }));
    body.appendChild(fsec);

    // Senior critique.
    const csec = el('div', 'stack');
    const ctitle = el('div', 'section-title', 'Senior critique');
    tip(ctitle, 'Senior critique', 'A senior model playing devil’s advocate on the plan itself — missing steps, wrong order, wrong roles, scope traps. It costs a model call, so it does not always run.');
    csec.appendChild(ctitle);
    if (critique) {
      const box = el('div', `op ${critique.verdict === 'sound' ? 'pass' : 'fail'}`);
      const h = el('h5');
      h.appendChild(el('span', null, `verdict: ${critique.verdict}`));
      h.appendChild(el('span', null, critique.verdict === 'sound' ? 'fit to run as written' : 'a competent lead would send this back'));
      box.appendChild(h);
      for (const note of critique.notes ?? []) box.appendChild(el('p', null, note));
      if (!critique.notes?.length) box.appendChild(el('p', null, '(no notes)'));
      csec.appendChild(box);
    } else {
      csec.appendChild(emptyState(
        'Not critiqued',
        'Under the auto policy the critique runs on plans of five or more tickets, or plans the lint flagged. Set Plan check to Always to force it.',
        { inline: true },
      ));
    }
    body.appendChild(csec);

    // Decision.
    const queueBtn = button({
      label: 'Queue epic',
      icon: 'plus',
      variant: 'primary',
      desc: errors.length
        ? 'Blocked: the daemon refuses to queue a plan with a blocking finding. Fix the ask and plan again.'
        : 'Creates the epic and every ticket above, wires their dependencies, and wakes the scheduler. The plan is re-sent, not re-planned, so this costs no planning tokens.',
      disabled: errors.length > 0,
      run: () => queue(),
    });
    const discardBtn = button({
      label: 'Discard',
      icon: 'ban',
      variant: 'ghost',
      desc: 'Throw this plan away and go back to the empty preview. Nothing was created, so there is nothing to undo.',
      run: async () => {
        currentPlan = null;
        clear(preview.body).appendChild(emptyState(
          'No plan yet',
          'Describe an outcome above and press Plan the epic.',
          { icon: icon('build') },
        ));
      },
    });
    body.appendChild(actionBar([queueBtn, discardBtn]));
    scrollIntoViewSmooth(preview.node, { block: 'nearest' });
  }

  async function plan() {
    err.hidden = true;
    planBtn.disabled = true;
    clear(preview.body).appendChild(el('p', 'faint', 'Planning — the owner model is decomposing the ask…'));
    try {
      renderPlan(await post('/api/build', requestBody()));
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      clear(preview.body).appendChild(emptyState('The planner refused this ask', e.message, { icon: icon('alert') }));
    } finally {
      planBtn.disabled = false;
    }
  }

  async function queue() {
    // `plan` rides along so the daemon re-parses what we showed rather than
    // asking the owner model a second time (and charging for it twice).
    const r = await post('/api/build', requestBody({ confirm: true, plan: currentPlan }));
    await store.refresh();
    const n = r.queued?.length ?? 0;
    toast.ok(`Queued "${r.epic?.title ?? currentPlan?.epic?.title ?? 'epic'}" — ${n} ticket${n === 1 ? '' : 's'}`);
    const done = clear(preview.body);
    done.appendChild(banner(
      'ok',
      `Epic queued — ${n} ticket${n === 1 ? '' : 's'} admitted`,
      'The scheduler is awake. Tickets start as workers free up, and every finished one lands at its gate.',
    ));
    done.appendChild(actionBar([
      linkButton('#/board', 'Open the board', 'Watch the tickets move through the lanes and approve them as they land.', 'board'),
      button({
        label: 'Plan another',
        icon: 'build',
        variant: 'ghost',
        desc: 'Clear the preview and plan a second epic from a new ask.',
        run: async () => {
          currentPlan = null;
          clear(preview.body).appendChild(emptyState('No plan yet', 'Describe an outcome above and press Plan the epic.', { icon: icon('build') }));
          askIn.focus();
        },
      }),
    ]));
    if (r.epic?.id) done.appendChild(el('p', 'faint', `Epic ${r.epic.id}`));
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void plan();
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });

  const off = store.subscribe(syncEpics);
  syncEpics(store.state);
  if (wantFocus) {
    wantFocus = false;
    askIn.focus();
  }

  return () => {
    off();
    currentPlan = null;
  };
}
