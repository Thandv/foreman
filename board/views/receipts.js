/**
 * views/receipts.js — the spend ledger.
 *
 * One request answers all four panels (GET /api/receipts returns the totals,
 * both breakdowns and the tail of the rows), so nothing here re-derives a
 * number the daemon already computed — the view cannot disagree with the
 * topbar about what today cost.
 *
 * The interesting column is `kind`, because it is the only place that says what
 * the money bought: a plan call is the owner decomposing an ask, a review call
 * is a crew reviewer reading finished work, a gate call is the owner deciding
 * whether to sign something off. Each one carries that as a tip.
 */
import { add, api, el, emptyState, fmtInt, fmtTime, fmtUsd } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { tip } from '../lib/tooltip.js';
import { chip, chipGroup, loadInto, section, table, viewHead } from '../lib/view.js';

export const meta = {
  id: 'receipts',
  title: 'Receipts',
  icon: 'receipts',
  desc: 'The spend ledger: what today cost, who charged for it, what it bought, and how close you are to the cap.',
};

/**
 * kind → what that call actually was. Kinds are `base` or `base:variant` (and
 * the council uses `council@lane`), so an unknown variant still resolves to its
 * base rather than showing nothing.
 */
const KIND_TIPS = {
  plan: 'Owner decomposition — turning one ask into an epic and its tickets.',
  'plan:classify': 'Picking which playbook an ask belongs to, before any decomposition happens.',
  'plan:check': 'The senior critique of a plan: a devil’s advocate pass over the decomposition before anything is queued.',
  review: 'A crew reviewer reading finished work against the playbook’s review chain.',
  'review:chair': 'The escalation chair breaking a split review.',
  'review:cache': 'A repeat review served from cache — recorded for the trail, charged nothing new.',
  'review:unavailable': 'A reviewer that could not be reached. Logged so an absent reviewer never looks like a pass.',
  'review:incomplete': 'A review chain that lost a reviewer. If the rest passed, there is no crew verdict and the council verdict stands; a surviving FAIL goes on as the chain’s verdict (a chair may still rule on it). Logged so a partial review never looks like a full one.',
  council: 'A council advisor voting on a finished run.',
  chair: 'The council chair ruling on a split vote.',
  gate: 'The owner gate deciding whether to sign a finished run off without you.',
  improve: 'Foreman proposing a change to its own codebase from its own evidence.',
  memory: 'Consolidation — compacting a scope’s episodes into durable facts.',
  forge: 'Drafting a new playbook from a domain description.',
  bench: 'A benchmark probe measuring a model’s speed and accuracy.',
  tool: 'Building or calling a forged tool.',
  agent: 'An api-runner turn: the model actually doing the task.',
  'align-judge': 'Judging whether a proposed alignment change is safe to adopt.',
  code: 'The work itself, on a code task.',
  writing: 'The work itself, on a writing task.',
  research: 'The work itself, on a research task.',
  general: 'The work itself, on a general task.',
};

function kindTip(kind) {
  if (KIND_TIPS[kind]) return KIND_TIPS[kind];
  const base = String(kind).split(/[:@]/)[0];
  const suffix = String(kind).includes(':error')
    ? ' This one failed: the attempt is billed because the tokens were spent.'
    : String(kind).includes(':cache')
      ? ' Served from cache — recorded, not re-charged.'
      : '';
  return `${KIND_TIPS[base] ?? 'A model call the daemon made.'}${suffix}`;
}

function total(label, value, sub, cls, name, desc) {
  const node = el('div', `tot ${cls ?? ''}`.trim());
  node.appendChild(el('div', 'tot-label', label));
  node.appendChild(el('div', 'tot-value', value));
  if (sub) node.appendChild(el('div', 'tot-sub', sub));
  tip(node, name ?? label, desc);
  return node;
}

function groupTable(rows, firstLabel, firstDesc, tipFor) {
  return table(
    [
      { label: firstLabel, desc: firstDesc },
      { label: 'calls', desc: 'How many model calls fell into this bucket.', cls: 'num' },
      { label: 'cost', desc: 'What the bucket cost. Local models are free, so a busy local row can sit at $0.000.', cls: 'num' },
      { label: 'in', desc: 'Prompt tokens sent.', cls: 'num' },
      { label: 'out', desc: 'Tokens generated back.', cls: 'num' },
    ],
    rows.map((r) => {
      const name = el('span', null, r.name);
      if (tipFor) tip(name, r.name, tipFor(r.name));
      return [name, fmtInt(r.calls), fmtUsd(r.costUsd, 4), fmtInt(r.tokensIn), fmtInt(r.tokensOut)];
    }),
  );
}

export function mount(root) {
  root.className = 'view';

  let day = 'today';

  const window_ = chipGroup(
    [
      ['today', 'Today', 'Only calls billed today — the window the daily cap applies to.', 'Today'],
      ['all', 'All time', 'Every call ever recorded, back to the first run. The cap does not apply to this window.', 'All time'],
    ],
    'today',
    (v) => { day = v; void refresh(); },
  );

  const ledger = section('Ledger', 'Every model call the daemon has billed, and what each one bought.', { actions: [window_.node] });
  add(root, viewHead(meta.title, meta.desc), ledger.node);

  const refresh = () => loadInto(ledger.body, () => api(`/api/receipts?day=${day}&limit=50`), (data) => {
    const wrap = el('div', 'stack');
    const t = data.totals;
    const cap = Number(data.dailyCapUsd || 0);
    const ratio = cap > 0 && day === 'today' ? t.costUsd / cap : null;
    const localShare = t.calls ? Math.round((t.localCalls / t.calls) * 100) : 0;

    const totals = el('div', 'totals');
    totals.appendChild(total(
      'cost',
      fmtUsd(t.costUsd, 4),
      day === 'today' && cap > 0 ? `of ${fmtUsd(cap, 2)} cap` : 'all time',
      ratio == null ? '' : ratio >= 1 ? 'over' : ratio >= 0.8 ? 'hot' : 'ok',
      'Model spend',
      day === 'today'
        ? 'What today’s calls cost, against the daily cap. Past the cap the broker refuses new cloud calls rather than billing on.'
        : 'What every recorded call has cost since the first run. The daily cap does not apply to this window.',
    ));
    totals.appendChild(total('calls', fmtInt(t.calls), `${fmtInt(t.calls - t.localCalls)} cloud`, null, 'Model calls', 'How many times a model was asked anything at all, including the ones that returned an error.'));
    totals.appendChild(total(
      'local share',
      `${localShare}%`,
      `${fmtInt(t.localCalls)} local`,
      localShare >= 80 ? 'ok' : null,
      'Local share',
      'The fraction of calls that never left this machine. Local calls are free and S2-safe, so a high share is the goal, not a compromise.',
    ));
    totals.appendChild(total('tokens', fmtInt(t.tokensIn + t.tokensOut), `${fmtInt(t.tokensIn)} in · ${fmtInt(t.tokensOut)} out`, null, 'Tokens', 'Prompt tokens plus generated tokens. Context caps are what keep the first number from growing with the size of a repo.'));
    wrap.appendChild(totals);

    if (!t.calls) {
      wrap.appendChild(emptyState(
        day === 'today' ? 'Nothing billed today' : 'No model calls recorded',
        'Every call a task makes is written here as it happens — plans, reviews, gate decisions and the work itself.',
        { icon: icon('receipts') },
      ));
      return wrap;
    }

    const byProvider = el('div', 'stack');
    const pTitle = el('div', 'section-title', 'By provider');
    tip(pTitle, 'By provider', 'Who was actually asked. An ollama row is a model running on this machine; anything else left it.');
    byProvider.appendChild(pTitle);
    byProvider.appendChild(groupTable(data.byProvider, 'provider', 'The service that ran the model.', (name) => (name === 'ollama'
      ? 'Local inference on this machine. Free, and the only thing an S2 task is allowed to use.'
      : 'A cloud provider. Billed per token, and refused outright for S2 work.')));
    wrap.appendChild(byProvider);

    const byKind = el('div', 'stack');
    const kTitle = el('div', 'section-title', 'By kind');
    tip(kTitle, 'By kind', 'What the money bought. This is the breakdown that tells you whether you are paying for work or for deliberation about work.');
    byKind.appendChild(kTitle);
    byKind.appendChild(groupTable(data.byKind, 'kind', 'What sort of call it was. Hover any row to see what that kind does.', kindTip));
    wrap.appendChild(byKind);

    const recent = el('div', 'stack');
    const rTitle = el('div', 'section-title', `Recent calls — last ${data.recent.length}`);
    tip(rTitle, 'Recent calls', 'The tail of the ledger, newest first. Each row is one model call, billed to the task that caused it.');
    recent.appendChild(rTitle);
    recent.appendChild(table(
      [
        { label: 'time', desc: 'When the call was made.' },
        { label: 'kind', desc: 'What the call was for.' },
        { label: 'model', desc: 'The model that answered.' },
        { label: 'where', desc: 'Local means it never left this machine; cloud means it did.' },
        { label: 'task', desc: 'The task this call is billed to. Blank rows are daemon-level work — a bench, a consolidation, a forge.' },
        { label: 'in', desc: 'Prompt tokens.', cls: 'num' },
        { label: 'out', desc: 'Generated tokens.', cls: 'num' },
        { label: 'cost', desc: 'What this single call cost.', cls: 'num' },
        { label: 'ms', desc: 'Wall-clock latency of the call.', cls: 'num' },
      ],
      data.recent.map((r) => {
        const kindCell = el('span', null, r.kind);
        tip(kindCell, r.kind, kindTip(r.kind));
        return [
          fmtTime(r.created_at),
          kindCell,
          r.model,
          Number(r.local)
            ? chip('local', 'ok', 'Local', 'Ran on this machine. Free, and allowed for S2 work.')
            : chip('cloud', 'split', 'Cloud', 'Left this machine. Billed per token, and refused for S2 work.'),
          r.task_id ?? '—',
          fmtInt(r.tokens_in),
          fmtInt(r.tokens_out),
          fmtUsd(r.cost_usd, 4),
          fmtInt(r.latency_ms),
        ];
      }),
    ));
    wrap.appendChild(recent);
    return wrap;
  });

  void refresh();
  return undefined;
}
