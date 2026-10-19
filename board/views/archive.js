/**
 * views/archive.js — closed work, after it stops being news.
 *
 * The Closed lane answers "what just happened". This answers the two questions
 * the lane cannot, because it would have to be infinitely long to try:
 *
 *   - *what did we finish?* — everything, back to the first run, searchable.
 *   - *how long does work like this actually take?* — the estimate panel, built
 *     from measured durations and costs rather than from a model's guess.
 *
 * The second is the reason the archive stores denormalised actuals rather than
 * pointing at the run and receipt ledgers: those are pruned, and an estimate
 * built on 2025's tickets has to keep working in 2027.
 */
import { add, api, el, emptyState, fmtInt, fmtTime, fmtUsd } from '../lib/dom.js';
import { tip } from '../lib/tooltip.js';
import { chip, input, loadInto, section, table, viewHead } from '../lib/view.js';

export const meta = {
  id: 'archive',
  title: 'Archive',
  icon: 'archive',
  desc: 'Everything that closed more than a week ago — searchable, with what each one actually cost in time and money.',
};

/** Same shape as the CLI's, deliberately: one duration vocabulary, two surfaces. */
function dur(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = ms / 3600000;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

const STATUS_CLS = { done: 'ok', failed: 'bad', rejected: 'bad', canceled: 'bad' };

function estimatePanel(est) {
  const wrap = el('div', 'totals');
  const cell = (label, value, sub, name, desc) => {
    const node = el('div', 'tot');
    node.appendChild(el('div', 'tot-label', label));
    node.appendChild(el('div', 'tot-value', value));
    if (sub) node.appendChild(el('div', 'tot-sub', sub));
    tip(node, name, desc);
    return node;
  };
  wrap.appendChild(cell(
    'typical duration', dur(est.medianDurationMs), `${est.samples} similar`,
    'Median duration',
    'The middle of the matched records, not the mean — one run that hung overnight must not move the number. Records that never ran are excluded here, because they say nothing about how long the work takes.',
  ));
  wrap.appendChild(cell(
    'typical cost', fmtUsd(est.medianCostUsd, 4), 'median',
    'Median cost',
    'What work of this shape has actually cost. Local-only work sits at $0.00 and still reports a real duration.',
  ));
  wrap.appendChild(cell(
    'landed', `${Math.round(est.successRate * 100)}%`, 'reached done',
    'Landing rate',
    'The share of matched records that reached `done`. Canceled and rejected work counts here even though it contributed no duration — whether work of this shape lands is a different question from how long it takes.',
  ));
  wrap.appendChild(cell(
    'repair rounds', String(est.medianRepairs), 'median',
    'Repair rounds',
    'How many times the median ticket of this shape had to go back after a failed review.',
  ));
  return wrap;
}

export function mount(root) {
  root.className = 'view';

  let query = '';

  const search = input({ placeholder: 'Search closed work — or describe what you are about to queue…' });
  search.addEventListener('input', () => {
    query = search.value.trim();
    clearTimeout(search._t);
    // Debounced: every keystroke is a scan plus a ranking pass server-side.
    search._t = setTimeout(() => void refresh(), 220);
  });

  const list = section(
    'Archived work',
    'Closed tasks the board no longer shows. Nothing here was deleted — the record outlives even a prune of the run ledger.',
    { actions: [search] },
  );
  add(root, viewHead(meta.title, meta.desc), list.node);

  const refresh = () => loadInto(list.body, () => api(`/api/archive?limit=60${query ? `&q=${encodeURIComponent(query)}` : ''}`), (data) => {
    const wrap = el('div', 'stack');

    if (!data.records.length) {
      wrap.appendChild(emptyState(
        query ? 'Nothing comparable in the archive' : 'The archive is empty',
        query
          ? 'No closed work matches that. With no comparable history there is nothing honest to estimate from.'
          : 'Closed tasks are folded in here about a week after they close. Run `foreman archive sweep` to fold them in now.',
      ));
      return wrap;
    }

    // The estimate only appears when there is a query, because that is the only
    // time it means anything: "how long does work like THIS take" needs a this.
    if (data.estimate?.samples) {
      wrap.appendChild(el('p', 'lede', `From ${data.estimate.samples} comparable task${data.estimate.samples === 1 ? '' : 's'}:`));
      wrap.appendChild(estimatePanel(data.estimate));
    }

    wrap.appendChild(table(
      [
        { label: 'closed', desc: 'When the task reached its terminal status.' },
        { label: 'status', desc: 'How it ended. Failed and rejected work is kept deliberately — it is half the signal in an estimate.' },
        { label: 'role', desc: 'The playbook role that carried it, which is the single best predictor of how a similar ticket will go.' },
        { label: 'who', desc: 'Whether a model or the operator did the work.' },
        { label: 'took', desc: 'Wall clock from the first run starting to the last one ending. Work that never ran shows a dash.', cls: 'num' },
        { label: 'cost', desc: 'What the task billed in model calls. Local work is free and still shows a real duration.', cls: 'num' },
        { label: 'title', desc: 'What the task was.' },
      ],
      data.records.map((r) => [
        fmtTime(r.closedAt),
        chip(r.status, STATUS_CLS[r.status] ?? ''),
        r.role ?? '—',
        chip(r.assignee, r.assignee === 'human' ? 'human' : ''),
        dur(r.durationMs),
        fmtUsd(r.costUsd, 4),
        r.title,
      ]),
    ));
    wrap.appendChild(el('p', 'lede', `${data.records.length} of ${fmtInt(data.total)} archived.`));
    return wrap;
  });

  void refresh();
  // The view contract wants a teardown or nothing. This view holds no store
  // subscription — it reads once per query — so the only thing worth cleaning
  // up is the search debounce, which would otherwise fire one request into a
  // DOM the router has already cleared.
  return () => clearTimeout(search._t);
}
