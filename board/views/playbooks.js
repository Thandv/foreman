/**
 * views/playbooks.js — the domain org charts, the forge that drafts new ones,
 * and the approval desk for the drafts.
 *
 * The catalog half is a reference card: for each installed playbook, which
 * roles exist and what model tier each one buys, who reviews whom and in what
 * style, who chairs an escalation, what runs at the test stage, who holds the
 * gate, and which rules are injected into every ticket prompt.
 *
 * The pending half is a security surface, and is laid out like one. A forged
 * draft is a *proposal* written by a model; approving it installs a file that
 * decides, from then on, who signs work off. So a pending card leads with the
 * four fields that could hand autonomy to a machine — gate.default, the
 * hard-human list, the shell checks and the constraints — and only then shows
 * the rest. Nothing installs itself: approve is the one human action.
 */
import { add, api, clear, el, emptyState, post, scrollIntoViewSmooth } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { store } from '../lib/store.js';
import { tip } from '../lib/tooltip.js';
import { toast } from '../lib/toast.js';
import {
  actionBar, banner, button, chip, chipRow, field, input, kvs, loadInto,
  section, table, textarea, viewHead,
} from '../lib/view.js';

export const meta = {
  id: 'playbooks',
  title: 'Playbooks',
  icon: 'playbooks',
  desc: 'The domain org charts: which roles exist, who reviews whom, what checks run and who holds the gate.',
};

/** What a reviewer style actually does to the work it is handed. */
const STYLE_TIPS = {
  'code-review': 'Reads the diff like a colleague would: correctness, edge cases, tests, and whether the change does what the ticket asked.',
  'editorial-letter': 'Responds to the whole piece before the sentences: structure, pacing, character and argument, the way a developmental editor writes back.',
  'devils-advocate': 'Argues against the work; it passes only if the case against it fails.',
  'peer-review': 'Judges method and evidence the way a journal referee would: is the claim supported, is it reproducible, is anything overstated.',
};

const TIER_TIPS = {
  owner: 'Owner tier — the strongest, most expensive model. Reserved for decomposition, chairing and gate decisions.',
  senior: 'Senior tier — the review-grade model. Critiques plans and finished work.',
  worker: 'Worker tier — the everyday model that does the work itself.',
};

let wantForge = false;
export function requestForge() { wantForge = true; }

// ------------------------------------------------------------------- pieces

/**
 * tier → the model that tier actually resolved to.
 *
 * The daemon resolves this from environment (FOREMAN_MODEL_OWNER/SENIOR/WORKER)
 * and never exposes the mapping directly — but it *does* stamp every task in
 * the snapshot with its resolved model. So the answer is read back off the
 * tasks that have run: find one whose playbook role sits at each tier and take
 * the model it resolved to. Tasks pinned to an agent are skipped, since an
 * agent's own model overrides the tier and would report the wrong answer.
 */
function tierModels(tasks, playbooks) {
  const byId = new Map(playbooks.map((p) => [p.id, p]));
  const out = new Map();
  for (const t of tasks) {
    if (!t.model || t.agent || !t.playbook || !t.role) continue;
    const tier = byId.get(t.playbook)?.roles?.[t.role]?.tier;
    if (tier && !out.has(tier)) out.set(tier, t.model);
  }
  return out;
}

function rolesTable(playbook, models) {
  return table(
    [
      { label: 'role', desc: 'The name a ticket carries. The planner assigns every ticket one of these.' },
      { label: 'tier', desc: 'Which class of model the role buys: owner, senior or worker.' },
      { label: 'resolved model', desc: 'What this tier resolved to on the last task that ran at it. A dash means nothing has run at this tier yet — the tier is still what decides, the daemon just has not been observed spending it.' },
    ],
    Object.entries(playbook.roles).map(([role, def]) => [
      role,
      chip(def.tier, def.tier === 'owner' ? 'gate' : def.tier === 'senior' ? 'chip-role' : null, `${def.tier} tier`, TIER_TIPS[def.tier]),
      models?.get(def.tier) ?? '—',
    ]),
  );
}

function reviewChain(playbook) {
  if (!playbook.reviewers.length) {
    return el('div', 'card-desc', 'No review chain — finished work goes straight to the gate.');
  }
  const row = el('div', 'row');
  playbook.reviewers.forEach((r, i) => {
    if (i) row.appendChild(el('span', 'faint', '→'));
    const box = el('span', 'row');
    box.appendChild(el('span', null, r.role));
    box.appendChild(chip(r.style, 'chip-role', `Style: ${r.style}`, STYLE_TIPS[r.style] ?? 'A review style this playbook applies.'));
    row.appendChild(box);
  });
  return row;
}

function safetyBlock(playbook) {
  const wrap = el('div', 'stack');

  const gateRow = el('div', 'row');
  gateRow.appendChild(chip(
    `gate: ${playbook.gate.default}`,
    playbook.gate.default === 'owner' ? 'split' : 'ok',
    `Gate default: ${playbook.gate.default}`,
    playbook.gate.default === 'owner'
      ? 'The owner model may sign finished work off without you — but only work that came back green.'
      : 'Every finished ticket waits for a human click. Nothing merges on its own.',
  ));
  for (const h of playbook.gate.hardHuman) {
    gateRow.appendChild(chip(h, 'gate', `Always human: ${h}`, 'A condition the owner gate is never allowed to sign: this always comes back to you, whatever the gate default says.'));
  }
  if (!playbook.gate.hardHuman.length) {
    gateRow.appendChild(chip('no hard-human list', 'bad', 'No hard-human conditions', 'Nothing is carved out as always-human. Under an owner gate that means every category of work is machine-signable.'));
  }
  wrap.appendChild(gateRow);

  const checks = el('div', 'row');
  const checksLabel = el('span', 'faint', 'checks:');
  tip(checksLabel, 'Domain checks', 'Shell commands run inside the jail at the test stage, after the ticket’s own test command. A non-zero exit fails the ticket.');
  checks.appendChild(checksLabel);
  if (playbook.checks.length) {
    for (const c of playbook.checks) checks.appendChild(el('code', 'mono', c));
  } else {
    checks.appendChild(el('span', 'faint', 'none'));
  }
  wrap.appendChild(checks);

  if (playbook.proseAudit) {
    wrap.appendChild(chipRow(chip('prose audit', 'chip-role', 'Prose audit on', 'The test stage also runs the in-process manuscript audit — tics, metrics, bible consistency and fact drift — over every text file the jail touched. No shell involved.')));
  }
  return wrap;
}

function constraintsList(playbook) {
  if (!playbook.constraints.length) return el('div', 'card-desc', 'No constraints.');
  const ul = el('ul', 'plain');
  for (const c of playbook.constraints) ul.appendChild(el('li', null, c));
  return ul;
}

function playbookCard(playbook, models) {
  const card = el('div', 'card');
  const top = el('div', 'row spread');
  top.appendChild(el('h3', null, playbook.id));
  top.appendChild(chipRow(
    chip(`${Object.keys(playbook.roles).length} roles`, null, 'Roles', 'How many distinct jobs this playbook defines.'),
    playbook.findings.length
      ? chip(`${playbook.findings.length} findings`, 'split', 'Admission findings', 'The admission scanner flagged something in this playbook’s file. It was installed anyway, but read them.')
      : null,
  ));
  card.appendChild(top);
  card.appendChild(el('div', 'card-desc', playbook.description));

  if (playbook.triggers.length) {
    const trig = chipRow();
    tip(trig, 'Triggers', 'Words in an ask that steer auto-classification toward this playbook.');
    for (const t of playbook.triggers) trig.appendChild(chip(t, null));
    card.appendChild(trig);
  }

  card.appendChild(el('div', 'section-title', 'Roles'));
  card.appendChild(rolesTable(playbook, models));

  card.appendChild(el('div', 'section-title', 'Review chain'));
  card.appendChild(reviewChain(playbook));
  const esc = el('div', 'card-desc', `Escalates to ${playbook.escalation.chair} after ${playbook.escalation.afterFailures} failure(s).`);
  tip(esc, 'Escalation', 'Who breaks a deadlock, and how many failed rounds it takes to reach them. The chair is a role, not a person.');
  card.appendChild(esc);

  card.appendChild(el('div', 'section-title', 'Gate and checks'));
  card.appendChild(safetyBlock(playbook));

  card.appendChild(el('div', 'section-title', 'Constraints'));
  card.appendChild(constraintsList(playbook));

  const src = el('div', 'faint mono', playbook.source);
  tip(src, 'Source file', 'The markdown file this playbook was loaded from. Edit it and the daemon re-reads it on the next request.');
  card.appendChild(src);
  return card;
}

function pendingCard(draft, models, refresh) {
  const card = el('div', 'card hot');
  const top = el('div', 'row spread');
  top.appendChild(el('h3', null, draft.id));
  top.appendChild(chip('pending', 'gate', 'Not installed', 'This draft is parked on disk. The loader does not read it, so nothing runs under it until you approve it.'));
  card.appendChild(top);
  card.appendChild(el('div', 'card-desc', draft.description));

  // The safety-critical fields, first and by themselves: this is the whole
  // point of the pending desk.
  const title = el('div', 'section-title', 'Read these before approving');
  tip(title, 'Safety-critical fields', 'A playbook decides who signs work off and what runs in the jail. These four fields are the ones a bad draft would use to hand autonomy to a machine.');
  card.appendChild(title);
  card.appendChild(kvs([
    [
      'gate default',
      chip(
        draft.gate.default,
        draft.gate.default === 'owner' ? 'bad' : 'ok',
        `Gate default: ${draft.gate.default}`,
        draft.gate.default === 'owner'
          ? 'This draft asks for a machine gate: the owner model could sign finished work off without a human. The forge is not allowed to draft this — see the warnings.'
          : 'Every finished ticket waits for a human click.',
      ),
      'Who signs a finished ticket off by default under this playbook.',
    ],
    [
      'hard human',
      draft.gate.hardHuman.length ? draft.gate.hardHuman.join(', ') : '(empty)',
      'Conditions the owner gate may never sign. An empty list under an owner gate means nothing is carved out for you.',
    ],
    [
      'checks',
      draft.checks.length
        ? add(el('span', 'row'), ...draft.checks.map((c) => el('code', 'mono', c)))
        : chip('empty', 'ok', 'No shell checks', 'What it should say. A forged draft is not allowed to introduce shell commands; anything here was added by hand after the forge wrote the file.'),
      'Shell commands this playbook would run inside the jail at the test stage.',
    ],
    ['constraints', String(draft.constraints.length), 'Hard rules injected into every ticket prompt written under this playbook.'],
  ]));
  if (draft.checks.length) {
    card.appendChild(banner('bad', 'This draft carries shell commands', 'The forge strips checks from every draft it writes. Commands here were added to the file afterwards — read them before you approve.'));
  }
  if (draft.constraints.length) {
    const ul = el('ul', 'plain');
    for (const c of draft.constraints) ul.appendChild(el('li', null, c));
    card.appendChild(ul);
  }

  card.appendChild(el('div', 'section-title', 'The rest of the draft'));
  card.appendChild(rolesTable(draft, models));
  card.appendChild(reviewChain(draft));
  if (draft.findings.length) {
    const f = el('div', 'stack');
    for (const finding of draft.findings) {
      const row = el('div', 'finding');
      row.appendChild(chip(finding.level ?? 'finding', 'split', 'Admission finding', 'The security scanner flagged this while reading the draft.'));
      row.appendChild(el('div', 'finding-msg', finding.message ?? String(finding)));
      f.appendChild(row);
    }
    card.appendChild(f);
  }

  card.appendChild(actionBar([
    button({
      label: 'Approve',
      icon: 'check',
      variant: 'primary',
      desc: 'Install this permanently as a playbook the daemon will run work under. It refuses if the draft carries privileges a human did not draft — an owner gate, shell checks, or anything else the forge is not allowed to write.',
      run: async () => {
        const r = await post(`/api/playbooks/${draft.id}/approve`);
        await refresh();
        return r;
      },
      ok: `Installed "${draft.id}"`,
    }),
    button({
      label: 'Reject',
      icon: 'trash',
      variant: 'danger',
      desc: 'Delete this draft from the pending directory. Nothing was installed, so there is nothing to roll back.',
      run: async () => {
        await post(`/api/playbooks/${draft.id}/reject`);
        await refresh();
      },
      ok: `Rejected "${draft.id}"`,
    }),
  ]));
  return card;
}

// -------------------------------------------------------------------- mount

export function mount(root) {
  root.className = 'view';

  const catalog = section('Installed', 'Every playbook the daemon will run work under, exactly as it reads them off disk.');
  const forge = section('Forge a playbook', 'Describe a domain and a senior model drafts an org chart for it. The draft parks in pending — the forge cannot install anything.');
  const pending = section('Pending approval', 'Drafts waiting on a human. Nothing here is live, and nothing here installs itself.');

  add(root, viewHead(meta.title, meta.desc), catalog.node, forge.node, pending.node);

  // Shared by both halves: the tier→model map is global, so it is derived once
  // from the installed catalog and reused for the pending drafts.
  let models = new Map();

  const refreshCatalog = () => loadInto(catalog.body, () => api('/api/playbooks'), (data) => {
    models = tierModels(store.state.tasks, data.playbooks);
    const wrap = el('div', 'stack');
    if (!data.playbooks.length) {
      wrap.appendChild(emptyState(
        'No playbooks installed',
        'Foreman ships four (software, publishing, research, investment). If this is empty, the playbooks directory is missing — forge one below, or copy the seeds into it.',
        { icon: icon('playbooks') },
      ));
    }
    const cards = el('div', 'cards wide');
    for (const pb of data.playbooks) cards.appendChild(playbookCard(pb, models));
    wrap.appendChild(cards);

    if (data.refused?.length) {
      const t = el('div', 'section-title', `Refused — ${data.refused.length}`);
      tip(t, 'Refused playbooks', 'Files in the playbook directory the loader would not admit. They are inert: no ticket can run under them.');
      wrap.appendChild(t);
      const stack = el('div', 'stack');
      for (const r of data.refused) {
        const row = el('div', 'finding');
        row.appendChild(chip(r.id, 'bad', `Refused: ${r.id}`, 'This file was rejected by the loader and is not part of the catalog.'));
        row.appendChild(el('div', 'finding-msg', r.reason));
        stack.appendChild(row);
      }
      wrap.appendChild(stack);
    }
    return wrap;
  });

  const refreshPending = () => loadInto(pending.body, () => api('/api/playbooks/pending'), (data) => {
    const wrap = el('div', 'stack');
    if (!data.drafts.length && !data.refused?.length) {
      wrap.appendChild(emptyState(
        'Nothing waiting',
        'Forged drafts land here for your approval. Until one does, this desk is empty — which is the state it should usually be in.',
        { icon: icon('inbox') },
      ));
      return wrap;
    }
    const cards = el('div', 'cards wide');
    for (const d of data.drafts) cards.appendChild(pendingCard(d, models, refreshPending));
    wrap.appendChild(cards);
    for (const r of data.refused ?? []) {
      const row = el('div', 'finding');
      row.appendChild(chip(r.id, 'bad', `Unreadable draft: ${r.id}`, 'A file in the pending directory the loader cannot parse. It cannot be approved as it stands.'));
      row.appendChild(el('div', 'finding-msg', r.reason));
      wrap.appendChild(row);
    }
    const dir = el('div', 'faint mono', data.dir);
    tip(dir, 'Pending directory', 'Where drafts sit on disk. The live loader never reads this directory.');
    wrap.appendChild(dir);
    return wrap;
  });

  // ---------------------------------------------------------------- forge

  const domainIn = input({ placeholder: 'legal contract review', required: true });
  const askIn = textarea({ rows: 3, placeholder: 'Optional: the ask that made you want this playbook, as context for the draft.' });
  const forgeErr = el('p', 'err-text');
  forgeErr.hidden = true;
  const result = el('div', 'stack');

  const forgeForm = el('form', 'form-grid');
  forgeForm.id = 'forgeForm';
  add(
    forgeForm,
    field('Domain', 'The kind of work the playbook is for. One noun phrase — the forge writes the roles, the review chain and the constraints from it.', domainIn),
    field('Context ask', 'A concrete piece of work in that domain. It steers the draft; it does not become the playbook’s scope.', askIn, { hint: 'optional' }),
    forgeErr,
  );

  const forgeBtn = el('button', 'btn primary');
  forgeBtn.type = 'submit';
  forgeBtn.setAttribute('form', 'forgeForm');
  add(forgeBtn, icon('bolt'), el('span', null, 'Forge a draft'));
  tip(forgeBtn, 'Forge a draft', 'Spends a senior model call writing a playbook for this domain. The result parks in pending; it is not installed and nothing runs under it.');

  forgeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      forgeErr.hidden = true;
      forgeBtn.disabled = true;
      clear(result).appendChild(el('p', 'faint', 'Drafting — a senior model is writing the org chart…'));
      try {
        const r = await post('/api/playbooks/forge', {
          domain: domainIn.value.trim(),
          ask: askIn.value.trim() || undefined,
        });
        clear(result);
        result.appendChild(banner(
          'ok',
          `Drafted "${r.id}" — parked, not installed`,
          `Written to ${r.path}. Read the safety fields below and approve it, or reject it.`,
        ));
        result.appendChild(kvs([
          ['id', r.id, 'The id the playbook would be installed under.'],
          ['description', r.playbook.description, 'What the draft says it is for.'],
          ['roles', Object.entries(r.playbook.roles).map(([k, v]) => `${k} (${v.tier})`).join(', '), 'The roles it defines and the model tier each buys.'],
          ['gate default', r.playbook.gate.default, 'Who signs finished work off under this draft.'],
          ['cost', `$${Number(r.costUsd || 0).toFixed(4)}`, 'What drafting it cost in model spend.'],
        ]));
        if (r.warnings?.length) {
          const t = el('div', 'section-title', `Forge warnings — ${r.warnings.length}`);
          tip(t, 'Forge warnings', 'What the forge forced, stripped or flagged while writing the draft. These are the edits it made to keep the draft inside what a model is allowed to propose.');
          result.appendChild(t);
          const stack = el('div', 'stack');
          for (const w of r.warnings) {
            const row = el('div', 'finding');
            row.appendChild(chip('forced', 'split', 'Forge intervention', 'The forge overrode or removed something the model wrote, rather than trusting it.'));
            row.appendChild(el('div', 'finding-msg', w));
            stack.appendChild(row);
          }
          result.appendChild(stack);
        }
        toast.ok(`Drafted "${r.id}" — waiting on your approval`);
        await refreshPending();
        scrollIntoViewSmooth(pending.node, { block: 'nearest' });
      } catch (e2) {
        clear(result);
        forgeErr.textContent = e2.message;
        forgeErr.hidden = false;
      } finally {
        forgeBtn.disabled = false;
      }
    })();
  });

  add(forge.body, forgeForm, actionBar([forgeBtn]), result);

  void refreshCatalog();
  void refreshPending();

  if (wantForge) {
    wantForge = false;
    domainIn.focus();
    forge.node.scrollIntoView({ block: 'nearest' });
  }
  return undefined;
}
