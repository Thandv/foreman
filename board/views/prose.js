/**
 * views/prose.js — the manuscript toolbox.
 *
 * The audit is the same one the scheduler runs at the test stage for any
 * playbook with proseAudit on, pointed at a directory you name. That matters
 * for how it reads: a `ban` here is not advice, it is the thing that will fail
 * a chapter before it reaches your gate. So bans and warnings are separated at
 * the top, not blended into one list sorted by file.
 *
 * Import is deliberately not a button. It writes a directory full of files from
 * a .docx you name, and a web form that writes to arbitrary paths on the
 * operator's disk is a hole in a daemon that is otherwise localhost-only and
 * read-mostly. The command is here with a copy button instead.
 */
import { add, el, emptyState, post } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { tip } from '../lib/tooltip.js';
import { toast } from '../lib/toast.js';
import {
  actionBar, banner, button, chip, commandBlock, copyButton, field, input,
  section, viewHead,
} from '../lib/view.js';

export const meta = {
  id: 'prose',
  title: 'Prose',
  icon: 'prose',
  desc: 'The manuscript audit: tics, crutch words, cross-scene echoes, name drift and bible consistency.',
};

/** What each family of finding is actually looking at. */
const KIND_TIPS = {
  tic: 'A prose tic inside one scene: a crutch word, a cliché, a repeated sentence pattern, or a cadence so even it reads as machine-timed.',
  metric: 'A whole-manuscript measurement rather than a sentence: crutch words per thousand, phrases echoing across scenes, proper nouns whose spelling drifts, scenes that are length outliers.',
  bible: 'A consistency check against the series bible: a name, date or spelling that disagrees with the canon you wrote down. Fact drift, not style.',
};

const LEVEL_TIPS = {
  ban: 'Fails the run. Under a playbook with the prose audit on, work carrying this never reaches your gate — it is sent back at the test stage.',
  warn: 'Informational. It never fails a run on its own; it is the editorial note you decide about.',
};

let wantAudit = false;
export function requestAudit() { wantAudit = true; }

const IMPORT_COMMAND = 'foreman prose import <file> --out <dir>';
const BUILD_COMMAND = 'foreman build "<what you want done to it>" --repo <dir> --playbook publishing';

function findingRow(f) {
  const row = el('div', 'finding');
  row.appendChild(chip(f.level, f.level === 'ban' ? 'bad' : 'split', f.level === 'ban' ? 'Ban' : 'Warning', LEVEL_TIPS[f.level]));
  row.appendChild(chip(f.kind, null, `Kind: ${f.kind}`, KIND_TIPS[f.kind] ?? 'An audit finding.'));
  row.appendChild(el('div', 'finding-msg', f.message));
  return row;
}

export function mount(root) {
  root.className = 'view';

  const dirIn = input({ placeholder: '/Users/you/Projects/novel/manuscript', required: true });
  const err = el('p', 'err-text');
  err.hidden = true;
  const report = el('div', 'stack');

  const form = el('form', 'form-grid');
  form.id = 'proseForm';
  add(
    form,
    field(
      'Manuscript directory',
      'The folder holding the scenes. Chapters may sit one or two levels down (book/act-1/scene-3.md); the audit walks that far and reads .md and .txt in reading order.',
      dirIn,
      { hint: 'absolute path, or a path relative to where the daemon was started' },
    ),
    err,
  );

  const auditBtn = el('button', 'btn primary');
  auditBtn.type = 'submit';
  auditBtn.setAttribute('form', 'proseForm');
  add(auditBtn, icon('prose'), el('span', null, 'Audit'));
  tip(auditBtn, 'Audit', 'Runs the manuscript audit over that directory. It reads files and calls no model, so it costs nothing and changes nothing.');

  const audit = section('Audit a manuscript', 'The same pass a run gets at its test stage, on a directory you name. Reads only — nothing is written or edited.');
  add(audit.body, form, actionBar([auditBtn]), report);

  const importSec = section('Import a manuscript', 'Turning a .docx or a single long file into the per-chapter layout the audit and the crew expect.');

  add(root, viewHead(meta.title, meta.desc), audit.node, importSec.node);

  // ------------------------------------------------------------- the audit

  function renderReport(data) {
    const wrap = el('div', 'stack');
    const findings = data.report.findings ?? [];
    const bans = findings.filter((f) => f.level === 'ban');

    wrap.appendChild(data.hasBans
      ? banner(
        'bad',
        `${bans.length} ban-level finding${bans.length === 1 ? '' : 's'} — this manuscript would fail a run`,
        'A playbook with the prose audit on runs exactly this at the test stage. Work carrying a ban is sent back before it reaches your gate.',
      )
      : banner(
        'ok',
        findings.length ? `Clean of bans — ${findings.length} warning${findings.length === 1 ? '' : 's'}` : 'Clean',
        `${data.report.files.length} scene file(s) read. Warnings are editorial notes; they never fail a run.`,
      ));

    const byFile = new Map();
    const cross = [];
    for (const f of findings) {
      if (f.file === null || f.file === undefined) cross.push(f);
      else {
        const list = byFile.get(f.file) ?? [];
        list.push(f);
        byFile.set(f.file, list);
      }
    }

    // Per file, in reading order — the order the book is meant to be read in,
    // not alphabetical and not worst-first.
    const perFile = el('div', 'stack');
    const pTitle = el('div', 'section-title', 'By scene, in reading order');
    tip(pTitle, 'Per-scene findings', 'Findings that belong to one file, listed in the order the manuscript reads. Files with nothing to say about them are left out.');
    perFile.appendChild(pTitle);
    let any = false;
    for (const file of data.report.files) {
      const list = byFile.get(file);
      if (!list?.length) continue;
      any = true;
      perFile.appendChild(el('div', 'finding-file', `${file} — ${list.length}`));
      for (const f of list) perFile.appendChild(findingRow(f));
    }
    if (!any) {
      perFile.appendChild(emptyState('Nothing to flag in any scene', 'Every scene file read clean at the sentence level.', { inline: true }));
    }
    wrap.appendChild(perFile);

    // Cross-file: echoes, name variants, crutch words, bible disagreements.
    const crossWrap = el('div', 'stack');
    const cTitle = el('div', 'section-title', 'Across the manuscript');
    tip(cTitle, 'Cross-file findings', 'What only shows up when the scenes are read together: a phrase echoing across chapters, a name spelled two ways, a crutch word nobody notices in one scene, a fact that contradicts the bible.');
    crossWrap.appendChild(cTitle);
    if (cross.length) for (const f of cross) crossWrap.appendChild(findingRow(f));
    else crossWrap.appendChild(emptyState('No cross-file findings', 'No echoes, no name drift, no bible disagreements across the scenes read.', { inline: true }));
    wrap.appendChild(crossWrap);

    // Counts, and the plain-text report the CLI prints, for pasting elsewhere.
    const metrics = findings.filter((f) => f.kind === 'metric').length;
    const summary = el('div', 'row');
    summary.appendChild(chip(`${data.report.files.length} files`, null, 'Scenes read', 'How many .md/.txt files the audit treated as scenes. Style sheets, front matter and the series bible are skipped.'));
    summary.appendChild(chip(`${bans.length} ban`, bans.length ? 'bad' : 'ok', 'Ban-level findings', LEVEL_TIPS.ban));
    summary.appendChild(chip(`${findings.length - bans.length} warn`, 'split', 'Warnings', LEVEL_TIPS.warn));
    summary.appendChild(chip(`${metrics} metric`, null, 'Metric findings', KIND_TIPS.metric));
    summary.appendChild(copyButton(data.text, 'Copy the plain-text report — the same text `foreman prose audit` prints.'));
    wrap.appendChild(summary);
    return wrap;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      err.hidden = true;
      auditBtn.disabled = true;
      report.textContent = '';
      report.appendChild(el('p', 'faint', 'Reading the manuscript…'));
      try {
        const data = await post('/api/prose/audit', { dir: dirIn.value.trim() });
        report.textContent = '';
        report.appendChild(renderReport(data));
        toast[data.hasBans ? 'err' : 'ok'](data.hasBans
          ? `${data.report.findings.filter((f) => f.level === 'ban').length} ban-level finding(s)`
          : 'Audit clean of bans');
      } catch (e2) {
        report.textContent = '';
        err.textContent = e2.message;
        err.hidden = false;
      } finally {
        auditBtn.disabled = false;
      }
    })();
  });

  // ------------------------------------------------------------ the import

  const importCard = el('div', 'card');
  importCard.appendChild(el('h3', null, 'Import is a command, not a button'));
  importCard.appendChild(el(
    'div',
    'card-desc',
    'Import writes a directory of files from a document you name. The daemon is localhost-only and otherwise read-mostly, so it does not expose a form that writes to arbitrary paths on your disk. Run it yourself:',
  ));
  const step1 = el('div', 'section-title', '1 · split the document into chapters');
  tip(step1, 'Import', 'Reads a .docx, .md or .txt, splits it on chapter breaks, and writes chapter-NN-<slug>.md files (plus front-matter.md) into an empty output directory. It refuses to write into a directory that already has files in it.');
  importCard.appendChild(step1);
  importCard.appendChild(commandBlock(IMPORT_COMMAND, 'Copy the import command.'));

  const step2 = el('div', 'section-title', '2 · put the crew to work on it');
  tip(step2, 'Then build', 'Point a crew epic at the directory you just wrote. Under the publishing playbook the roles are author, line editor, copyeditor and proofreader, and the prose audit above runs at every ticket’s test stage.');
  importCard.appendChild(step2);
  importCard.appendChild(commandBlock(BUILD_COMMAND, 'Copy the follow-up build command.'));

  importCard.appendChild(actionBar([button({
    label: 'Audit that directory',
    icon: 'prose',
    variant: 'ghost',
    desc: 'Jump back to the audit field so you can point it at the directory you imported into.',
    run: async () => {
      dirIn.focus();
      dirIn.scrollIntoView({ block: 'center' });
    },
  })]));
  importSec.body.appendChild(importCard);

  report.appendChild(emptyState(
    'No audit yet',
    'Name a manuscript directory above. The audit reads it and calls no model, so running it costs nothing but the read.',
    { icon: icon('prose') },
  ));

  if (wantAudit) {
    wantAudit = false;
    dirIn.focus();
  }
  return undefined;
}
