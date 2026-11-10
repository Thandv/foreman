import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALLOW, countRawDb, ratchet, type RawDbCounts } from '../scripts/checks/no-raw-db.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'checks', 'no-raw-db.ts');

/** Counts the raw ledger SQL in a temp tree holding `files`, then removes the tree. */
function counts(files: Record<string, string>): Map<string, RawDbCounts> {
  const dir = scratchDir('foreman-norawdb-');
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return countRawDb(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('no-raw-db: today\'s tree passes and prints the outside-queue write and writable-opener counts', () => {
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^raw writes outside queue: 0$/m);
  assert.match(r.stdout, /^writable openers outside queue: 1$/m);
});

test('no-raw-db: a new file with a multi-line store.db chain fails with the file named', () => {
  const found = counts({ 'src/newThing.ts': 'export const n = (store: S) => store.db\n  .prepare(\n    "SELECT 1")\n  .get();\n' });
  assert.deepEqual([...found], [['src/newThing.ts', { reads: 1, writes: 0, readOnlyOpeners: 0, writableOpeners: 0 }]]);
  const problems = ratchet(new Map([...countRawDb(root), ...found]), ALLOW);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0]!, /src\/newThing\.ts/);
});

test('no-raw-db: lowering a real count without editing the list fails as stale', () => {
  const real = countRawDb(root);
  const [file, c] = [...real].find(([, v]) => v.reads > 0)!;
  real.set(file, { ...c, reads: c.reads - 1 });
  const problems = ratchet(real, ALLOW);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0]!, new RegExp(`${file.replaceAll('.', '\\.')}.*stale`));
});

test('no-raw-db: classifies writes and openers; queue.ts, db.ts, comments and strings are not counted', () => {
  const found = counts({
    'src/queue.ts': 'this.db.prepare("DELETE FROM tasks").run();\n',
    'src/db.ts': 'const db = new DatabaseSync(p);\n',
    'src/quiet.ts': '// store.db.prepare("DELETE FROM x")\nconst s = "store.db.exec(\'DROP TABLE x\')";\n',
    'src/w.ts': [
      'this.store.db.prepare("UPDATE tasks SET x = 1").run();',
      'store.db.prepare(sql).run();',
      'store.db.prepare(sql).all();',
      'store.db.exec(`INSERT INTO t VALUES (${n})`);',
    ].join('\n'),
    'src/o.ts': [
      'const ro = flag ? new DatabaseSync(a, { readOnly: true }) : new DatabaseSync(b, { readOnly: true });',
      'ro.prepare("PRAGMA integrity_check").get();',
      'const rw = new DatabaseSync(p);',
      'rw.exec("BEGIN IMMEDIATE");',
    ].join('\n'),
  });
  assert.deepEqual(Object.fromEntries(found), {
    'src/w.ts': { reads: 1, writes: 3, readOnlyOpeners: 0, writableOpeners: 0 },
    'src/o.ts': { reads: 2, writes: 0, readOnlyOpeners: 2, writableOpeners: 1 },
  });
});
