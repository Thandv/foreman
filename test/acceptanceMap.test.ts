import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { numberedItems, parseAcceptanceMap, checkAcceptanceMap, formatMapGaps, namesFile } from '../src/acceptanceMap.ts';
import { acceptanceBrief } from '../src/scheduler.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const NO_CHANGED_TEST = 'no changed test is mapped to any item; (diff) or an existing test alone does not show a code change works';
const fileDiff = (path: string, body: string): string =>
  `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${body}\n`;
const DIFF = fileDiff('test/foo.test.ts', "test('foo works', () => {});") + fileDiff('README.md', 'usage text');
const ACCEPTANCE = '1. foo works\n2. README.md documents usage\n3. looks right (operator)\n4. reviewed by eye (review)';
const MAP = 'done.\n\nACCEPTANCE MAP\n1. test/foo.test.ts :: foo works\n2. (diff) README.md\n';

test('acceptanceBrief asks for an ACCEPTANCE MAP and describes every line form', () => {
  const b = acceptanceBrief({ acceptance: ACCEPTANCE });
  assert.match(b, /ACCEPTANCE MAP/);
  assert.match(b, /N\. <test file> :: <test name>/);
  assert.match(b, /N\. \(diff\) <path>/);
  assert.match(b, /\(operator\)/);
  assert.match(b, /\(review\)/);
  assert.equal(acceptanceBrief({ acceptance: null }), '');
});

test('numberedItems splits on N. lines, keeps continuations, marks exempt items', () => {
  const items = numberedItems('1. first\n   more of first\n2. second (operator)\n3. third (review)');
  assert.deepEqual(
    items.map((i) => [i.n, i.exempt]),
    [[1, null], [2, 'operator'], [3, 'review']],
  );
  assert.match(items[0]!.text, /more of first/);
  assert.deepEqual(numberedItems('no numbers here'), []);
});

test('numberedItems exempts only an explicit leading or trailing marker, not a mention', () => {
  const items = numberedItems(
    [
      '1. (operator) clangd --check=main.cpp passes',
      '2. (review) Tests fail without the change.',
      '3. really needs eyes (operator)',
      '4. A worker line `N. (operator)` for an item not marked (operator) is a gap',
      '5. mentions `(review)` only',
      '6. first line (operator)\n   second line',
    ].join('\n'),
  );
  assert.deepEqual(items.map((i) => i.exempt), ['operator', 'review', 'operator', null, null, null]);
});

test('numberedItems splits items written inline on one line, only when numbered consecutively from 1', () => {
  const items = numberedItems(
    '1. Apply after a failed run starts run. 2. The test fails on 7b6d8ba. 3. The default-edition no-AI check still passes. 4. npm run verify passes.',
  );
  assert.deepEqual(items.map((i) => i.text), [
    'Apply after a failed run starts run.',
    'The test fails on 7b6d8ba.',
    'The default-edition no-AI check still passes.',
    'npm run verify passes.',
  ]);
  assert.deepEqual(numberedItems('1. does a. 2. manual check (operator) 3. eyeball (review)').map((i) => i.exempt), [null, 'operator', 'review']);
  for (const prose of ['1. Support version 1.2 and v1.2 here.', '1. Needs Node 24. Then run it, see item 3.', 'Node 24. Then 3. stuff']) {
    assert.equal(numberedItems(prose).length, prose.startsWith('1.') ? 1 : 0, prose);
  }
});

test('a complete map passes; a missing line is unmapped', () => {
  assert.deepEqual(checkAcceptanceMap({ acceptance: ACCEPTANCE, report: MAP, diff: DIFF }), []);
  const gaps = checkAcceptanceMap({ acceptance: ACCEPTANCE, report: MAP.replace('2. (diff) README.md\n', ''), diff: DIFF });
  assert.deepEqual(gaps, [{ n: 2, reason: 'unmapped' }]);
});

test('map lines copied with the brief\'s backticks still parse', () => {
  const wrapped = 'ACCEPTANCE MAP\n`1. test/foo.test.ts :: foo works`\n`2. (diff) README.md`\n';
  assert.deepEqual(checkAcceptanceMap({ acceptance: ACCEPTANCE, report: wrapped, diff: DIFF }), []);
  assert.deepEqual(parseAcceptanceMap('ACCEPTANCE MAP\n`3. (operator)`').get(3), { kind: 'operator' });
});

test('a test file absent from the diff, and a test name absent from its diff text, are reported', () => {
  const noFile = checkAcceptanceMap({ acceptance: ACCEPTANCE, report: MAP.replace('test/foo.test.ts', 'test/bar.test.ts'), diff: DIFF });
  assert.deepEqual(noFile, [{ n: 1, reason: 'test file not in diff' }]);
  const noName = checkAcceptanceMap({ acceptance: ACCEPTANCE, report: MAP.replace('foo works', 'nope'), diff: DIFF });
  assert.deepEqual(noName, [{ n: 1, reason: 'test name not found' }]);
});

test('a test name found only in the file path, the header or a removed line is not found', () => {
  const diff =
    'diff --git a/test/foo.test.ts b/test/foo.test.ts\nindex 111..222 100644\n--- a/test/foo.test.ts\n+++ b/test/foo.test.ts\n@@ -1 +1 @@\n-test(\'old name\', () => {});\n+test(\'foo works\', () => {});\n';
  for (const name of ['foo.test', 'test/foo', 'old name', 'index']) {
    const gaps = checkAcceptanceMap({ acceptance: '1. foo works', report: `ACCEPTANCE MAP\n1. test/foo.test.ts :: ${name}`, diff });
    assert.deepEqual(gaps, [{ n: 1, reason: 'test name not found' }], name);
  }
  assert.deepEqual(checkAcceptanceMap({ acceptance: '1. foo works', report: 'ACCEPTANCE MAP\n1. test/foo.test.ts :: foo works', diff }), []);
});

test('a modified test is found by its hunk heading or context; an escaped quote in the title still matches', () => {
  // Kiln's raw-stdin ticket: the bodies of two existing tests changed (titles only in the @@ headings), and a new
  // title was written 'program\\'s' in source but mapped as "program's".
  const diff =
    'diff --git a/test/raw.test.ts b/test/raw.test.ts\nindex 111..222 100644\n--- a/test/raw.test.ts\n+++ b/test/raw.test.ts\n' +
    "@@ -182,6 +182,8 @@ test('a real C++ program reads an int', async () => {\n   const f = start();\n+  await poll(f);\n   assert.ok(f);\n" +
    "@@ -205,4 +207,3 @@ test('a removed-only hunk', () => {\n   one();\n-  two();\n   three();\n" +
    "@@ -220,2 +221,5 @@ next();\n context();\n+test('programOutput counts the program\\'s output only', () => {\n+});\n+test('neighbour', () => {});\n";
  const map = (name: string): string => `ACCEPTANCE MAP\n1. test/raw.test.ts :: ${name}`;
  for (const name of ['a real C++ program reads an int', "programOutput counts the program's output only", 'context();']) {
    assert.deepEqual(checkAcceptanceMap({ acceptance: '1. it works', report: map(name), diff }), [], name);
  }
  // A hunk that only removes lines changed nothing a test could pass on: its heading does not count.
  assert.deepEqual(checkAcceptanceMap({ acceptance: '1. it works', report: map('a removed-only hunk'), diff }), [{ n: 1, reason: 'test name not found' }]);
  assert.deepEqual(checkAcceptanceMap({ acceptance: '1. it works', report: map('two();'), diff }), [{ n: 1, reason: 'test name not found' }]);
});

test('(operator)/(review) lines: gap for an unmarked item, accepted for a marked one, marked item needs no line', () => {
  const optOut = checkAcceptanceMap({ acceptance: ACCEPTANCE, report: MAP.replace('1. test/foo.test.ts :: foo works', '1. (operator)'), diff: DIFF });
  assert.deepEqual(optOut, [{ n: 1, reason: 'not exempt' }]);
  const marked = checkAcceptanceMap({ acceptance: ACCEPTANCE, report: MAP + '3. (operator)\n4. (review)\n', diff: DIFF });
  assert.deepEqual(marked, []);
  assert.deepEqual(checkAcceptanceMap({ acceptance: ACCEPTANCE, report: MAP, diff: DIFF }), [], 'marked items with no line');
});

test('(diff) <path> needs the path in the diff; an item that does not name it is accepted when the diff changes no code', () => {
  const ok = checkAcceptanceMap({ acceptance: '1. README.md documents usage', report: 'ACCEPTANCE MAP\n1. (diff) README.md', diff: DIFF });
  assert.deepEqual(ok, []);
  const absent = checkAcceptanceMap({ acceptance: '1. README.md documents usage', report: 'ACCEPTANCE MAP\n1. (diff) README.md', diff: fileDiff('src/a.ts', 'x') });
  assert.deepEqual(absent, [{ n: 1, reason: 'file not in diff' }]);
  const unnamed = checkAcceptanceMap({ acceptance: '1. usage is documented', report: 'ACCEPTANCE MAP\n1. (diff) README.md', diff: DIFF });
  assert.deepEqual(unnamed, [], 'the item does not have to name the file: this diff is a test and a document');
  // The same line when the diff also changes code and no item is mapped to a test of the change: a gap, as on main.
  const code = checkAcceptanceMap({ acceptance: '1. usage is documented', report: 'ACCEPTANCE MAP\n1. (diff) README.md', diff: DIFF + fileDiff('src/a.ts', 'x') });
  assert.deepEqual(code, [{ n: 1, reason: NO_CHANGED_TEST }]);
});

test('a missing map leaves every non-exempt item unmapped; no numbered items means no gaps; formatMapGaps lists the gap items', () => {
  const gaps = checkAcceptanceMap({ acceptance: ACCEPTANCE, report: 'all done', diff: DIFF });
  assert.deepEqual(gaps.map((g) => [g.n, g.reason]), [[1, 'unmapped'], [2, 'unmapped']]);
  assert.deepEqual(checkAcceptanceMap({ acceptance: 'just prose', report: '', diff: DIFF }), []);
  assert.deepEqual(checkAcceptanceMap({ acceptance: null, report: null, diff: '' }), []);
  const text = formatMapGaps(gaps);
  assert.match(text, /^1\. unmapped\n2\. unmapped$/);
  assert.equal(formatMapGaps([]), '');
  assert.equal(parseAcceptanceMap('nothing').size, 0);
});

test('a short item that only says the gate passes is exempt: the gate run proves it, no test in the diff can', () => {
  // Kiln epic B's clang-tidy-profile ticket failed both pre-review rounds on "4. npm run verify passes."
  const acceptance =
    '1. All five checks are in "disable". 2. clang-analyzer-* is still enabled. 3. The pinned tests fail against the old profile. 4. npm run verify passes.';
  const items = numberedItems(acceptance);
  assert.deepEqual(items.map((i) => i.exempt), [null, null, null, 'gate']);
  const diff = 'diff --git a/test/p.test.ts b/test/p.test.ts\n+++ b/test/p.test.ts\n+test("profile disables", () => {});\n';
  const report = 'ACCEPTANCE MAP\n1. test/p.test.ts :: profile disables\n2. test/p.test.ts :: profile disables\n3. test/p.test.ts :: profile disables\n4. test/p.test.ts :: some untouched test';
  assert.deepEqual(checkAcceptanceMap({ acceptance, report, diff }), []);
  for (const gate of [
    'The gate passes: npx tsc --noEmit, then every test file except test/dbperf.test.ts.',
    '`npm run verify` passes with all stubs.',
    'npm test passes',
  ]) assert.equal(numberedItems(`1. a thing works. 2. ${gate}`)[1]?.exempt, 'gate', gate);
  for (const real of [
    'Ctrl-C stops the program and npm run verify passes.',
    'The verify script prints the summary line when it passes.',
    `npm run verify passes, and ${'the CLI prints one line per finding with its file, line and check, '.repeat(3)}`,
  ]) assert.equal(numberedItems(`1. a thing works. 2. ${real}`)[1]?.exempt, null, real.slice(0, 50));
});

test('a docs item naming a file by its stem ("README\'s", "SPEC-CPP §1") is covered by a (diff) line for that file', () => {
  // Kiln's docs ticket t_43f38a70cd failed both pre-review rounds on exactly these items while its map was right.
  const diff = fileDiff('README.md', 'cpp recursive') + fileDiff('SPEC-CPP.md', 'parseable fixits') + fileDiff('src/server.ts', 'x');
  const acceptance =
    "1. README's .kiln.json section documents \"cpp\": {\"recursive\": true}.\n" +
    '2. SPEC-CPP §1 describes text diagnostics with -fdiagnostics-parseable-fixits.\n' +
    '3. The server answers 403 for an unreadable project.';
  const report = 'ACCEPTANCE MAP\n1. (diff) README.md\n2. (diff) SPEC-CPP.md\n3. (diff) src/server.ts\n';
  // Items 1 and 2 name their files. Item 3 is behaviour mapped to a source file, in a code change with no test
  // mapped anywhere: a gap, as it was when the reason read "item does not name file".
  assert.deepEqual(checkAcceptanceMap({ acceptance, report, diff }), [{ n: 3, reason: NO_CHANGED_TEST }]);
});

test('namesFile: a stem counts only as a whole word, and plain lowercase stems stay strict', () => {
  assert.equal(namesFile("README's usage section", 'README.md'), true);
  assert.equal(namesFile('see docs/SPEC-CPP.md', 'docs/SPEC-CPP.md'), true);
  assert.equal(namesFile('SPEC-CPP §1 says', 'SPEC.md'), false, 'SPEC is not a whole word inside SPEC-CPP');
  assert.equal(namesFile('READMEFILE has it', 'README.md'), false);
  assert.equal(namesFile('the README.txt says', 'README.md'), false, 'another file with the same stem');
  assert.equal(namesFile('the server answers 403', 'src/server.ts'), false, 'a behaviour item cannot hide behind a lowercase stem');
  assert.equal(namesFile('a.ts is fine', 'b.ts'), false);
});

test('namesFile: a code file is named only by its base name or path, never by its stem', () => {
  assert.equal(namesFile('the App shows the welcome banner', 'src/App.tsx'), false, 'a behaviour item cannot hide behind App.tsx');
  assert.equal(namesFile('the Server rejects unauthenticated calls', 'src/Server.ts'), false);
  assert.equal(namesFile('the API returns 404 for unknown ids', 'src/API.ts'), false);
  assert.equal(namesFile('App.tsx renders the banner', 'src/App.tsx'), true, 'the base name still counts');
  assert.equal(namesFile('see src/API.ts', 'src/API.ts'), true);
  // Documents keep the stem match.
  assert.equal(namesFile("README's usage section", 'README.md'), true);
  assert.equal(namesFile('SPEC-CPP §1 says', 'docs/SPEC-CPP.md'), true);
  assert.equal(namesFile('CHANGELOG lists it', 'CHANGELOG.rst'), true);
});

// ------------------------------------------------- the three line forms, replayed from the Kiln trial (F7)

/** A work tree holding `files`; removed when the test ends. */
function tree(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-map-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** A modified file's patch: one hunk adding `added` under the heading git would print. */
const hunk = (file: string, added: string, heading = ''): string =>
  `diff --git a/${file} b/${file}\nindex 111..222 100644\n--- a/${file}\n+++ b/${file}\n@@ -10,2 +10,3 @@ ${heading}\n context\n+${added}\n context\n`;

// t_d41d3280e6 (lock-file path in the already-running message): acceptance and map lines as the ledger holds them.
const LOCK_ACCEPTANCE =
  "1. The refusal message contains the lock file's absolute path, the pid and the port. 2. A test pins all three and fails without the change. " +
  '3. The README Serve section quotes the new message exactly. 4. Lock acquisition and replacement logic is unchanged. 5. `npm run verify` passes.';
const LOCK_DIFF =
  hunk('README.md', 'kiln: already running (pid N, port P). Lock file: <path>.') +
  hunk('src/server.ts', 'const lockedError = (held: Lock, file: string): Error => new Error(`Lock file: ${file}.`);') +
  hunk('test/server-lock.test.ts', "test('the refusal for a live lock names the lock file full path, the pid and the port', { timeout: 60000 }, async (t) => {");
const LOCK_TEST_FILE =
  "test('the refusal for a live lock names the lock file full path, the pid and the port', { timeout: 60000 }, async (t) => {\n});\n" +
  "test('a lock whose pid is gone is replaced even when something else answers on its port', async (t) => {\n});\n";
const lockMap = (item4: string): string =>
  'ACCEPTANCE MAP\n' +
  '1. test/server-lock.test.ts :: the refusal for a live lock names the lock file full path, the pid and the port\n' +
  '2. test/server-lock.test.ts :: the refusal for a live lock names the lock file full path, the pid and the port\n' +
  `3. (diff) README.md\n4. ${item4}\n5. (diff) package.json\n`;

test('trial t_d41d3280e6 item 4, a no-change claim: `(diff) src/server.ts` passes, and so does a test that was already in the file', (t) => {
  const dir = tree(t, { 'test/server-lock.test.ts': LOCK_TEST_FILE });
  // Round 1 mapped the item to the file whose diff shows the logic untouched; it was flagged "item does not name file".
  assert.deepEqual(checkAcceptanceMap({ acceptance: LOCK_ACCEPTANCE, report: lockMap('(diff) src/server.ts'), diff: LOCK_DIFF, treeDir: dir }), []);
  // Round 3 mapped it to an existing test the diff does not touch; it was flagged "test name not found".
  const existing = 'test/server-lock.test.ts :: a lock whose pid is gone is replaced even when something else answers on its port';
  assert.deepEqual(checkAcceptanceMap({ acceptance: LOCK_ACCEPTANCE, report: lockMap(existing), diff: LOCK_DIFF, treeDir: dir }), []);
  // The same line with a title the file does not hold is still a gap, for the right reason.
  const invented = 'test/server-lock.test.ts :: a lock whose pid is gone is replaced';
  assert.deepEqual(
    checkAcceptanceMap({ acceptance: LOCK_ACCEPTANCE, report: lockMap(`${invented}, always`), diff: LOCK_DIFF, treeDir: dir }),
    [{ n: 4, reason: 'test name not found' }],
  );
  // And a (diff) line for a file the diff does not touch is a gap named as that.
  assert.deepEqual(
    checkAcceptanceMap({ acceptance: LOCK_ACCEPTANCE, report: lockMap('(diff) src/lock.ts'), diff: LOCK_DIFF, treeDir: dir }),
    [{ n: 4, reason: 'file not in diff' }],
  );
});

test('trial t_e17a601f04 item 3 and t_694071e43e item 4: a `(diff)` line for a file in the diff is not flagged', () => {
  const clangd =
    '1. `.kiln-build` and a `.clangd` carrying Kiln\'s mark are absent from the file list. 2. A `.clangd` without the mark is listed (test). ' +
    '3. The mark is recognised through the existing helper, not a copied string. 4. All listing routes agree; direct reads of these paths are unchanged. 5. `npm run verify` passes.';
  const listing = 'test/listing-kiln-files.test.ts';
  const titles = [
    'a project with .kiln-build and a marked .clangd lists neither in the tree or the files list',
    "an unmarked .clangd is the user's and is listed in the tree and the files list",
    'hiding is for the listing only: the marked .clangd and the build files still read by name',
  ];
  const diff = hunk('src/cpp/clangd-mark.ts', 'export const CLANGD_MARK = MARK;') + hunk(listing, titles.map((name) => `test('${name.replace(/'/g, "\\'")}', () => {`).join('\n+'));
  const report =
    `ACCEPTANCE MAP\n1. ${listing} :: ${titles[0]}\n2. ${listing} :: ${titles[1]}\n3. (diff) src/cpp/clangd-mark.ts\n4. ${listing} :: ${titles[2]}\n` +
    '5. `npm run verify` passed through the test slot, exit 0.\n';
  assert.deepEqual(checkAcceptanceMap({ acceptance: clangd, report, diff }), []);

  const interrupted =
    '1. On start-up a running record with a dead pid becomes interrupted and is not deleted. 2. Retention prunes an interrupted record by the same rule as a finished one (test). ' +
    '3. A running record with a live pid is untouched (test). 4. Every place that enumerates run statuses handles the new value. ' +
    '5. The report states the rule for old records with no owner information. 6. `npm run verify` passes.';
  const runs = 'test/interrupted-runs.test.ts';
  const names = [
    'a running record with a dead pid becomes interrupted, keeps its logs, and is pruned like a finished run',
    'a running record whose owner is alive is left untouched',
    'a running record with no owner (written before the field) is left as it is',
  ];
  const runsDiff = hunk('ui/style.css', '.dot.interrupted { background: var(--warn); }') + hunk('src/types.ts', "| 'interrupted'") + hunk(runs, names.map((name) => `test('${name}', () => {`).join('\n+'));
  const runsMap = (item4: string): string =>
    `ACCEPTANCE MAP\n1. ${runs} :: ${names[0]}\n2. ${runs} :: ${names[0]}\n3. ${runs} :: ${names[1]}\n4. ${item4}\n5. ${runs} :: ${names[2]}\n6. (diff) package.json\n`;
  for (const item4 of ['(diff) ui/style.css', '(diff) src/types.ts']) {
    assert.deepEqual(checkAcceptanceMap({ acceptance: interrupted, report: runsMap(item4), diff: runsDiff }), [], item4);
  }
});

test('trial t_b36bf5a477, a README-only ticket: `(diff) README.md` on every line is a complete map; a file outside the diff is not', () => {
  const acceptance =
    '1. README has exactly one Security model section, covering project confinement, the trust prompt, the session token and cookie, output caps, fixed-argv fixes and install offers. ' +
    "2. It states what Kiln does not defend, including that a program the user runs has the user's own access. " +
    '3. The session cookie is documented where the token is documented (Serve section), with attributes matching the code. ' +
    '4. The report maps every claim to a source file and function, and reviewer spot-checks find no claim the code does not keep. 5. No source file changed; `npm run verify` passes.';
  const diff = hunk('README.md', '## Security model');
  const report = 'ACCEPTANCE MAP\n1. (diff) README.md\n2. (diff) README.md\n3. (diff) README.md\n4. (diff) README.md\n5. (diff) README.md\n';
  assert.deepEqual(checkAcceptanceMap({ acceptance, report, diff }), []);
  // t_92036a5aae item 4 named a reused fixture the diff does not hold: that one was a real gap and still is.
  assert.deepEqual(
    checkAcceptanceMap({ acceptance, report: report.replace('4. (diff) README.md', '4. (diff) test/fixtures/helper/cpp/cpp-expected-semicolon.txt'), diff }),
    [{ n: 4, reason: 'file not in diff' }],
  );
});

test('a test line: the file must be in the diff or the tree, and the title in that file, not merely somewhere in the diff', (t) => {
  const dir = tree(t, {
    'test/a.test.ts': "test('alpha holds', () => {});\n",
    'test/b.test.ts': "test('beta holds', () => {});\n",
  });
  const diff = hunk('test/a.test.ts', "test('alpha holds', () => {});") + hunk('src/x.ts', "// see the test 'beta holds'");
  const check = (line: string, treeDir: string | null = dir) =>
    checkAcceptanceMap({ acceptance: '1. it holds', report: `ACCEPTANCE MAP\n1. ${line}`, diff, treeDir });
  assert.deepEqual(check('test/a.test.ts :: alpha holds'), []);
  // A test that was already there, in a file the diff does not touch, is read from the tree — and is accepted beside
  // an item mapped to a test of this change, not as the only evidence a code change has.
  const two = (line: string) =>
    checkAcceptanceMap({ acceptance: '1. it holds\n2. the rest is unchanged', report: `ACCEPTANCE MAP\n1. test/a.test.ts :: alpha holds\n2. ${line}`, diff, treeDir: dir });
  assert.deepEqual(two('test/b.test.ts :: beta holds'), [], 'a file the diff does not touch, read from the tree');
  assert.deepEqual(two('test/b.test.ts :: beta'), [{ n: 2, reason: 'test name not found' }], 'part of a title is not a title');
  assert.deepEqual(check('test/b.test.ts :: beta holds'), [{ n: 1, reason: NO_CHANGED_TEST }], 'alone, in a code change, it is a gap');
  assert.deepEqual(check('test/b.test.ts :: beta holds', null), [{ n: 1, reason: 'test file not in diff' }], 'with no tree there is only the diff');
  assert.deepEqual(check('test/a.test.ts :: beta holds'), [{ n: 1, reason: 'test name not found' }], 'the title is in the diff and in another file, not in this one');
  assert.deepEqual(check('test/c.test.ts :: gamma holds'), [{ n: 1, reason: 'test file not in diff or tree' }]);
  assert.deepEqual(check('../outside.test.ts :: alpha holds'), [{ n: 1, reason: 'test file not in diff or tree' }], 'a path out of the tree is not read');
});

test('a mapped test file that is a FIFO or a link out of the tree is not read: the check returns promptly and names the gap', (t) => {
  const outside = tree(t, { 'secret.test.ts': "test('alpha holds', () => {});\n" });
  const dir = tree(t, { 'test/keep.txt': '' });
  execFileSync('mkfifo', [path.join(dir, 'test/fifo.test.ts')]);
  fs.symlinkSync(path.join(outside, 'secret.test.ts'), path.join(dir, 'test/link.test.ts'));
  fs.symlinkSync(outside, path.join(dir, 'linked'));
  for (const file of ['test/fifo.test.ts', 'test/link.test.ts', 'linked/secret.test.ts']) {
    const gaps = checkAcceptanceMap({ acceptance: '1. it holds', report: `ACCEPTANCE MAP\n1. ${file} :: alpha holds`, diff: hunk('src/x.ts', 'x'), treeDir: dir });
    assert.deepEqual(gaps, [{ n: 1, reason: 'test file not in diff or tree' }], file);
  }
});

test('(operator) is accepted only for an item the acceptance text itself marks (operator)', () => {
  const acceptance = '1. the page renders (operator)\n2. src/x.ts handles a 200';
  const diff = hunk('src/x.ts', 'x');
  assert.deepEqual(checkAcceptanceMap({ acceptance, report: 'ACCEPTANCE MAP\n1. (operator)\n2. (diff) src/x.ts', diff }), []);
  assert.deepEqual(checkAcceptanceMap({ acceptance, report: 'ACCEPTANCE MAP\n1. (operator)\n2. (operator)', diff }), [{ n: 2, reason: 'not exempt' }]);
});
