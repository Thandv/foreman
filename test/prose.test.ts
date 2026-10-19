import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { crc32, deflateRawSync } from 'node:zlib';

import { wordCount } from '../src/prose/words.ts';
import { mergeOverrides, scanTics } from '../src/prose/tics.ts';
import { crossSceneEchoes, properNounVariants, proseMetrics, type SceneText } from '../src/prose/metrics.ts';
import { factDrift } from '../src/prose/linecheck.ts';
import { acceptableRevision, NO_MODEL_SENTINEL } from '../src/prose/revision.ts';
import { chapterNumberFromName, naturalCompare, wordsToNumber } from '../src/prose/naming.ts';
import { parseBible, selectRelevant } from '../src/prose/bible.ts';
import { bookTitleFrom, docxToText, frontMatterStem, isFrontMatterFilename, splitChapters } from '../src/prose/ingest.ts';
import { auditDir, formatAuditReport, listSceneFiles } from '../src/prose/audit.ts';
import { auditDirAsync } from '../src/prose/auditWorker.ts';
import { clearPlaybookCache, loadPlaybooks } from '../src/playbooks.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const ticHeavy = fs.readFileSync(path.join(FIXTURES, 'tic-heavy.md'), 'utf8');
const curlyQuotes = fs.readFileSync(path.join(FIXTURES, 'curly-quotes.md'), 'utf8');

// ============================================================ words.ts

test('wordCount: ignores HTML beat comments and markdown noise', () => {
  assert.equal(wordCount('<!-- beat: setup --> The rain fell hard'), 4);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount(''), 0);
});

test('wordCount: a hyphen between word characters is part of the word', () => {
  // "mother-in-law" is one word, not three — the bug the module's own
  // docstring documents fixing.
  assert.equal(wordCount('mother-in-law is a word'), 4);
  // A hyphen with a space on either side is a dash, not a compound: it
  // separates two words rather than joining them.
  assert.equal(wordCount('word - word'), 2);
});

// ============================================================= tics.ts

test('scanTics: HARD BAN patterns are flagged on tic-heavy prose', () => {
  const findings = scanTics(ticHeavy);
  const bans = findings.filter((f) => f.note.startsWith('HARD BAN:'));
  assert.ok(bans.length >= 3, `expected several HARD BAN findings, got ${bans.length}`);
  assert.ok(bans.some((f) => /not just X, but Y/.test(f.note)));
  assert.ok(bans.some((f) => /negation catalogue/.test(f.note)));
});

test('scanTics: density caps fire on tic-heavy prose (em-dash, intensifiers, filter words)', () => {
  const findings = scanTics(ticHeavy);
  const density = findings.filter((f) => f.kind === 'density');
  assert.ok(density.some((f) => /em-dash overuse/.test(f.note)));
  assert.ok(density.some((f) => /intensifiers.hedges/.test(f.note)));
  assert.ok(density.some((f) => /filter words/.test(f.note)));
});

test('scanTics: clean prose has zero findings', () => {
  const clean = scanTics('The rain fell on the tin roof. Juniper counted the coins and closed the jar.');
  assert.equal(clean.length, 0);
});

test('scanTics: narrationOnly excludes dialogue from word/phrase bans', () => {
  // "delve" is a banned word, but it is said INSIDE dialogue here — the gate
  // must not police how a character talks.
  const dialogue = scanTics('"I would never delve into that," Juniper said. The room was quiet.');
  assert.ok(!dialogue.some((f) => f.kind === 'word' && /delve/i.test(f.match)), 'a banned word inside dialogue is not flagged');

  // The exact same word in NARRATION is still flagged.
  const narration = scanTics('She would delve into that later, Juniper thought.');
  assert.ok(narration.some((f) => f.kind === 'word' && /delve/i.test(f.match)), 'the same word in narration is flagged');
});

test('scanTics: a structural HARD BAN is book-wide and still fires inside dialogue (curly quotes)', () => {
  // The "it wasn't X, it was Y" contrast formula is NOT narrationOnly, so it
  // is policed everywhere, including a character's own mouth — and the
  // dialogue is written with CURLY quotes/apostrophes (P1.3's normaliseForScan
  // is what lets a straight-quoted ban list still catch it).
  const dialogue = scanTics('“It wasn’t a mistake, it was a message,” she said.');
  assert.ok(dialogue.some((f) => f.note.startsWith('HARD BAN:') && /it wasn't X, it was Y/.test(f.note)));

  // curly-quotes.md itself: "The kind of quiet" (line 8) is narration and IS
  // narrationOnly, so it is flagged there too.
  const findings = scanTics(curlyQuotes);
  assert.ok(findings.some((f) => /pseudo-profound wrapper/.test(f.note)));
});

test('scanTics: overrides — allow un-bans a word, an override word adds one', () => {
  const merged = mergeOverrides({ words: ['delve'], phrases: [] }, { allow: ['delve'], words: ['zorptastic'] });
  assert.ok(!merged.words.includes('delve'));
  assert.ok(merged.words.includes('zorptastic'));
  const findings = scanTics('This is zorptastic and delve is fine now.', { allow: ['delve'], words: ['zorptastic'] });
  assert.ok(findings.some((f) => /zorptastic/i.test(f.match)));
  assert.ok(!findings.some((f) => /delve/i.test(f.match)));
});

// =========================================================== metrics.ts

test('crossSceneEchoes: a distinctive repeated phrase across two scenes is found', () => {
  const scenes: SceneText[] = [
    { id: 'a', text: 'The lantern guttered against the wet stone wall while Juniper waited for the tide.' },
    { id: 'b', text: 'Years later the lantern guttered against the wet stone wall again, and she remembered.' },
  ];
  const echoes = crossSceneEchoes(scenes);
  assert.ok(echoes.length >= 1);
  assert.ok(echoes.some((e) => /lantern guttered against the wet stone/.test(e.phrase)));
  assert.ok(echoes.every((e) => e.scenes.includes('a') && e.scenes.includes('b')));
});

test('properNounVariants: Zane (canonical, frequent) vs Zain (one-off misspelling)', () => {
  const scenes: SceneText[] = [
    { id: 'ch2', text: 'Captain Zane walked the dock. Zane counted the coins. Zane never smiled.' },
    { id: 'ch30', text: 'Captain Zain stood at the rail, watching the storm roll in.' },
  ];
  const variants = properNounVariants(scenes);
  const hit = variants.find((v) => v.canonical === 'Zane');
  assert.ok(hit, 'Zane is elected canonical by frequency');
  assert.ok(hit!.variants.some((v) => v.name === 'Zain'));
});

test('proseMetrics: basic word/sentence counts on a short passage', () => {
  const m = proseMetrics('The rain fell hard. Juniper counted the coins.');
  assert.equal(m.words, 8);
  assert.equal(m.sentences, 2);
});

// ========================================================== linecheck.ts

test('factDrift: a name present before and absent after is flagged', () => {
  const drift = factDrift('Linnet spoke to Juniper on the dock.', 'Linnet spoke on the dock.');
  assert.ok(drift.includes('Juniper'));
});

test('factDrift: a number word present before and absent after is flagged', () => {
  const drift = factDrift('She counted seventeen coins in the jar.', 'She counted the coins in the jar.');
  assert.ok(drift.includes('seventeen'));
});

test('factDrift: a removal the ticket asked for is not drift', () => {
  const before = 'Abelard Pellam held the north face with seventeen men.';
  const after = 'Ludo Wilmot held the north face with twelve men.';

  // Unsanctioned, this is exactly what the guard is for.
  const unasked = factDrift(before, after);
  assert.ok(unasked.includes('Pellam'));
  assert.ok(unasked.includes('seventeen'));

  // A ticket that names the change is asking for the disappearance it reports.
  const asked = factDrift(before, after, 'Rename Abelard Pellam to Ludo Wilmot; the count is twelve, not seventeen.');
  assert.deepEqual(asked, []);
});

test('factDrift: a sanctioned name covers its possessive, curly apostrophe and all', () => {
  // Mid-sentence: a sentence-initial capital is never a name candidate.
  const before = 'They held Pellam\u2019s north face until dark.';
  const after = 'They held Wilmot\u2019s north face until dark.';
  assert.ok(factDrift(before, after).includes('Pellam\u2019s'), 'unsanctioned, the possessive is drift');
  assert.deepEqual(factDrift(before, after, 'Rename Abelard Pellam to Ludo Wilmot.'), []);
});

test('factDrift: sanctioning one name does not license dropping another', () => {
  const before = 'Pellam and Brisco walked the dyke.';
  const after = 'Wilmot walked the dyke.';
  const drift = factDrift(before, after, 'Rename Pellam to Wilmot.');
  assert.ok(!drift.includes('Pellam'), 'the sanctioned rename is excused');
  assert.ok(drift.includes('Brisco'), 'the unmentioned name is still drift');
});

test('factDrift: a sentence-initial capital is NOT flagged as a dropped name', () => {
  // "Suddenly" only ever appears as the first word of a sentence in either
  // version, so it is never a name CANDIDATE at all (mid-sentence capitals
  // only) and must not show up as drift even though the word disappeared.
  const before = 'Suddenly the door opened. Linnet stepped inside.';
  const after = 'The door opened. Linnet stepped inside.';
  const drift = factDrift(before, after);
  assert.ok(!drift.includes('Suddenly'));
  assert.ok(!drift.includes('Linnet'), 'Linnet survives in both, so it is not drift either');
});

// ========================================================== revision.ts

test('acceptableRevision: refuses the app\'s own "no model" sentinel as prose', () => {
  const verdict = acceptableRevision('The original scene, several sentences long.', `${NO_MODEL_SENTINEL} — try again later`);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', /nothing was rewritten/);
});

test('acceptableRevision: refuses a revision that came back far shorter than the original', () => {
  const original = 'word '.repeat(60).trim();
  const verdict = acceptableRevision(original, 'far too short');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', /unexpectedly short/);
});

test('acceptableRevision: refuses anything after a cancel, accepts a sane tightening', () => {
  assert.equal(acceptableRevision('anything', 'anything', { aborted: true }).ok, false);
  const original = 'word '.repeat(20).trim();
  const tightened = 'word '.repeat(14).trim(); // 70% — within the short-text floor
  assert.equal(acceptableRevision(original, tightened).ok, true);
});

// ============================================================ naming.ts

test('naming: chapter-2 sorts before chapter-100 (natural, digit-aware order)', () => {
  const files = ['chapter-100.md', 'chapter-2.md', 'chapter-10.md'];
  const sorted = [...files].sort((a, b) => {
    const ca = chapterNumberFromName(a);
    const cb = chapterNumberFromName(b);
    return ca !== cb ? ca - cb : naturalCompare(a, b);
  });
  assert.deepEqual(sorted, ['chapter-2.md', 'chapter-10.md', 'chapter-100.md']);
});

test('naming: wordsToNumber parses strictly, one phrase at a time', () => {
  assert.equal(wordsToNumber('five'), 5);
  assert.equal(wordsToNumber('twenty-one'), 21);
  assert.equal(wordsToNumber('twenty one'), 21);
  assert.equal(wordsToNumber('banana'), null);
  // chapterNumberFromName must not SUM every number word in a title.
  assert.equal(chapterNumberFromName('the-two-towers-chapter-five.md'), 5);
});

test('naming: frontMatterStem tells a section filename from a chapter that merely mentions one', () => {
  assert.equal(isFrontMatterFilename('dedication.md'), true);
  assert.equal(isFrontMatterFilename('00 - dedication (final).md'), true);
  assert.equal(isFrontMatterFilename('titlepage.md'), true);
  assert.equal(frontMatterStem('dedication.md'), 'dedication');
  // Both directions must hold: a real chapter that merely CONTAINS a
  // front-matter word is not reclassified.
  assert.equal(isFrontMatterFilename('preface-to-the-duel.md'), false);
  assert.equal(isFrontMatterFilename('the-dedication-ceremony.md'), false);
});

// ============================================================= bible.ts

test('parseBible: parses entries, aliases, and the always flag', () => {
  const text =
    '# Characters\n\n## Juniper Whitlock\n- aliases: Juniper, Captain Whitlock\n- always: true\n' +
    'A weary harbormaster with a debt.\n\n## The Ledger\nA cursed account book.';
  const entries = parseBible('characters', text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.name, 'Juniper Whitlock');
  assert.ok(entries[0]!.aliases.includes('Captain Whitlock'));
  assert.equal(entries[0]!.always, true);
  assert.match(entries[0]!.body, /weary harbormaster/);
  assert.equal(entries[1]!.always, false);
});

test('selectRelevant: only always-on and actually-mentioned entries are selected', () => {
  const text =
    '# Characters\n\n## Juniper Whitlock\n- aliases: Juniper, Captain Whitlock\n- always: true\nA weary harbormaster.\n\n' +
    '## The Ledger\nA cursed account book.\n\n## Bosun Yardley\nNever appears in this beat.';
  const entries = parseBible('characters', text);

  const r1 = selectRelevant(entries, 'Captain Whitlock stormed onto the dock.');
  assert.ok(r1.some((e) => e.name === 'Juniper Whitlock'), 'alias mention selects the entry');
  assert.ok(!r1.some((e) => e.name === 'Bosun Yardley'), 'an unmentioned, non-always entry is not selected');

  const r2 = selectRelevant(entries, 'Nothing pertinent occurs in this beat.');
  assert.equal(r2.length, 1, 'only the always-on entry is selected when nothing else is mentioned');
  assert.equal(r2[0]!.name, 'Juniper Whitlock');
});

// ============================================================ ingest.ts

test('splitChapters: a multi-chapter manuscript with front matter splits cleanly', () => {
  const text =
    '# Dedication\n\nFor my mother.\n\n' +
    '# Chapter One\n\nThe harbor was quiet that morning.\n\n' +
    '# Chapter Two\n\nLinnet never came back for the lantern.\n';
  const chapters = splitChapters(text);
  assert.equal(chapters.length, 3);
  assert.equal(chapters[0]!.frontMatter, true);
  assert.match(chapters[0]!.text, /For my mother/);
  assert.equal(chapters[1]!.title, 'Chapter One');
  assert.match(chapters[1]!.text, /harbor was quiet/);
  assert.equal(chapters[2]!.title, 'Chapter Two');
  assert.match(chapters[2]!.text, /Linnet never came back/);
});

test('splitChapters: no chapter heading at all still returns one chunk; blank returns none', () => {
  assert.deepEqual(splitChapters('just some prose, no headings'), [{ title: 'Chapter 1', text: 'just some prose, no headings' }]);
  assert.deepEqual(splitChapters('   '), []);
});

test('bookTitleFrom: takes a title-page heading, refuses a chapter heading', () => {
  assert.equal(bookTitleFrom('# THE THORNMERE PAPERS\n\nSome text.'), 'The Thornmere Papers');
  assert.equal(bookTitleFrom('# Chapter One\n\nText.'), null);
  assert.equal(bookTitleFrom('no heading at all'), null);
});

/** A minimal store-only ZIP writer, following the ZIP format closely
 *  enough for docxToText (which supports both stored and deflated entries). */
function buildZip(entries: { path: string; data: string; deflate?: boolean }[]): Buffer {
  const LOCAL_SIG = 0x04034b50;
  const CENTRAL_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const raw = Buffer.from(entry.data, 'utf8');
    const stored = !entry.deflate;
    const body = stored ? raw : deflateRawSync(raw);
    const sum = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function docxOf(xml: string): Buffer {
  return buildZip([{ path: 'word/document.xml', data: xml }]);
}

test('docxToText: extracts paragraphs, tabs and breaks from a minimal .docx', () => {
  const xml =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>a<w:tab/>b<w:br/>c</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Second</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  assert.equal(docxToText(docxOf(xml)), 'a\tb\nc\nSecond');
  // A tab BETWEEN runs (rather than inside one <w:t>) is dropped — pinned
  // behavior, not a bug: only <w:t> contents are joined.
  const betweenRuns =
    '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:tab/><w:r><w:t>world</w:t></w:r></w:p></w:body></w:document>';
  assert.equal(docxToText(docxOf(betweenRuns)), 'Helloworld');
});

test('docxToText: a deflated entry decompresses the same as a stored one', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Deflated ok</w:t></w:r></w:p></w:body></w:document>';
  const zipStored = buildZip([{ path: 'word/document.xml', data: xml }]);
  const zipDeflated = buildZip([{ path: 'word/document.xml', data: xml, deflate: true }]);
  assert.equal(docxToText(zipStored), docxToText(zipDeflated));
  assert.equal(docxToText(zipDeflated), 'Deflated ok');
});

test('docxToText: refuses a buffer with no word/document.xml', () => {
  const zip = buildZip([{ path: 'not-a-docx.txt', data: 'hi' }]);
  assert.throws(() => docxToText(zip), /not a Word document/);
});

// ============================================================= audit.ts

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('auditDir: a tic-heavy chapter produces ban + warn findings attributed to the file', () => {
  const dir = mkTmpDir('foreman-prose-audit-');
  try {
    fs.writeFileSync(path.join(dir, 'chapter-01-test.md'), ticHeavy);
    const result = auditDir(dir);
    assert.deepEqual(result.files, ['chapter-01-test.md']);
    assert.ok(result.findings.some((f) => f.level === 'ban' && f.file === 'chapter-01-test.md'));
    assert.ok(result.findings.some((f) => f.level === 'warn'));
    const report = formatAuditReport(result);
    assert.match(report, /chapter-01-test\.md:/);
    assert.match(report, /finding\(s\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSceneFiles: two levels of subdirectory count, node_modules and dotdirs do not', () => {
  // A top-level-only scan does not FAIL on a manuscript filed under
  // chapters/ — it finds nothing, calls the book clean, and passes the check
  // on a manuscript it never opened.
  const dir = mkTmpDir('foreman-prose-walk-');
  try {
    const put = (rel: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), '# Scene\n\nThe rain fell.\n');
    };
    put('chapter-01.md');
    put('chapters/chapter-02.md');
    put('book/act-1/chapter-03.md');
    put('book/act-1/deeper/chapter-99.md'); // three levels down: out of range
    put('node_modules/pkg/readme.md');
    put('.drafts/chapter-04.md');
    put('series-bible/characters.md'); // canon, not a scene
    put('chapters/STYLE_SHEET.md');
    put('chapters/notes.pdf.bak');

    assert.deepEqual(listSceneFiles(dir), [
      'chapter-01.md',
      'chapters/chapter-02.md',
      'book/act-1/chapter-03.md',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auditDir: a chapter in a subdirectory is audited, and named by its path', () => {
  const dir = mkTmpDir('foreman-prose-subdir-');
  try {
    fs.mkdirSync(path.join(dir, 'chapters'));
    fs.writeFileSync(path.join(dir, 'chapters', 'chapter-01.md'), ticHeavy);
    const result = auditDir(dir);
    assert.deepEqual(result.files, ['chapters/chapter-01.md']);
    assert.ok(result.findings.some((f) => f.level === 'ban' && f.file === 'chapters/chapter-01.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------- audit, off the loop

test('auditDirAsync returns exactly what auditDir does, computed in a worker', async () => {
  const dir = mkTmpDir('foreman-prose-worker-');
  try {
    fs.writeFileSync(path.join(dir, 'chapter-01.md'), ticHeavy);
    fs.writeFileSync(path.join(dir, 'chapter-02.md'), '# Chapter Two\n\nJuniper counted the coins.\n');
    assert.deepEqual(await auditDirAsync(dir), auditDir(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auditDirAsync fails loudly on a timeout, an abort, and a directory that is not there', async () => {
  const dir = mkTmpDir('foreman-prose-worker-fail-');
  try {
    fs.writeFileSync(path.join(dir, 'chapter-01.md'), ticHeavy);

    // A book that wedges the audit must not park the run for the whole task
    // deadline — it fails the check with a message that says what happened.
    await assert.rejects(auditDirAsync(dir, { timeoutMs: 0 }), /prose audit timed out after 0ms/);

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(auditDirAsync(dir, { signal: ac.signal }), /prose audit aborted/);

    const live = new AbortController();
    const inflight = auditDirAsync(dir, { signal: live.signal });
    live.abort();
    await assert.rejects(inflight, /prose audit aborted/);

    // An error inside the worker crosses the thread boundary as an error, not
    // as a silent empty result that would read as a clean book.
    await assert.rejects(auditDirAsync(path.join(dir, 'gone')), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auditDir: a clean manuscript directory has zero findings', () => {
  const dir = mkTmpDir('foreman-prose-audit-clean-');
  try {
    fs.writeFileSync(
      path.join(dir, 'chapter-01.md'),
      '# Chapter One\n\nThe rain fell on the tin roof. Juniper counted the coins and closed the jar.\n',
    );
    const result = auditDir(dir);
    assert.equal(result.findings.length, 0);
    assert.equal(formatAuditReport(result), 'prose audit: 1 file(s), clean');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================== CLI integration

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

test('CLI: foreman prose audit exits 1 with findings on tic-heavy prose, 0 on clean', () => {
  const dirty = mkTmpDir('foreman-prose-cli-dirty-');
  const clean = mkTmpDir('foreman-prose-cli-clean-');
  try {
    fs.writeFileSync(path.join(dirty, 'chapter-01.md'), ticHeavy);
    fs.writeFileSync(path.join(clean, 'chapter-01.md'), '# Chapter One\n\nThe rain fell on the tin roof.\n');

    const dirtyRun = spawnSync(process.execPath, [CLI, 'prose', 'audit', dirty], { encoding: 'utf8' });
    assert.equal(dirtyRun.status, 1);
    assert.match(dirtyRun.stdout, /finding\(s\)/);

    const cleanRun = spawnSync(process.execPath, [CLI, 'prose', 'audit', clean], { encoding: 'utf8' });
    assert.equal(cleanRun.status, 0);
    assert.match(cleanRun.stdout, /clean/);

    const jsonRun = spawnSync(process.execPath, [CLI, 'prose', 'audit', clean, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(jsonRun.stdout);
    assert.deepEqual(parsed.findings, []);
  } finally {
    fs.rmSync(dirty, { recursive: true, force: true });
    fs.rmSync(clean, { recursive: true, force: true });
  }
});

test('CLI: a warn-only manuscript exits 0, and 1 under --strict', () => {
  // The CLI and the scheduler must agree about the same book. The scheduler
  // fails a run only on ban-level findings (a manuscript in progress should
  // not fail on style metrics), so exiting 1 on a bare warn made `foreman
  // prose audit` a stricter gate than the gate.
  const dir = mkTmpDir('foreman-prose-warn-');
  try {
    fs.writeFileSync(
      path.join(dir, 'chapter-01.md'),
      '# Chapter One\n\nThe lantern guttered against the wet stone wall while Juniper waited for the tide.\n',
    );
    fs.writeFileSync(
      path.join(dir, 'chapter-02.md'),
      '# Chapter Two\n\nYears later the lantern guttered against the wet stone wall again, and she remembered.\n',
    );
    const audit = auditDir(dir);
    assert.ok(audit.findings.length > 0 && audit.findings.every((f) => f.level === 'warn'), 'warns, no bans');

    const lenient = spawnSync(process.execPath, [CLI, 'prose', 'audit', dir], { encoding: 'utf8' });
    assert.equal(lenient.status, 0, lenient.stdout);
    assert.match(lenient.stdout, /repeated phrase/);

    const strict = spawnSync(process.execPath, [CLI, 'prose', 'audit', dir, '--strict'], { encoding: 'utf8' });
    assert.equal(strict.status, 1, 'the operator asked for every finding to count');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: foreman prose import splits a manuscript into chapter files and refuses a non-empty out dir', () => {
  const src = mkTmpDir('foreman-prose-import-src-');
  const out = mkTmpDir('foreman-prose-import-out-');
  try {
    const manuscript = path.join(src, 'book.md');
    fs.writeFileSync(
      manuscript,
      '# Dedication\n\nFor my mother.\n\n# Chapter One\n\nThe harbor was quiet.\n\n# Chapter Two\n\nLinnet left.\n',
    );
    fs.rmSync(out, { recursive: true, force: true }); // start from "does not exist yet"
    const run = spawnSync(process.execPath, [CLI, 'prose', 'import', manuscript, '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const written = fs.readdirSync(out).sort();
    assert.deepEqual(written, ['chapter-01-one.md', 'chapter-02-two.md', 'front-matter.md']);

    // A second run against the now-populated dir must refuse.
    const again = spawnSync(process.execPath, [CLI, 'prose', 'import', manuscript, '--out', out], { encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /non-empty directory/);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ============================================== playbooks.ts (proseAudit)

function withPlaybookDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-prose-playbooks-'));
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents);
  clearPlaybookCache();
  return dir;
}

function cleanupPlaybookDir(dir: string): void {
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
  clearPlaybookCache();
  fs.rmSync(dir, { recursive: true, force: true });
}

const PROSE_PLAYBOOK = (proseAudit: boolean): string => `---
${JSON.stringify({
  id: 'prose-pb',
  description: 'manuscript playbook exercising the proseAudit flag',
  triggers: [],
  roles: { worker: { tier: 'worker' } },
  reviewers: [],
  escalation: { chair: 'worker', afterFailures: 2 },
  checks: [],
  proseAudit,
  gate: { default: 'human', hardHuman: [] },
  constraints: [],
}, null, 2)}
---

## role: worker

You do the work.
`;

test('loadPlaybooks: proseAudit parses true, and defaults false when the key is absent', () => {
  const dirTrue = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  try {
    const { playbooks } = loadPlaybooks();
    assert.equal(playbooks[0]!.proseAudit, true);
  } finally {
    cleanupPlaybookDir(dirTrue);
  }

  // Additive flag: a playbook file with no `proseAudit` key at all (an older
  // file, or a hand-written one) must still load, with the flag false.
  const noKeyText = PROSE_PLAYBOOK(true).replace(/"proseAudit": true,\n/, '');
  const dirAbsent = withPlaybookDir({ 'pb.md': noKeyText });
  try {
    const { playbooks, refused } = loadPlaybooks();
    assert.equal(refused.length, 0, JSON.stringify(refused));
    assert.equal(playbooks[0]!.proseAudit, false);
  } finally {
    cleanupPlaybookDir(dirAbsent);
  }
});

// ===================================================== scheduler wiring

/**
 * `seed` is the one file every repo needs to have something to commit. It is a
 * .md by default (and so an audited scene), so a test that needs a repo with NO
 * manuscript in it names a non-prose seed instead.
 */
function fixtureRepo(files: Record<string, string> = {}, seed = 'README.md'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-prose-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, seed), 'base\n');
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  }
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}

test('scheduler: a proseAudit playbook fails the test stage on a hard tic ban', async () => {
  const pbDir = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  const repo = fixtureRepo({ 'chapter-01.md': ticHeavy });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({
      title: 'tic-heavy chapter', prompt: 'do the thing', runner: 'echo', repo,
      testCmd: 'true', playbook: 'prose-pb', role: 'worker', maxRepairs: 0, mergeOnApprove: false,
    });
    await sched.drain(20_000);
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'failed');
    const verdicts = store.verdictsForTask(t.id);
    assert.match(verdicts[0]?.critique ?? '', /prose audit:/);
    assert.match(verdicts[0]?.critique ?? '', /HARD BAN/);
  } finally {
    store.close();
    cleanupPlaybookDir(pbDir);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('scheduler: a proseAudit playbook fails the test stage on fact drift (a dropped name)', async () => {
  const pbDir = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  const repo = fixtureRepo({ 'chapter-01.md': '# Chapter One\n\nLinnet spoke to Juniper on the dock.\n' });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({
      title: 'drop a name', prompt: "printf '# Chapter One\\n\\nLinnet spoke on the dock.\\n' > chapter-01.md",
      kind: 'code', runner: 'shell', repo,
      testCmd: 'true', playbook: 'prose-pb', role: 'worker', maxRepairs: 0, mergeOnApprove: false,
    });
    await sched.drain(20_000);
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'failed');
    const verdicts = store.verdictsForTask(t.id);
    assert.match(verdicts[0]?.critique ?? '', /fact drift:/);
    assert.match(verdicts[0]?.critique ?? '', /Juniper/);
  } finally {
    store.close();
    cleanupPlaybookDir(pbDir);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('scheduler: a manuscript filed in a subdirectory is audited, not passed over', async () => {
  const pbDir = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  const repo = fixtureRepo({ 'chapters/chapter-01.md': ticHeavy });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({
      title: 'tic-heavy chapter in a subfolder', prompt: 'do the thing', runner: 'echo', repo,
      testCmd: 'true', playbook: 'prose-pb', role: 'worker', maxRepairs: 0, mergeOnApprove: false,
    });
    await sched.drain(20_000);
    assert.equal(store.getTask(t.id)!.status, 'failed');
    const critique = store.verdictsForTask(t.id)[0]?.critique ?? '';
    assert.match(critique, /prose audit:/);
    assert.match(critique, /chapters\/chapter-01\.md/);
  } finally {
    store.close();
    cleanupPlaybookDir(pbDir);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('scheduler: a proseAudit run that finds no manuscript at all fails instead of passing', async () => {
  // The vacuous pass: an audit with nothing to audit reports a clean book. A
  // ticket pointed at the wrong directory used to sail through the gate.
  const pbDir = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  const repo = fixtureRepo({}, 'main.py');
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({
      title: 'nothing to audit', prompt: 'do the thing', runner: 'echo', repo,
      testCmd: 'true', playbook: 'prose-pb', role: 'worker', maxRepairs: 0, mergeOnApprove: false,
    });
    await sched.drain(20_000);
    assert.equal(store.getTask(t.id)!.status, 'failed');
    assert.match(store.verdictsForTask(t.id)[0]?.critique ?? '', /prose audit: no manuscript files found/);
  } finally {
    store.close();
    cleanupPlaybookDir(pbDir);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('scheduler: deleting a chapter is fact drift, and the failure names the file', async () => {
  const pbDir = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  const repo = fixtureRepo({
    'chapter-01.md': '# Chapter One\n\nLinnet spoke to Juniper on the dock.\n',
    'chapter-02.md': '# Chapter Two\n\nThe tide came in before dawn.\n',
  });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({
      title: 'delete a chapter', prompt: 'rm chapter-01.md',
      kind: 'code', runner: 'shell', repo,
      testCmd: 'true', playbook: 'prose-pb', role: 'worker', maxRepairs: 0, mergeOnApprove: false,
    });
    await sched.drain(20_000);
    assert.equal(store.getTask(t.id)!.status, 'failed');
    const critique = store.verdictsForTask(t.id)[0]?.critique ?? '';
    assert.match(critique, /fact drift:/);
    assert.match(critique, /chapter-01\.md: deleted/, 'a deleted scene drops every fact in it at once');
  } finally {
    store.close();
    cleanupPlaybookDir(pbDir);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('scheduler: a renamed chapter is checked against its old name, not treated as new', async () => {
  const body = [
    '# Chapter One', '', 'Linnet spoke to Juniper on the dock.',
    'The tide came in before dawn and the gulls went quiet.',
    'She counted the coins twice and put the jar back on the shelf.',
    'The lamp burned low against the window.', '',
  ].join('\n');
  const pbDir = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  const repo = fixtureRepo({ 'chapter-01.md': body });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    // Renamed AND tightened: similar enough that git reports one rename, with
    // Juniper gone. Against a bare `--name-only` list this read as a brand-new
    // file with no pre-image, so the dropped name was invisible.
    const rewritten = body.replace('Linnet spoke to Juniper on the dock.', 'Linnet spoke on the dock.');
    const t = store.addTask({
      title: 'rename and tighten',
      prompt: `rm chapter-01.md && cat > chapter-01-the-dock.md <<'EOF'\n${rewritten}EOF\n`,
      kind: 'code', runner: 'shell', repo,
      testCmd: 'true', playbook: 'prose-pb', role: 'worker', maxRepairs: 0, mergeOnApprove: false,
    });
    await sched.drain(20_000);
    assert.equal(store.getTask(t.id)!.status, 'failed');
    const critique = store.verdictsForTask(t.id)[0]?.critique ?? '';
    assert.match(critique, /fact drift:/);
    assert.match(critique, /chapter-01\.md -> chapter-01-the-dock\.md/, 'the failure names both sides of the move');
    assert.match(critique, /Juniper/);
  } finally {
    store.close();
    cleanupPlaybookDir(pbDir);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('scheduler: a manuscript in a non-repo jail is still audited; only fact drift is skipped', async () => {
  // A book does not have to live in a git repo. Gating the whole audit on
  // jail.repo meant a scratch-dir manuscript was never checked at all.
  const pbDir = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({
      title: 'tic-heavy chapter, no repo',
      prompt: `cp ${path.join(FIXTURES, 'tic-heavy.md')} chapter-01.md`,
      runner: 'shell', playbook: 'prose-pb', role: 'worker', maxRepairs: 0, mergeOnApprove: false,
    });
    await sched.drain(20_000);
    assert.equal(store.getTask(t.id)!.status, 'failed');
    assert.match(store.verdictsForTask(t.id)[0]?.critique ?? '', /prose audit:.*HARD BAN/s);
  } finally {
    store.close();
    cleanupPlaybookDir(pbDir);
  }
});

test('scheduler: a clean non-repo manuscript passes, and the log says fact drift was skipped', async () => {
  const pbDir = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({
      title: 'clean chapter, no repo',
      prompt: "cat > chapter-01.md <<'EOF'\n# Chapter One\n\nThe rain fell on the tin roof. Juniper counted the coins.\nEOF\n",
      runner: 'shell', playbook: 'prose-pb', role: 'worker', mergeOnApprove: false,
    });
    await sched.drain(20_000);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    const log = store.eventsForTask(t.id).map((e) => e.message);
    assert.ok(log.some((m) => /prose audit passed \(1 file\(s\)/.test(m)), 'the audit really ran');
    assert.ok(
      log.some((m) => /fact drift check skipped/.test(m)),
      'and said why its git half could not: there is no pre-image without a repo',
    );
  } finally {
    store.close();
    cleanupPlaybookDir(pbDir);
  }
});

test('scheduler: a clean proseAudit run reaches awaiting-approval', async () => {
  const pbDir = withPlaybookDir({ 'pb.md': PROSE_PLAYBOOK(true) });
  const repo = fixtureRepo({ 'chapter-01.md': '# Chapter One\n\nThe rain fell on the tin roof. Juniper counted the coins.\n' });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({
      title: 'clean chapter', prompt: 'do the thing', runner: 'echo', repo,
      testCmd: 'true', playbook: 'prose-pb', role: 'worker', mergeOnApprove: false,
    });
    await sched.drain(20_000);
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'awaiting-approval');
  } finally {
    store.close();
    cleanupPlaybookDir(pbDir);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
