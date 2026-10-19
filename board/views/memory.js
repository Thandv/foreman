/**
 * views/memory.js — what Foreman believes, and how sure it is.
 *
 * Facts carry a key prefix that says what *kind* of belief they are, and the
 * kinds behave very differently: an episode is one run's raw outcome, a
 * preference is something the operator taught it, and an `epic:` retro is a
 * crew retrospective the planner reads back as precedent on the next epic in
 * that domain. They all live in one table, so the kind is a chip on every row
 * rather than four tables that would hide how few of each there are.
 */
import { add, api, el, emptyState, fmtAgo, post } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { tip } from '../lib/tooltip.js';
import {
  actionBar, button, chip, expandable, field, input, loadInto, section, select, table, textarea, viewHead,
} from '../lib/view.js';

export const meta = {
  id: 'memory',
  title: 'Memory',
  icon: 'memory',
  desc: 'What Foreman believes about your repos and your preferences, and how sure it is about each of it.',
};

/** key prefix → [chip label, chip class, tip name, tip description]. */
const KINDS = [
  ['epic:', 'retro', 'chip-role', 'Crew retrospective', 'What a finished epic taught, keyed by playbook. The planner reads these back as precedent the next time it decomposes an ask in the same domain — which is how a second epic costs fewer planning tokens than the first.'],
  ['episode:', 'episode', null, 'Episode', 'One run’s raw outcome, written at low confidence because a single run is weak evidence. Consolidation is what promotes the patterns that repeat.'],
  ['preference:', 'preference', 'gate', 'Preference', 'Something the operator taught it — a standing instruction rather than an observation.'],
];

function kindChip(key) {
  const match = KINDS.find(([prefix]) => key.startsWith(prefix));
  if (!match) return chip('fact', null, 'Durable fact', 'A semantic fact: something consolidation concluded, or something added by hand.');
  const [, label, cls, name, desc] = match;
  return chip(label, cls, name, desc);
}

function confidenceCell(value) {
  const n = Number(value ?? 0);
  const node = el('span', n >= 0.8 ? 'ok' : n < 0.4 ? 'faint' : null, n.toFixed(2));
  tip(node, 'Confidence', 'How strongly this is believed, 0 to 1. Repeated confirmation raises it; a contradicting write retires the old fact and starts the new one lower.');
  return node;
}

export function mount(root) {
  root.className = 'view';

  let scope = 'global';

  const scopeSel = select([['global', 'global']], 'global');
  const facts = section('Facts', 'Live beliefs for this scope. Global facts are always folded in, whichever workspace you pick.');

  const scopeField = el('label', 'field');
  const scopeLabel = el('span', 'label');
  scopeLabel.appendChild(el('span', null, 'Scope'));
  scopeLabel.appendChild(el('span', 'hint', 'workspace'));
  tip(scopeField, 'Scope', 'Which workspace’s memory to read. A scope is usually a repo path. Global facts apply everywhere and are always included in the list below.', { place: 'right' });
  add(scopeField, scopeLabel, scopeSel);

  const consolidateBtn = button({
    label: 'Consolidate',
    icon: 'bolt',
    desc: 'Compact episodes into durable facts; refuses to retire what it could not compact. Runs on a local model only — the run log it reads may quote private work.',
    run: async () => {
      const r = await post('/api/memory/consolidate', { scope });
      await refresh();
      return r;
    },
    ok: (r) => (r.factsWritten
      ? `Wrote ${r.factsWritten} fact(s) from ${r.episodesRead} episode(s), retired ${r.retired}`
      : `Nothing consolidated — ${r.reason || 'no usable facts'}`),
  });

  const controls = el('div', 'row');
  controls.appendChild(scopeField);
  controls.appendChild(actionBar([consolidateBtn]));

  // ----------------------------------------------------------- remember form
  // The operator's write path. Everything else in this table is written by
  // runs or consolidation; this is how a standing instruction — a canon lock,
  // a house rule — gets in *before* the first run instead of being learned
  // the expensive way. Same POST the CLI's `memory add` uses.
  const keyIn = input({ placeholder: 'preference:canon.oswin-age' });
  const valueIn = textarea({ rows: 2, placeholder: 'Oswin is thirty-eight to forty-three across Book Three; time advances only at Part boundaries.' });
  const scopeIn = input({ placeholder: 'global, or a repo path' });
  const confIn = input({ type: 'number', placeholder: '0.9' });
  confIn.step = '0.05';
  confIn.min = '0';
  confIn.max = '1';

  const rememberBtn = button({
    label: 'Remember',
    icon: 'plus',
    variant: 'primary',
    desc: 'Write this fact now, as you, at the confidence given. Writing the same key again supersedes the old value — belief revision, not a duplicate row.',
    run: async () => {
      const key = keyIn.value.trim();
      const value = valueIn.value.trim();
      if (!key || !value) throw new Error('key and value are both required');
      const target = scopeIn.value.trim() || scope;
      await post('/api/memory', {
        scope: target,
        key,
        value,
        confidence: confIn.value.trim() === '' ? undefined : Number(confIn.value),
      });
      keyIn.value = '';
      valueIn.value = '';
      if (target !== scope) {
        scope = target;
        scopeSel.value = scope;
      }
      await refresh();
      return key;
    },
    ok: (key) => `Remembered "${key}"`,
  });

  const rememberForm = el('div', 'form-grid');
  add(
    rememberForm,
    add(
      el('div', 'grid-2'),
      field('Key', 'The stable name for this belief. A `preference:` prefix marks it as something you taught it — recall ranks preferences above episodes. Writing the same key again supersedes the old value.', keyIn),
      field('Scope', 'Which workspace this belongs to — usually a repo path, so it is recalled for work in that repo. Blank writes to the scope selected above. Global applies everywhere.', scopeIn, { hint: 'optional' }),
    ),
    field('Value', 'The belief itself: one sentence a future worker can act on without you in the room.', valueIn),
    field('Confidence', 'How strongly to hold it, 0 to 1. Operator facts default high; leave blank for the default.', confIn, { hint: 'optional' }),
  );
  const remember = section('Remember a fact', 'Teach it something before the first run — a canon lock, a standing constraint, a house rule. Workers recall these ranked above anything they learned on their own.');
  remember.body.appendChild(rememberForm);
  remember.body.appendChild(actionBar([rememberBtn]));

  add(root, viewHead(meta.title, meta.desc), controls, remember.node, facts.node);

  function syncScopes(scopes) {
    const all = ['global', ...scopes.filter((s) => s !== 'global')];
    if (all.length === scopeSel.options.length && all.every((s, i) => scopeSel.options[i].value === s)) return;
    scopeSel.textContent = '';
    for (const s of all) {
      const o = el('option', null, s);
      o.value = s;
      scopeSel.appendChild(o);
    }
    scopeSel.value = all.includes(scope) ? scope : 'global';
  }

  const refresh = () => loadInto(
    facts.body,
    () => api(`/api/memory?scope=${encodeURIComponent(scope)}`),
    (data) => {
      syncScopes(data.scopes ?? []);
      if (!data.facts.length) {
        return emptyState(
          'Nothing remembered here yet',
          'Facts arrive two ways: a finished run writes an episode, and consolidation compacts those episodes into something durable. Run some work, then consolidate.',
          { icon: icon('memory') },
        );
      }
      const rows = data.facts.map((fact) => [
        kindChip(fact.key),
        fact.key,
        expandable(fact.value, 120),
        confidenceCell(fact.confidence),
        fact.source ?? '—',
        fmtAgo(fact.updatedAt),
        button({
          label: 'Forget',
          icon: 'trash',
          variant: 'sm danger',
          desc: 'Retire this fact. It stops being read into any prompt; the row is kept as history, not deleted.',
          run: async () => {
            await api(`/api/memory/${fact.id}`, { method: 'DELETE' });
            await refresh();
          },
          ok: `Forgot "${fact.key}"`,
        }),
      ]);
      return table(
        [
          { label: 'kind', desc: 'What sort of belief this is — read off the key prefix.' },
          { label: 'key', desc: 'The stable name for this belief. Writing the same key again supersedes the old value rather than adding a second one.' },
          { label: 'value', desc: 'The belief itself: one sentence a future worker can act on.' },
          { label: 'confidence', desc: 'How strongly it is held, 0 to 1.', cls: 'num' },
          { label: 'source', desc: 'Who wrote it — a run, consolidation, or you.' },
          { label: 'revised', desc: 'When this value was last written or confirmed.' },
          { label: '', cls: 'act' },
        ],
        rows,
      );
    },
  );

  scopeSel.addEventListener('change', () => {
    scope = scopeSel.value;
    void refresh();
  });

  void refresh();
  return undefined;
}
