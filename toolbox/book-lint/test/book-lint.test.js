import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, '..', 'tool.js');
const call = (input) => {
  const res = spawnSync(process.execPath, [TOOL], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};

test('scan flags straight quotes, double spaces, repeated words', () => {
  const out = call({ files: [{ path: 'a.md', text: '"Hello" he  said the the word.' }] });
  const rules = out.findings.map((f) => f.rule);
  assert.ok(rules.includes('straight-double-quote'));
  assert.ok(rules.includes('multiple-spaces'));
  assert.ok(rules.includes('repeated-word'));
});

test('continued dialogue does not trip quote balance; a real imbalance does', () => {
  const ok = call({ files: [{ path: 'a.md', text: '“First paragraph continues\n\n“and closes here.”' }] });
  assert.ok(!ok.findings.some((f) => f.rule === 'unbalanced-smart-quotes'));
  const bad = call({ files: [{ path: 'a.md', text: '“Never closed\n\nPlain narration after.' }] });
  assert.ok(bad.findings.some((f) => f.rule === 'unbalanced-smart-quotes'));
});

test('fix smartens quotes, handles apostrophes and elisions, keeps headings untouched', () => {
  const out = call({ mode: 'fix', files: [{ path: 'a.md', text: '# "Title"\n\n"It\'s \'em all right," she said.' }] });
  const t = out.files[0].text;
  assert.ok(t.includes('# "Title"'));
  assert.equal(t.split('\n')[2], '“It’s ’em all right,” she said.');
});

test('fix normalizes ellipsis to the dominant style and strips trailing space', () => {
  const out = call({ mode: 'fix', files: [{ path: 'a.md', text: 'He waited… then… no... \nMore… text…' }] });
  assert.equal(out.ellipsis, 'unicode');
  assert.ok(!out.files[0].text.includes('...'));
  assert.ok(!/ $/m.test(out.files[0].text));
});

test('scan-only rules are not auto-fixed', () => {
  const out = call({ mode: 'fix', files: [{ path: 'a.md', text: 'the the word - here' }] });
  assert.ok(out.files[0].text.includes('the the'));
  assert.ok(out.files[0].text.includes(' - '));
});

test('markdown hard breaks (two trailing spaces) are preserved and not flagged', () => {
  const scan = call({ files: [{ path: 'a.md', text: 'A hard break line  \nsloppy line   \n' }] });
  const tw = scan.findings.filter((f) => f.rule === 'trailing-whitespace');
  assert.equal(tw.length, 1);
  assert.equal(tw[0].line, 2);
  const out = call({ mode: 'fix', files: [{ path: 'a.md', text: 'A hard break line  \nsloppy line   \n' }] });
  assert.ok(out.files[0].text.startsWith('A hard break line  \n'));
  assert.ok(out.files[0].text.includes('sloppy line\n'));
});

test('list bullets are not hyphen-as-dash; inline spaced hyphens are', () => {
  const out = call({ files: [{ path: 'a.md', text: '  - **Physical:** a list item\nwords - joined like a dash' }] });
  const hd = out.findings.filter((f) => f.rule === 'hyphen-as-dash');
  assert.equal(hd.length, 1);
  assert.equal(hd[0].line, 2);
});

test('CRLF files: trailing whitespace before \\r is found and fixed, and CRLF is preserved', () => {
  const scan = call({ files: [{ path: 'a.md', text: 'Hello there.   \r\nNext line.\r\n' }] });
  assert.ok(scan.findings.some((f) => f.rule === 'trailing-whitespace' && f.line === 1));
  const fix = call({ mode: 'fix', files: [{ path: 'a.md', text: 'Hello there.   \r\nNext line.\r\n' }] });
  assert.equal(fix.files[0].text, 'Hello there.\r\nNext line.\r\n');
});

test('lines inside a fenced code block are neither flagged nor rewritten', () => {
  const text = 'Prose here.\n```\nconst s = "x" ;\n```\n~~~\nit \'s code\n~~~\n';
  const scan = call({ files: [{ path: 'a.md', text }] });
  assert.deepEqual(scan.findings.filter((f) => f.line >= 2 && f.line <= 7), []);
  const fix = call({ mode: 'fix', files: [{ path: 'a.md', text }] });
  assert.equal(fix.files[0].text, text);
});

test("a decade elision ('90s) smartens to an apostrophe, not an opening quote", () => {
  const fix = call({ mode: 'fix', files: [{ path: 'a.md', text: "Back in the '90s and in '49." }] });
  assert.equal(fix.files[0].text, 'Back in the ’90s and in ’49.');
});

test('malformed input is rejected cleanly (null file entry, unknown ellipsis style)', () => {
  for (const input of [{ files: [null] }, { mode: 'fix', ellipsis: 'dashes', files: [{ path: 'a', text: '' }] }]) {
    const res = spawnSync(process.execPath, [TOOL], { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(res.status, 2, res.stderr);
  }
});
