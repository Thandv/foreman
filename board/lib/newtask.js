/**
 * newtask.js — the global "New task" modal.
 *
 * Every field POST /api/tasks accepts from the board is here, and every one of
 * them carries a tip explaining what it actually changes about the run. The
 * old two-column dialog exposed eight of the twelve and explained none.
 */
import { add, api, el, post } from './dom.js';
import { icon } from './icons.js';
import { modal, cancelButton } from './modal.js';
import { tip } from './tooltip.js';
import { toast } from './toast.js';
import { store } from './store.js';

/** [name, label, description] — the description is the tip's second line. */
const FIELD_TIPS = {
  title: ['Title', 'One line naming the work. This is what the card and the command palette show.'],
  prompt: ['Prompt', 'Everything the worker is told to do. It sees this and nothing else, so say what "done" means.'],
  kind: ['Kind', 'What sort of work this is. A code task is cut into its own git worktree; the others run without one.'],
  runner: ['Runner', 'Which engine executes the task — echo is the free demo loop, shell runs the prompt as a command, the agent runners drive a coding CLI.'],
  repo: ['Repo', 'Absolute path to a git repo. Foreman cuts a fresh worktree and branch from it — your working tree is never touched.'],
  sensitivity: ['Sensitivity', 'S0 public, S1 normal, S2 local-only. S2 refuses every cloud model call for this task.'],
  priority: ['Priority', 'Higher goes first when a worker frees up. Equal priorities run in queue order.'],
  budgetUsd: ['Budget', 'Hard ceiling in USD on this task’s model spend. Leave blank to use the daily cap alone.'],
  testCmd: ['Test command', 'Shell command run inside the jail at the test stage. A non-zero exit fails the run before it ever reaches your gate.'],
  role: ['Role', 'Which playbook role does the work. The role picks the model tier — owner, senior or worker.'],
  playbook: ['Playbook', 'The domain org chart: roles, review chain, domain checks and gate policy applied to this task.'],
  deps: ['Depends on', 'Comma-separated task ids. This task stays blocked until every one of them finishes.'],
};

function field(name, control, { hint } = {}) {
  const [label, desc] = FIELD_TIPS[name];
  const wrap = el('label', 'field');
  const head = el('span', 'label');
  head.appendChild(el('span', null, label));
  if (hint) head.appendChild(el('span', 'hint', hint));
  // The tip hangs off the whole field, so hovering the label or the input
  // both explain it — a user reaching for a control gets the answer either way.
  tip(wrap, label, desc, { place: 'right' });
  add(wrap, head, control);
  return wrap;
}

function select(name, options, value) {
  const s = el('select');
  s.name = name;
  for (const [v, label] of options) {
    const o = el('option', null, label);
    o.value = v;
    s.appendChild(o);
  }
  if (value) s.value = value;
  return s;
}

function input(name, { placeholder, type, value } = {}) {
  const i = el('input');
  i.name = name;
  if (type) i.type = type;
  if (placeholder) i.placeholder = placeholder;
  if (value !== undefined) i.value = value;
  return i;
}

/** Open the modal. Resolves once it closes; the task is queued as a side effect. */
export async function openNewTask(prefill = {}) {
  // Runners and playbooks are read from the daemon rather than hard-coded, so
  // a newly forged playbook shows up here without a board change.
  const [runners, catalog] = await Promise.all([
    api('/api/runners').catch(() => ({ runners: ['echo', 'shell'] })),
    api('/api/playbooks').catch(() => ({ playbooks: [] })),
  ]);

  const m = modal({
    title: 'Queue a task',
    sub: 'One worker, one jail, one gate at the end. Hover any field to see what it changes.',
    wide: true,
  });

  const form = el('form', 'form-grid');
  form.id = 'newTaskForm';

  const titleIn = input('title', { placeholder: 'Fix the flaky auth test', value: prefill.title ?? '' });
  titleIn.required = true;
  const promptIn = el('textarea');
  promptIn.name = 'prompt';
  promptIn.rows = 5;
  promptIn.required = true;
  promptIn.placeholder = 'What the worker should do, and what counts as done.';
  promptIn.value = prefill.prompt ?? '';

  const kindSel = select('kind', [
    ['general', 'general'], ['code', 'code'], ['writing', 'writing'],
    ['research', 'research'], ['tool', 'tool'],
  ], prefill.kind ?? 'general');
  const runnerSel = select('runner', (runners.runners ?? []).map((r) => [r, r]), prefill.runner ?? 'echo');
  const sensSel = select('sensitivity', [
    ['S1', 'S1 — normal'], ['S0', 'S0 — public'], ['S2', 'S2 — local models only'],
  ], prefill.sensitivity ?? 'S1');

  const playbooks = catalog.playbooks ?? [];
  const pbSel = select('playbook', [['', '— none —'], ...playbooks.map((p) => [p.id, p.id])], prefill.playbook ?? '');

  // Roles come from the chosen playbook but stay free text: the API accepts
  // any role string, and pinning the input to a select would make an ad-hoc
  // role impossible to type.
  const roleIn = input('role', { placeholder: 'dev, editor, analyst…', value: prefill.role ?? '' });
  const roleList = el('datalist');
  roleList.id = 'roleOptions';
  roleIn.setAttribute('list', 'roleOptions');
  const syncRoles = () => {
    roleList.textContent = '';
    const pb = playbooks.find((p) => p.id === pbSel.value);
    for (const r of Object.keys(pb?.roles ?? {})) {
      const o = el('option');
      o.value = r;
      roleList.appendChild(o);
    }
  };
  pbSel.addEventListener('change', syncRoles);
  syncRoles();

  const err = el('p', 'err-text');
  err.hidden = true;

  add(
    form,
    field('title', titleIn),
    field('prompt', promptIn),
    add(el('div', 'grid-3'), field('kind', kindSel), field('runner', runnerSel), field('sensitivity', sensSel)),
    field('repo', input('repo', { placeholder: '/Users/you/Projects/thing', value: prefill.repo ?? '' }), { hint: 'code tasks' }),
    add(
      el('div', 'grid-3'),
      field('playbook', pbSel),
      field('role', roleIn),
      field('priority', input('priority', { type: 'number', value: String(prefill.priority ?? 0) })),
    ),
    add(
      el('div', 'grid-2'),
      field('budgetUsd', input('budgetUsd', { type: 'number', placeholder: 'e.g. 2.50' }), { hint: 'USD, optional' }),
      field('testCmd', input('testCmd', { placeholder: 'npm test' }), { hint: 'optional' }),
    ),
    field('deps', input('deps', { placeholder: 't_ab12cd, t_ef34gh' }), { hint: 'optional' }),
    roleList,
    err,
  );
  m.body.appendChild(form);

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.setAttribute('form', 'newTaskForm');
  add(submit, icon('plus'), el('span', null, 'Add to queue'));
  tip(submit, 'Add to queue', 'Creates the task and wakes the scheduler; it starts as soon as a worker is free.', { keys: ['⌘', 'Enter'] });
  m.foot.append(cancelButton(m), submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    const fd = new FormData(form);
    const str = (k) => String(fd.get(k) ?? '').trim();
    const num = (k) => {
      const v = str(k);
      return v === '' ? null : Number(v);
    };
    try {
      const task = await post('/api/tasks', {
        title: str('title'),
        prompt: str('prompt'),
        kind: str('kind'),
        runner: str('runner'),
        sensitivity: str('sensitivity'),
        repo: str('repo') || null,
        role: str('role') || null,
        playbook: str('playbook') || null,
        priority: num('priority') ?? 0,
        budgetUsd: num('budgetUsd'),
        testCmd: str('testCmd') || null,
        deps: str('deps').split(',').map((s) => s.trim()).filter(Boolean),
      });
      m.close('added');
      toast.ok(`Queued "${task.title}"`);
      await store.refresh();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      submit.disabled = false;
    }
  });

  // ⌘/Ctrl-Enter submits from anywhere in the form, including the textarea.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });

  m.open();
  titleIn.focus();
}
