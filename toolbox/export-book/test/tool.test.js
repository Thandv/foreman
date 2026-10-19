import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipAll } from '../zip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'tool.js');

function run(input, cwd) {
  return spawnSync(process.execPath, [TOOL], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd,
  });
}

function workdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'export-book-'));
}

const BOOK = {
  title: 'The Long Road',
  author: 'A. Writer',
  chapters: [
    {
      number: 1,
      title: 'First Watch',
      markdown: 'The *lantern* swung, and the room fell **silent**.\n\n---\n\nA second scene begins here.',
    },
    { number: 2, title: 'Second Watch', markdown: 'More prose follows in chapter two.' },
  ],
};

/** A minimal, self-contained XML tag-balance checker — "our own reader" for
 *  asserting document.xml is well-formed enough to trust, independent of the
 *  writer that produced it. Not a full XML parser: it walks every open/close/
 *  self-closing tag and asserts they nest correctly. */
function assertWellFormedXml(xml, label) {
  const tagRe = /<(\/?)([a-zA-Z0-9:_-]+)([^>]*?)(\/?)>/g;
  const stack = [];
  let m;
  let sawAny = false;
  while ((m = tagRe.exec(xml)) !== null) {
    const [, closing, name, , selfClosing] = m;
    if (name === '?xml' || m[0].startsWith('<?') || m[0].startsWith('<!')) continue;
    sawAny = true;
    if (selfClosing || m[0].endsWith('/>')) continue;
    if (closing) {
      const top = stack.pop();
      assert.equal(top, name, `${label}: mismatched close tag </${name}> (expected </${top}>)`);
    } else {
      stack.push(name);
    }
  }
  assert.ok(sawAny, `${label}: no XML tags found at all`);
  assert.deepEqual(stack, [], `${label}: unclosed tags remain: ${stack.join(', ')}`);
}

test('happy path: docx unzips to a valid OOXML package with well-formed document.xml', () => {
  const dir = workdir();
  const res = run({ ...BOOK, format: 'docx', out: 'book.docx' }, dir);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.path, 'book.docx');

  const buf = fs.readFileSync(path.join(dir, 'book.docx'));
  assert.equal(out.bytes, buf.length);

  const entries = unzipAll(buf);
  assert.ok(entries.has('[Content_Types].xml'), 'missing [Content_Types].xml');
  assert.ok(entries.has('_rels/.rels'));
  assert.ok(entries.has('word/document.xml'));
  assert.ok(entries.has('word/styles.xml'));

  const documentXml = entries.get('word/document.xml').toString('utf8');
  assertWellFormedXml(documentXml, 'word/document.xml');
  assert.match(documentXml, /lantern/);
  assert.match(documentXml, /<w:i\/>/, 'italic run must carry <w:i/>');
  assert.match(documentXml, /<w:b\/>/, 'bold run must carry <w:b/>');
  assertWellFormedXml(entries.get('[Content_Types].xml').toString('utf8'), '[Content_Types].xml');
});

test('happy path: epub unzips with mimetype first and stored, and is a valid package', () => {
  const dir = workdir();
  const res = run({ ...BOOK, format: 'epub', out: 'book.epub' }, dir);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);

  const buf = fs.readFileSync(path.join(dir, 'book.epub'));
  assert.equal(out.bytes, buf.length);

  // mimetype must be the very first local entry, STORED (compression method 0).
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'first bytes must be a local file header');
  const method = buf.readUInt16LE(8);
  assert.equal(method, 0, 'mimetype must be stored, not deflated');
  const nameLen = buf.readUInt16LE(26);
  assert.equal(buf.toString('utf8', 30, 30 + nameLen), 'mimetype');

  const entries = unzipAll(buf);
  assert.equal([...entries.keys()][0], 'mimetype');
  assert.equal(entries.get('mimetype').toString('utf8'), 'application/epub+zip');
  assert.ok(entries.has('META-INF/container.xml'));
  assert.ok(entries.has('OEBPS/content.opf'));
  assert.ok(entries.has('OEBPS/toc.ncx'));
  assert.ok(entries.has('OEBPS/ch001.xhtml'));
  assert.ok(entries.has('OEBPS/ch002.xhtml'));

  const ch1 = entries.get('OEBPS/ch001.xhtml').toString('utf8');
  assert.match(ch1, /<em>lantern<\/em>/);
  assert.match(ch1, /<strong>silent<\/strong>/);
  assert.match(ch1, /class="scene-break"/);
  assertWellFormedXml(entries.get('OEBPS/content.opf').toString('utf8'), 'content.opf');
});

test('malformed input is rejected rather than guessed at', () => {
  const dir = workdir();
  const notJson = run('nope', dir);
  assert.notEqual(notJson.status, 0);

  const badFormat = run({ ...BOOK, format: 'pdf', out: 'x.pdf' }, dir);
  assert.notEqual(badFormat.status, 0);
  assert.match(badFormat.stderr, /format/);

  const noChapters = run({ title: 't', author: 'a', chapters: [], format: 'epub', out: 'x.epub' }, dir);
  assert.notEqual(noChapters.status, 0);
});

test('absolute and escaping output paths are refused, and nothing is written', () => {
  const dir = workdir();
  const abs = run({ ...BOOK, format: 'epub', out: '/tmp/should-not-exist.epub' }, dir);
  assert.notEqual(abs.status, 0);
  assert.match(abs.stderr, /refused|absolute/);

  const escape = run({ ...BOOK, format: 'epub', out: '../escape.epub' }, dir);
  assert.notEqual(escape.status, 0);
  assert.match(escape.stderr, /refused|escapes/);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'escape.epub')), false);
});

test('a dangling symlink inside the working directory is refused, not followed to write outside it', () => {
  const dir = workdir();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-book-outside-'));
  const outsideTarget = path.join(outsideDir, 'escaped.epub');
  fs.symlinkSync(outsideTarget, path.join(dir, 'link.epub'));

  const res = run({ ...BOOK, format: 'epub', out: 'link.epub' }, dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /refused|symlink/);
  assert.equal(fs.existsSync(outsideTarget), false, 'the dangling symlink must not have been followed to create the file outside the jail');
});

test('a symlink pointing at an existing file (even inside the jail) is refused', () => {
  const dir = workdir();
  fs.writeFileSync(path.join(dir, 'real.epub'), 'pre-existing contents');
  fs.symlinkSync(path.join(dir, 'real.epub'), path.join(dir, 'link-to-real.epub'));

  const res = run({ ...BOOK, format: 'epub', out: 'link-to-real.epub' }, dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /refused|symlink/);
  assert.equal(fs.readFileSync(path.join(dir, 'real.epub'), 'utf8'), 'pre-existing contents', 'the real file behind the symlink must be untouched');
});

test('a normal nested write (new subdirectories, no symlinks involved) still works', () => {
  const dir = workdir();
  const res = run({ ...BOOK, format: 'epub', out: 'nested/deep/book.epub' }, dir);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'nested', 'deep', 'book.epub')));
});

test('overwrote is false on a fresh write and true when an existing file is silently replaced', () => {
  const dir = workdir();
  const first = run({ ...BOOK, format: 'epub', out: 'book.epub' }, dir);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).overwrote, false);

  const second = run({ ...BOOK, format: 'epub', out: 'book.epub' }, dir);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).overwrote, true);
});

test('scene breaks and chapter ordering: chapters are sorted by number regardless of input order', () => {
  const dir = workdir();
  const shuffled = {
    ...BOOK,
    chapters: [BOOK.chapters[1], BOOK.chapters[0]],
    format: 'epub',
    out: 'book.epub',
  };
  const res = run(shuffled, dir);
  assert.equal(res.status, 0, res.stderr);
  const buf = fs.readFileSync(path.join(dir, 'book.epub'));
  const entries = unzipAll(buf);
  const ch1 = entries.get('OEBPS/ch001.xhtml').toString('utf8');
  assert.match(ch1, /First Watch/, 'chapter 1 must be written first regardless of input array order');
});

test('epub: the chapter and title-page XHTML carry the requested language, not a hard-coded "en"', () => {
  const dir = workdir();
  const res = run({ ...BOOK, language: 'pt-BR', format: 'epub', out: 'book.epub' }, dir);
  assert.equal(res.status, 0, res.stderr);
  const entries = unzipAll(fs.readFileSync(path.join(dir, 'book.epub')));
  for (const name of ['OEBPS/titlepage.xhtml', 'OEBPS/ch001.xhtml']) {
    assert.match(entries.get(name).toString('utf8'), /xml:lang="pt-BR"/, name);
  }
  assert.match(entries.get('OEBPS/content.opf').toString('utf8'), /<dc:language>pt-BR<\/dc:language>/);
  assert.notEqual(run({ ...BOOK, language: 'en" onload="x', format: 'epub', out: 'b2.epub' }, dir).status, 0);
});

test('control characters XML 1.0 forbids are dropped from text, so the package stays parseable', () => {
  const dir = workdir();
  const book = { ...BOOK, title: 'Bad\u000bTitle', chapters: [{ number: 1, title: 'T\u0001', markdown: 'Page\u000cbreak and \u0007bell.' }] };
  for (const format of ['docx', 'epub']) {
    const res = run({ ...book, format, out: `book.${format}` }, dir);
    assert.equal(res.status, 0, res.stderr);
    const entries = unzipAll(fs.readFileSync(path.join(dir, `book.${format}`)));
    for (const [name, data] of entries) {
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(data.toString('utf8'), /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, `${format}:${name}`);
    }
  }
});
