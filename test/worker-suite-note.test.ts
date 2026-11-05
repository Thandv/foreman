import { privateTmpdir, scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { existingOutputDir, readWorkerSuite, recordWorkerSuite, storedWorkerSuiteNote } from '../src/verify/workerSuite.ts';

function setup(t: test.TestContext) {
  const root = fs.realpathSync(scratchDir('foreman-wsuite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'out');
  const jail = path.join(root, 'jail');
  fs.mkdirSync(out);
  fs.mkdirSync(jail);
  fs.writeFileSync(path.join(jail, 'a.txt'), 'a');
  const age = (file: string, ageSec: number): void => {
    const when = new Date(Date.now() - ageSec * 1000);
    fs.utimesSync(file, when, when);
  };
  const save = (name: string, last: string, ageSec: number): string => {
    const f = path.join(out, name);
    fs.writeFileSync(f, `some output\n${last}\n`);
    age(f, ageSec);
    return f;
  };
  return { root, out, jail, save, age };
}

test('a run with saved output gets the PASSED line and a worker-suite event and artifact', (t) => {
  const s = setup(t);
  s.save('r_1-1000-1.log', 'testSlot: npm run verify PASSED', 60);
  s.age(path.join(s.jail, 'a.txt'), 120);
  const r = readWorkerSuite(s.out, 'r_1', s.jail);
  assert.equal(r.status, 'PASSED');
  assert.match(r.line, /^worker suite: PASSED at \S+ \(advisory, written by worker-side code\)$/);
  const store = new Store(':memory:');
  const task = store.addTask({ title: 't', prompt: 'p', kind: 'code' } as never);
  const run = store.startRun(task.id);
  recordWorkerSuite(store, path.join(s.root, 'art'), run.id, task.id, r);
  store.record({ taskId: task.id, runId: run.id, type: 'worker-suite', message: r.status });
  assert.equal(store.eventsForTask(task.id).filter((e) => e.type === 'worker-suite').length, 1);
  assert.equal(store.artifactsForTask(task.id).find((a) => a.type === 'worker-suite')?.summary, r.line);
  assert.equal(storedWorkerSuiteNote(store, run), r.line);
});

test('a failed saved run says FAILED', (t) => {
  const s = setup(t);
  s.save('r_1-1000-1.log', 'testSlot: npm test FAILED', 60);
  assert.match(readWorkerSuite(s.out, 'r_1', s.jail).line, /^worker suite: FAILED at /);
});

test('a run with no saved output says the worker never ran the suite', (t) => {
  const s = setup(t);
  assert.equal(readWorkerSuite(s.out, 'r_1', s.jail).line, 'the worker never ran the suite');
  assert.equal(readWorkerSuite(path.join(s.root, 'missing'), 'r_1', s.jail).line, 'the worker never ran the suite');
});

test('output saved under r_1-2 is not counted for r_1', (t) => {
  const s = setup(t);
  s.save('r_1-2-1000-1.log', 'testSlot: npm test PASSED', 60);
  assert.equal(readWorkerSuite(s.out, 'r_1', s.jail).line, 'the worker never ran the suite');
  s.save('r_1_2-3000-1.log', 'testSlot: npm test PASSED', 60); // the file name runKey('r_1-2') gives
  assert.equal(readWorkerSuite(s.out, 'r_1', s.jail).line, 'the worker never ran the suite');
  assert.match(readWorkerSuite(s.out, 'r_1-2', s.jail).line, /PASSED/);
});

test('jail edits after the last suite run add "changed after the worker\'s suite"', (t) => {
  const s = setup(t);
  s.save('r_1-1000-1.log', 'testSlot: npm test PASSED', 60);
  s.age(path.join(s.jail, 'a.txt'), 120);
  assert.doesNotMatch(readWorkerSuite(s.out, 'r_1', s.jail).line, /changed after/);
  s.age(path.join(s.jail, 'a.txt'), 5);
  const r = readWorkerSuite(s.out, 'r_1', s.jail);
  assert.ok(r.changedAfter);
  assert.match(r.line, /; changed after the worker's suite$/);
});

test('looking for the saved-output folder does not create it', () => {
  const dir = privateTmpdir();
  existingOutputDir();
  assert.equal(fs.existsSync(path.join(dir, 'foreman-suite-output')), false);
});

test('an unreadable output folder gives a visible line and does not throw', (t) => {
  const s = setup(t);
  const notADir = path.join(s.root, 'file');
  fs.writeFileSync(notADir, 'x'); // readdir on a file: ENOTDIR
  const r = readWorkerSuite(notADir, 'r_1', s.jail);
  assert.equal(r.status, 'unreadable');
  assert.match(r.line, /^worker suite: could not read its saved output \(/);
});
