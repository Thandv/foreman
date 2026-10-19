/**
 * views/schedules.js — standing work: the tasks, asks and self-improvement
 * runs that fire on a timer instead of a click.
 *
 * The recurrence language is deliberately small ("every 30m", "daily 07:30",
 * "weekly mon 09:00") — full cron would be more expressive than anything
 * Foreman needs and one more way for a batch to fire at 3am when the operator
 * meant 3pm. The three forms are on the field's tip and in its placeholder, so
 * nobody has to guess at a syntax with only three legal shapes.
 */
import { add, api, el, emptyState, fmtAgo, post } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { tip } from '../lib/tooltip.js';
import { toast } from '../lib/toast.js';
import {
  actionBar, button, chip, chipGroup, field, input, loadInto, section, table,
  textarea, viewHead,
} from '../lib/view.js';

export const meta = {
  id: 'schedules',
  title: 'Schedules',
  icon: 'schedules',
  desc: 'Standing work: the tasks, asks and self-improvement runs that fire on a timer instead of a click.',
};

const SPEC_TIP = 'Three forms, and only three: "every 30m" (also 2h, 1d), "daily 07:30", or "weekly mon 09:00". Times are this machine’s local time.';

const ACTIONS = [
  ['task', 'Prompt', 'Queues one task with the prompt below, exactly as if you had typed it into New task.', 'Fires a task'],
  ['ask', 'Ask', 'Sends the text below to the planner, then queues whatever plan comes back. Costs a planning call each time it fires.', 'Fires an ask'],
  ['improve', 'Improve', 'Asks Foreman to propose and queue one improvement to its own codebase from its own evidence. No text needed.', 'Fires a self-improvement run'],
];

/** Relative time for a moment that has not happened yet. */
function fmtIn(ts) {
  if (!ts) return '—';
  const s = Math.round((Number(ts) - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

export function mount(root) {
  root.className = 'view';

  const list = section('Standing schedules', 'Everything the daemon fires on its own. A paused schedule keeps its definition and stops firing.');
  const add_ = section('Add a schedule', 'What to fire, and how often. Nothing runs until the first window comes round.');
  add(root, viewHead(meta.title, meta.desc), list.node, add_.node);

  // -------------------------------------------------------------- the list

  const refresh = () => loadInto(list.body, () => api('/api/schedules'), (data) => {
    if (!data.schedules.length) {
      return emptyState(
        'Nothing scheduled',
        'Standing work goes here — a nightly digest, a weekly consolidation, a daily improvement run. Add one below.',
        { icon: icon('schedules') },
      );
    }
    const rows = data.schedules.map((s) => {
      const enabled = Number(s.enabled) === 1;
      const actions = el('div', 'row');
      actions.appendChild(button({
        label: enabled ? 'Pause' : 'Resume',
        icon: enabled ? 'ban' : 'check',
        variant: 'sm',
        desc: enabled
          ? 'Stop this firing without deleting it. The definition is kept and the clock restarts when you resume.'
          : 'Start firing again. The next run is scheduled from now, not from the window it missed while paused.',
        run: async () => { await post(`/api/schedules/${s.id}/toggle`); await refresh(); },
        ok: enabled ? `Paused "${s.title}"` : `Resumed "${s.title}"`,
      }));
      actions.appendChild(button({
        label: 'Delete',
        icon: 'trash',
        variant: 'sm danger',
        desc: 'Remove this schedule for good. Tasks it has already queued are untouched.',
        run: async () => {
          await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
          await refresh();
        },
        ok: `Deleted "${s.title}"`,
      }));

      const kind = ACTIONS.find(([v]) => v === (s.action ?? 'task'));
      return [
        s.title,
        chip(kind?.[1] ?? String(s.action), 'chip-role', kind?.[3] ?? 'Schedule action', kind?.[2] ?? 'What this schedule fires.'),
        s.spec,
        enabled ? fmtIn(s.next_run_at) : '—',
        s.last_run_at ? fmtAgo(s.last_run_at) : 'never',
        enabled
          ? chip('enabled', 'ok', 'Enabled', 'This schedule fires at its next window.')
          : chip('paused', null, 'Paused', 'This schedule is kept but will not fire until you resume it.'),
        actions,
      ];
    });
    return table(
      [
        { label: 'title', desc: 'What this schedule is called. Tasks it queues are named after it.' },
        { label: 'fires', desc: 'What happens when the window comes round: a task, an ask, or a self-improvement run.' },
        { label: 'spec', desc: SPEC_TIP },
        { label: 'next run', desc: 'When it fires next. A missed window (a laptop asleep overnight) fires once on wake, not once per window elapsed.' },
        { label: 'last run', desc: 'When it last fired.' },
        { label: 'state', desc: 'Whether it is armed or paused.' },
        { label: '', cls: 'act' },
      ],
      rows,
    );
  });

  // --------------------------------------------------------------- the form

  const titleIn = input({ placeholder: 'Nightly digest', required: true });
  const specIn = input({ placeholder: 'daily 07:30', required: true });
  const repoIn = input({ placeholder: '/Users/you/Projects/thing' });
  const bodyIn = textarea({ rows: 3, placeholder: 'Summarise yesterday’s commits and open questions.' });

  const bodyField = field('Prompt', 'Exactly what the worker is told to do each time this fires.', bodyIn);
  const kind = chipGroup(ACTIONS, 'task', (value) => {
    bodyField.hidden = value === 'improve';
    const label = bodyField.querySelector('.label span');
    if (label) label.textContent = value === 'ask' ? 'Ask' : 'Prompt';
    tip(
      bodyField,
      value === 'ask' ? 'Ask' : 'Prompt',
      value === 'ask'
        ? 'The outcome to hand the planner each time this fires. It plans, then queues what it planned.'
        : 'Exactly what the worker is told to do each time this fires.',
      { place: 'right' },
    );
  });

  const err = el('p', 'err-text');
  err.hidden = true;

  const form = el('form', 'form-grid');
  form.id = 'scheduleForm';
  add(
    form,
    add(
      el('div', 'grid-2'),
      field('Title', 'What to call this schedule. It names the tasks it queues, so make it read like a job.', titleIn),
      field('When', SPEC_TIP, specIn, { hint: 'every 30m · daily 07:30 · weekly mon 09:00' }),
    ),
    field('Fires', 'What this schedule does when its window comes round.', kind.node),
    bodyField,
    field('Repo', 'Absolute path to a git repo, for work that needs a worktree.', repoIn, { hint: 'optional' }),
    err,
  );

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.setAttribute('form', 'scheduleForm');
  add(submit, icon('plus'), el('span', null, 'Add schedule'));
  tip(submit, 'Add schedule', 'Arms this schedule. The first run happens at the next matching window, not now.');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      err.hidden = true;
      submit.disabled = true;
      const title = titleIn.value.trim();
      const text = bodyIn.value.trim();
      try {
        await post('/api/schedules', {
          title,
          spec: specIn.value.trim(),
          action: kind.value,
          repo: repoIn.value.trim() || null,
          ask: kind.value === 'ask' ? text : null,
          // 'task' schedules queue from a template; the other two do not use one.
          template: kind.value === 'task' ? { title, prompt: text } : undefined,
        });
        titleIn.value = '';
        specIn.value = '';
        bodyIn.value = '';
        toast.ok(`Scheduled "${title}"`);
        await refresh();
      } catch (e2) {
        err.textContent = e2.message;
        err.hidden = false;
      } finally {
        submit.disabled = false;
      }
    })();
  });

  add(add_.body, form, actionBar([submit]));

  void refresh();

  // "in 4m" has to keep counting down without an event to prompt it.
  const ticker = setInterval(() => void refresh(), 60_000);
  return () => clearInterval(ticker);
}
