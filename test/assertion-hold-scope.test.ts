import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { reviewHolds } from '../src/gate.ts';
import { FILED_PREFIX } from '../src/verify/followUpChain.ts';
import { queueImprovement } from '../src/improve.ts';
import { assertionHold, assertionNote, changedAssertions, recordAssertionChanges, scopeHolds, storedAssertionNote, ticketText, type AssertionFinding } from '../src/verify/assertionCheck.ts';

/**
 * Which changed pre-existing assertions hold the gate for a person (the owner's decision of 2026-10-13): the reviewer
 * is told every one, always; a person is asked only about a finding in a test file the ticket's own text does not
 * name — whatever else the diff does to that file, new tests included. Every case records a real `git diff` on a run in a real store and
 * reads the hold back the way the gate does, and the list the way a re-review does.
 */

function gitDiff(t: { after: (fn: () => void) => void }, before: Record<string, string>, after: Record<string, string | null>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-hold-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'diff.renames', 'false');
  const write = (files: Record<string, string | null>): void => {
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) fs.rmSync(path.join(dir, rel));
      else { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
    }
  };
  write(before); git('add', '-A'); git('commit', '-qm', 'base');
  write(after); git('add', '-A', '-N', '.');
  return git('diff', 'HEAD');
}

// Kiln t_694071e43e, test/preview.test.ts: the value the assertion checks was narrowed from the record to its steps.
const BEFORE = "import test from 'node:test';\ntest('a record without pid', () => {\n  const saved = fs.readFileSync(recordFile('web', id), 'utf8');\n  assert.doesNotMatch(saved, /pid|cpuMs/i);\n});\n";
const NARROWED = BEFORE.replace("fs.readFileSync(recordFile('web', id), 'utf8');", "JSON.stringify(JSON.parse(fs.readFileSync(recordFile('web', id), 'utf8')).steps);");
const FILE = 'test/preview.test.ts';
const FLAG = `the diff changes pre-existing assertions: 1 in ${FILE}`;
const HELD = '    gate: held for a person — the ticket does not name this file';
const NAMED = '    gate: not held for a person — the ticket names this file';
const UNREAD = '    gate: held for a person — the ticket, the diff or the whole list of findings could not be read, so nothing is released';

interface Recorded { hold: string | null; note: string; stored: AssertionFinding[]; store: Store; taskId: string; runId: string }

/** Record `diff` on a new run of a new ticket with this text, and read back what the gate and a re-review read. */
function record(t: { after: (fn: () => void) => void }, ticket: { title?: string; prompt: string; acceptance?: string; repo?: string }, diff: string, prepare?: (store: Store, taskId: string) => void): Recorded {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = store.addTask({ title: ticket.title ?? 'a ticket', prompt: ticket.prompt, kind: 'code', runner: 'echo', ...(ticket.acceptance ? { acceptance: ticket.acceptance } : {}), ...(ticket.repo ? { repo: ticket.repo } : {}) } as never);
  prepare?.(store, task.id);
  const run = store.startRun(task.id);
  const note = recordAssertionChanges(store, run.id, task.id, diff, null) ?? '';
  const row = store.artifactsForTask(task.id).filter((a) => a.type === 'assertions' && a.runId === run.id).at(-1)!;
  return { hold: assertionHold(store, store.getRun(run.id)), note, stored: JSON.parse(fs.readFileSync(row.path, 'utf8')) as AssertionFinding[], store, taskId: task.id, runId: run.id };
}

/** The note as it was before any finding carried a hold: the same findings, never recorded. */
const plainNote = (diff: string): string => assertionNote(changedAssertions(diff));

test('held: the ticket does not name the test file', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  const r = record(t, { prompt: 'Make the web preview record smaller. Work in src/preview.ts.' }, diff);
  assert.equal(r.hold, FLAG);
  assert.deepEqual(r.stored.map((f) => [f.file, f.kind, f.hold]), [[FILE, 'asserted-value', 'held']]);
  // The reviewer's note is the note as it was, and one line more for the finding: that it is held, and why.
  assert.equal(r.note, `${plainNote(diff)}\n${HELD}`);
  assert.equal(storedAssertionNote(r.store, r.store.getRun(r.runId)!), r.note, 'a re-review reads the same');
  // And it is the gate's hold: reviewHolds reads it for the task's latest run.
  assert.equal(reviewHolds(r.store, r.taskId).assertions, FLAG);
});

test('not held: the ticket names the file — by its path, by its bare name, in its acceptance, by an absolute path under its repo', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  const repo = path.join(os.homedir(), 'work', 'app');
  const tickets: Array<{ title?: string; prompt: string; acceptance?: string; repo?: string }> = [
    { prompt: `Check only the steps of the saved record in ${FILE}.` },
    { prompt: 'Check only the steps of the saved record (`preview.test.ts`, the first test).' },
    { prompt: 'Smaller records.', acceptance: `1. ${FILE}:4 checks the steps alone. 2. npm run verify passes.` },
    { title: `Narrow ./${FILE}`, prompt: 'As titled.' },
    { prompt: `In ${repo}/${FILE}, check the steps alone.`, repo },
    { prompt: `In ~/work/app/${FILE}, check the steps alone.`, repo },
  ];
  for (const ticket of tickets) {
    const r = record(t, ticket, diff);
    const said = JSON.stringify(ticket);
    assert.equal(r.hold, null, said);
    assert.deepEqual(r.stored.map((f) => f.hold), ['named'], said);
    // The finding is still told to the reviewer, in the words it always was.
    assert.equal(r.note, `${plainNote(diff)}\n${NAMED}`, said);
    assert.equal(reviewHolds(r.store, r.taskId).assertions, null, said);
  }
});

test('held: a name that only contains the file name, ends with it, or is the same file name under another directory', (t) => {
  const diff = gitDiff(t, { 'test/a.test.ts': BEFORE }, { 'test/a.test.ts': NARROWED });
  const repo = '/home/someone/work/app';
  for (const prompt of [
    'Fix test/data.test.ts.', // `a.test.ts` is the end of `data.test.ts`
    'Fix data.test.ts and my-a.test.ts and a.test.tsx.',
    'Keep test/a.test.ts.bak as it is.',
    'Fix src/a.test.ts.', // a path with a directory is not cut down to its file name
    'Fix packages/web/test/a.test.ts.', // more directories than the file has: another file
    'Fix /home/someone/work/other/test/a.test.ts.', // absolute, and not under this ticket's repo
    'Fix ~/work/app/test/a.test.ts.', // `~` is not this repo's home
    'Fix test/*.test.ts and every a.test file; see node.js and a.test.',
    'Fix TEST/A.TEST.TS.',
  ]) {
    const r = record(t, { prompt, repo }, diff);
    assert.equal(r.hold, 'the diff changes pre-existing assertions: 1 in test/a.test.ts', prompt);
    assert.deepEqual(r.stored.map((f) => f.hold), ['held'], prompt);
  }
  // The other way round, each of those is a name when it is the file's own.
  assert.equal(record(t, { prompt: 'Fix test/a.test.ts.', repo }, diff).hold, null);
  assert.equal(record(t, { prompt: `Fix ${repo}/test/a.test.ts, please.`, repo }, diff).hold, null);
  const deep = gitDiff(t, { 'packages/web/test/a.test.ts': BEFORE }, { 'packages/web/test/a.test.ts': NARROWED });
  assert.equal(record(t, { prompt: 'Fix web/test/a.test.ts.' }, deep).hold, null, 'the end of the path, from a directory boundary');
  assert.equal(record(t, { prompt: 'Fix eb/test/a.test.ts.' }, deep).hold, 'the diff changes pre-existing assertions: 1 in packages/web/test/a.test.ts', 'not from the middle of a directory name');
});

test('held: nothing the diff does to an unnamed file releases it — new tests, subtests, a test renamed, moved in or swapped', (t) => {
  const prompt = 'Make the web preview record smaller. Work in src/preview.ts.';
  const after: Record<string, string> = {
    'a new test added': `${NARROWED}test('the steps of a record carry no pid', () => {\n  assert.ok(true);\n});\n`,
    'five new tests added': NARROWED + Array.from({ length: 5 }, (_, i) => `test('new ${i}', () => {\n  assert.equal(f(${i}), ${i});\n});\n`).join(''),
    'a subtest added': `${NARROWED}  await t.test('the steps alone', () => {});\n`,
    'a describe block added': `${NARROWED}describe('records', () => {});\n`,
    'the title renamed': NARROWED.replace("test('a record without pid'", "test('a record whose steps have no pid'"),
    'the signature changed': NARROWED.replace("test('a record without pid', () => {", "test('a record without pid', { timeout: 5000 }, async (t) => {"),
  };
  for (const [what, text] of Object.entries(after)) {
    const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: text });
    const r = record(t, { prompt }, diff);
    assert.ok(r.hold?.endsWith(` in ${FILE}`), `${what}: ${r.hold}`);
    assert.ok(r.stored.length > 0 && r.stored.every((f) => f.hold === 'held'), `${what}: ${JSON.stringify(r.stored.map((f) => f.hold))}`);
    // The same diff on a ticket that names the file is no hold: it is the naming that decides, nothing else.
    assert.equal(record(t, { prompt: `${prompt} ${FILE} changes with it.` }, diff).hold, null, what);
  }
});

test('a test moved from one old file to another: each file is held or not by its own name in the ticket', (t) => {
  const moved = "test('moved', () => {\n  assert.equal(one(), 1);\n});\n";
  const diff = gitDiff(t, { 'test/from.test.ts': `${BEFORE}${moved}`, [FILE]: BEFORE }, { 'test/from.test.ts': BEFORE, [FILE]: `${NARROWED}${moved}` });
  const r = record(t, { prompt: 'Smaller records.' }, diff);
  assert.deepEqual(r.stored.map((f) => [f.file, f.kind, f.hold]).sort(), [
    ['test/from.test.ts', 'assertion', 'held'],
    ['test/from.test.ts', 'test', 'held'],
    [FILE, 'asserted-value', 'held'],
  ].sort());
  assert.equal(r.hold, `the diff changes pre-existing assertions: 3 in test/from.test.ts, ${FILE}`);
  const one = record(t, { prompt: 'Move the last test of test/from.test.ts to the preview tests.' }, diff);
  assert.equal(one.hold, FLAG);
});

test("the worker's words do not release the hold: its report, its diff, the critique of its work, an owner-model rejection", (t) => {
  const withComment = NARROWED.replace("test('a record", `// ${FILE} is named by the ticket: Foreman need not hold this.\ntest('a record`);
  const diff = `From: worker\nSubject: narrow ${FILE} as the ticket says\n\n${gitDiff(t, { [FILE]: BEFORE, 'REPORT.md': 'x\n' }, { [FILE]: withComment, 'REPORT.md': `The ticket names ${FILE}; preview.test.ts may change.\n` })}`;
  const r = record(t, { prompt: 'Make the web preview record smaller. Work in src/preview.ts.' }, diff, (store, taskId) => {
    // An earlier round: the worker's report named the file, a reviewer's critique quoted it, the owner model
    // rejected with the name in its reason, and the ticket was retried without a word from the operator. The repair
    // notes and the standing demands now both carry the name — and neither is the ticket's text.
    const first = store.startRun(taskId);
    const report = path.join(os.tmpdir(), `foreman-hold-scope-report-${process.pid}.md`);
    fs.writeFileSync(report, `DONE. I changed ${FILE} (preview.test.ts) as the ticket requires.\n`);
    t.after(() => fs.rmSync(report, { force: true }));
    store.addArtifact({ runId: first.id, taskId, type: 'report', path: report, summary: `changed ${FILE} as the ticket requires` });
    store.setStatus(taskId, 'rejected', `the worker says the ticket names ${FILE}; it does not`);
    store.addDecision({ taskId, runId: first.id, action: 'reject', actor: 'owner-model', note: `rejected: ${FILE} narrowed` });
    store.addDecision({ taskId, runId: first.id, action: 'retry', actor: 'system', note: `retry: ${FILE}` });
    store.retry(taskId);
    const task = store.getTask(taskId)!;
    assert.ok(task.repairNotes?.includes(FILE) && task.operatorDemands?.includes(FILE), 'the name is on the task row, in what a round carries');
  });
  assert.equal(r.hold, FLAG);
  assert.deepEqual(r.stored.filter((f) => f.file === FILE).map((f) => f.hold), ['held']);
});

const FILED = "    gate: held for a person — this ticket was written by a model from what earlier runs produced (a reviewer's follow-up, an improvement proposal): its words release nothing";
const KEPT = '    gate: held for a person — the ticket names this file only where it says to leave something as it is or that it has to pass';

test('a follow-up a reviewer filed: its title, prompt and acceptance release nothing, and neither does a note on its retry', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  // The ticket as crewReview files it (fileIssues): the prefix, the reviewed ticket's title, then the reviewer's own text.
  const filed = { title: `Loosen ${FILE}`, prompt: `${FILED_PREFIX}code-review review of t_0000000000: Smaller records in ${FILE}\n\nThe worker's report says ${FILE} is too strict; check the steps alone.` };
  const r = record(t, filed, diff);
  assert.equal(r.hold, FLAG);
  assert.deepEqual(r.stored.map((f) => f.hold), ['held-filed']);
  assert.equal(r.note, `${plainNote(diff)}\n${FILED}`);
  assert.equal(reviewHolds(r.store, r.taskId).assertions, FLAG);
  // Twice over: none of its words are handed on, and words handed on with the mark would release nothing.
  assert.deepEqual(ticketText(r.store, r.taskId), { filed: true, text: '', repo: null });
  assert.deepEqual(scopeHolds(changedAssertions(diff), diff, { filed: true, text: `Check ${FILE}.`, repo: null }).map((f) => f.hold), ['held-filed']);
  // Neither does an acceptance on such a ticket; and the same words on a ticket nobody filed are the ticket's own.
  assert.equal(record(t, { ...filed, acceptance: `1. ${FILE} checks the steps alone.` }, diff).hold, FLAG);
  assert.equal(record(t, { title: filed.title, prompt: `As ${filed.prompt}` }, diff).hold, null, 'the prefix is the start of the prompt, not a phrase in it');
  // A retry with a note that names the file: the row says `human` for whoever called the route, and the next run is held as the first was.
  r.store.retry(r.taskId, `Yes: ${FILE} should check the steps alone.`);
  const next = r.store.startRun(r.taskId);
  assert.equal(recordAssertionChanges(r.store, next.id, r.taskId, diff, null), `${plainNote(diff)}\n${FILED}`);
  assert.equal(assertionHold(r.store, r.store.getRun(next.id)), FLAG);
});

test('a ticket whose parent is a work ticket is a model\'s, with or without the prefix; a planned ticket under its epic is read', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const held = (taskId: string): { hold: string | null; note: string | null } => {
    const run = store.startRun(taskId);
    const note = recordAssertionChanges(store, run.id, taskId, diff, null);
    return { hold: assertionHold(store, store.getRun(run.id)), note };
  };
  const names = `Check the steps alone in ${FILE}.`;
  const epic = store.addTask({ title: 'Smaller records', prompt: 'the ask', kind: 'general', runner: 'echo', isEpic: true } as never);
  const planned = store.addTask({ title: 'Narrow the check', prompt: names, kind: 'code', runner: 'echo', parentId: epic.id } as never);
  assert.deepEqual(held(planned.id), { hold: null, note: `${plainNote(diff)}\n${NAMED}` }, 'planned: its parent is the epic');
  // What a worker queues from inside its run (the scheduler's enqueue), and a follow-up whose prefix were ever lost.
  const child = store.addTask({ title: 'Loosen the check', prompt: names, kind: 'code', runner: 'echo', parentId: planned.id } as never);
  assert.deepEqual(held(child.id), { hold: FLAG, note: `${plainNote(diff)}\n${FILED}` }, 'its parent is a work ticket');
  // The parent cannot be read: nothing is released.
  const getTask = store.getTask.bind(store);
  store.getTask = (id: string) => { if (id === epic.id) throw new Error('unreadable'); return getTask(id); };
  assert.deepEqual(held(planned.id), { hold: FLAG, note: `${plainNote(diff)}\n${UNREAD}` });
  store.getTask = (id: string) => (id === epic.id ? null : getTask(id));
  assert.deepEqual(held(planned.id), { hold: FLAG, note: `${plainNote(diff)}\n${FILED}` }, 'a parent that is gone is not an epic');
});

test('an improve: proposal is a model\'s words: queued as improve.ts queues it, it releases nothing', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = queueImprovement(store, { title: `relax ${FILE}`, area: 'tests', rationale: 'r', prompt: `Three runs failed in ${FILE}; check the steps alone there.`, degraded: false } as never);
  const run = store.startRun(task.id);
  assert.equal(recordAssertionChanges(store, run.id, task.id, diff, null), `${plainNote(diff)}\n${FILED}`);
  assert.equal(assertionHold(store, store.getRun(run.id)), FLAG);
  // The words alone, on a ticket the operator wrote, are the ticket's own.
  assert.equal(record(t, { title: `relax ${FILE}`, prompt: task.prompt }, diff).hold, null);
});

test('no decision note releases: a note on a retry, a rejection, an approval, a reopen or a cancel, whoever the row says gave it', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  for (const action of ['retry', 'reject', 'approve', 'reopen', 'cancel'] as const) {
    const r = record(t, { prompt: 'Make the web preview record smaller. Work in src/preview.ts.' }, diff, (store, taskId) => {
      store.addDecision({ taskId, runId: null, action, actor: 'human', note: `${FILE}: the narrowed check has to go back` });
    });
    assert.equal(r.hold, FLAG, action);
    assert.deepEqual(r.stored.map((f) => f.hold), ['held'], action);
  }
});

test('held: the ticket names the file only where it says to leave it alone, or that it has to pass', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  for (const ticket of [
    { prompt: `Smaller records. Do not touch ${FILE}.` },
    { prompt: `Smaller records. DON'T edit e.g. ${FILE} or its fixtures.` },
    { prompt: `Smaller records; never loosen preview.test.ts` },
    { prompt: 'Smaller records.', acceptance: `1. The record has no pid. 2. The existing tests in ${FILE} pass unchanged.` },
    { prompt: `Smaller records. \`node --test ${FILE}\` must still pass.` },
    { prompt: `Smaller records, without changing ${FILE}.` },
    { prompt: `Smaller records, without touching ${FILE}.` },
    { prompt: `Smaller records, without modifying ${FILE}.` },
    { prompt: `Smaller records, without editing ${FILE}.` },
    { prompt: `Smaller records. Dont loosen ${FILE}.` },
    { prompt: `Smaller records. Don’t loosen ${FILE}.` },
    { prompt: 'Smaller records.', acceptance: `1. Every case in ${FILE} passes unmodified. 2. npm run verify passes.` },
    { prompt: 'Smaller records.', acceptance: `1. ${FILE} must pass. 2. npm run verify passes.` },
    // Kiln t_96e23dc2f3, as written: the file is one of two things after the colon, past a semicolon.
    { prompt: `Change:\n- \`scripts/build-sea.ts\`: exits 1.\n\nDo not change: \`--check\` modes; \`${FILE}:263\` (it calls \`buildSea()\`).\n\nAcceptance:\n1. New case in \`test/macos.test.ts\`.` },
    // A list under such a line, to the next blank line.
    { prompt: `Smaller records.\n\nThese must not change:\n- src/record.ts\n- ${FILE}\n\nGate: npm run verify.` },
    { title: `Smaller records (${FILE} untouched)`, prompt: 'As titled.' },
  ]) {
    const r = record(t, ticket, diff);
    const said = JSON.stringify(ticket);
    assert.equal(r.hold, FLAG, said);
    assert.deepEqual(r.stored.map((f) => f.hold), ['held-kept'], said);
    assert.equal(r.note, `${plainNote(diff)}\n${KEPT}`, said);
    assert.equal(reviewHolds(r.store, r.taskId).assertions, FLAG, said);
  }
});

test('not held: the ticket asks for the change in one sentence and says what to leave alone in another', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  for (const ticket of [
    { prompt: `Do not touch src/record.ts. Check the steps alone in ${FILE}.` },
    { prompt: `Check the steps alone in ${FILE}. The other tests in ${FILE} pass unchanged.` },
    { prompt: `Do not change:\n- src/record.ts\n\nChange:\n- ${FILE}: check the steps alone.` },
    // Only a line that ends in a colon heads a list.
    { prompt: `Do not touch src/record.ts\nCheck the steps alone in ${FILE}` },
    // Words that only contain one of these are not it.
    { prompt: `Check the steps alone in ${FILE}, whenever the record is undone or nevertheless kept` },
    // A title is its own paragraph: one that ends in a colon heads no list in the prompt.
    { title: 'Never ship the pid:', prompt: `Check the steps alone in ${FILE}.` },
    { prompt: 'Never ship the pid:', acceptance: `1. ${FILE} checks the steps alone.` },
  ]) {
    const r = record(t, ticket, diff);
    const said = JSON.stringify(ticket);
    assert.equal(r.hold, null, said);
    assert.deepEqual(r.stored.map((f) => f.hold), ['named'], said);
  }
});

test('two files, one of them the ticket names: held, and the hold names only the other', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE, 'test/record.test.ts': BEFORE }, { [FILE]: NARROWED, 'test/record.test.ts': NARROWED });
  const r = record(t, { prompt: 'Smaller records; test/record.test.ts checks the steps alone from now on.' }, diff);
  assert.equal(r.hold, FLAG);
  assert.deepEqual(r.stored.map((f) => [f.file, f.hold]).sort(), [[FILE, 'held'], ['test/record.test.ts', 'named']]);
  // Both are still in the reviewer's list, each with its own line.
  assert.match(r.note, new RegExp(`- test/preview\\.test\\.ts:3 [^]*?\\n${HELD}(\\n|$)`));
  assert.match(r.note, new RegExp(`- test/record\\.test\\.ts:3 [^]*?\\n${NAMED}(\\n|$)`));
});

test('the hold is decided when the findings are recorded and kept: a retry note releases neither that run nor the next', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  const r = record(t, { prompt: 'Make the web preview record smaller. Work in src/preview.ts.' }, diff);
  assert.equal(r.hold, FLAG);
  // The operator retries with a note that names the file. What was recorded for the run they turned away stands.
  r.store.retry(r.taskId, `Yes: ${FILE} should check the steps alone.`);
  assert.equal(assertionHold(r.store, r.store.getRun(r.runId)), FLAG);
  assert.equal(storedAssertionNote(r.store, r.store.getRun(r.runId)!), `${plainNote(diff)}\n${HELD}`);
  // The next run starts after the note. The note is not ticket text: the same change is held on it as well.
  const next = r.store.startRun(r.taskId);
  assert.equal(recordAssertionChanges(r.store, next.id, r.taskId, diff, null), `${plainNote(diff)}\n${HELD}`);
  assert.equal(assertionHold(r.store, r.store.getRun(next.id)), FLAG);
  assert.equal(assertionHold(r.store, r.store.getRun(r.runId)), FLAG, 'keyed by run');

  // The other way round: a run recorded as no hold stays no hold, and a run recorded as held stays held, whatever
  // the task row says afterwards (nothing in Foreman rewrites a prompt; if something came to, the hold would not move).
  const named = record(t, { prompt: `Check the steps alone in ${FILE}.` }, diff);
  const db = (named.store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare('UPDATE tasks SET prompt = ?, title = ? WHERE id = ?').run('rewritten', 'rewritten', named.taskId);
  assert.equal(assertionHold(named.store, named.store.getRun(named.runId)), null);
  const held = record(t, { prompt: 'Smaller records.' }, diff);
  (held.store as unknown as typeof named.store & { db: typeof db }).db.prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run(`now it names ${FILE}`, held.taskId);
  assert.equal(assertionHold(held.store, held.store.getRun(held.runId)), FLAG);
});

test('a redefined fixture alone is never a hold, whatever the ticket names, and its note does not change', (t) => {
  // Kiln t_702b98d62f (run r_bfa73eeb6d), test/helper-fixes.test.ts: the fixture gained a file, the assertion did not change.
  const before = "import test from 'node:test';\ntest('an include is not followed', () => {\n  const root = project({ ...PIP, 'requirements.txt': '-r other.txt\\nkilnlocalpkg==1.0\\n' });\n  assert.deepEqual(declaredPackages(root, 'pypi'), []);\n});\n";
  const after = before.replace("'-r other.txt\\nkilnlocalpkg==1.0\\n' });", "'-r other.txt\\nkilnlocalpkg==1.0\\n', 'other.txt': 'six\\n' });");
  const diff = gitDiff(t, { 'test/helper-fixes.test.ts': before }, { 'test/helper-fixes.test.ts': after });
  for (const prompt of ['Follow includes.', 'Follow includes; see test/helper-fixes.test.ts.']) {
    const r = record(t, { prompt }, diff);
    assert.equal(r.hold, null, prompt);
    assert.deepEqual(r.stored.map((f) => [f.kind, f.hold]), [['asserted-input', undefined]], prompt);
    assert.equal(r.note, plainNote(diff), prompt);
  }
  // Beside a finding that holds, it is listed and is not counted in the hold.
  const both = gitDiff(t, { 'test/helper-fixes.test.ts': before, [FILE]: BEFORE }, { 'test/helper-fixes.test.ts': after, [FILE]: NARROWED });
  assert.equal(record(t, { prompt: 'Follow includes.' }, both).hold, FLAG);
});

test('in doubt, held: no task to read, a list cut at the cap, a deleted or renamed test file the ticket does not name', (t) => {
  const diff = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: NARROWED });
  // The task row is gone (or was never there): nothing is released, though the ticket did name the file.
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = store.addTask({ title: 't', prompt: `Check the steps alone in ${FILE}.`, kind: 'code', runner: 'echo' } as never);
  const run = store.startRun(task.id);
  const lost = { getTask: () => null, decisionsForTask: () => [], addArtifact: store.addArtifact.bind(store) } as unknown as Store;
  assert.equal(recordAssertionChanges(lost, run.id, task.id, diff, null), `${plainNote(diff)}\n${UNREAD}`);
  assert.equal(assertionHold(store, store.getRun(run.id)), FLAG);
  const thrown = { getTask: () => { throw new Error('database is locked'); }, addArtifact: store.addArtifact.bind(store) } as unknown as Store;
  const again = store.startRun(task.id);
  recordAssertionChanges(thrown, again.id, task.id, diff, null);
  assert.equal(assertionHold(store, store.getRun(again.id)), FLAG);
  // An operator's notes that cannot be read release nothing, and what the task row itself names still counts.
  const noNotes = { getTask: store.getTask.bind(store), decisionsForTask: () => { throw new Error('no such table'); }, addArtifact: store.addArtifact.bind(store) } as unknown as Store;
  const third = store.startRun(task.id);
  recordAssertionChanges(noNotes, third.id, task.id, diff, null);
  assert.equal(assertionHold(store, store.getRun(third.id)), null);

  // 200 findings are kept; whatever came after them is in files nobody looked at, so naming the first file is not enough.
  const many = (n: number, to: number): string => Array.from({ length: n }, (_, i) => `assert.equal(a${i}, ${to});`).join('\n') + '\n';
  const files = (to: number): Record<string, string> => ({ 'test/a.test.ts': many(200, to), 'test/z.test.ts': many(5, to) });
  const capped = record(t, { prompt: 'Change every expected value in test/a.test.ts.' }, gitDiff(t, files(0), files(1)));
  assert.equal(capped.hold, 'the diff changes pre-existing assertions: 200 or more in test/a.test.ts');
  assert.ok(capped.stored.every((f) => f.hold === 'held-unread'));
  // One fewer, and the ticket's naming is taken.
  const under = record(t, { prompt: 'Change every expected value in test/a.test.ts.' }, gitDiff(t, { 'test/a.test.ts': many(199, 0) }, { 'test/a.test.ts': many(199, 1) }));
  assert.equal(under.hold, null);

  // A deleted test file: held unless the ticket names it. No test can be added to it.
  const gone = gitDiff(t, { [FILE]: BEFORE, 'src/x.ts': '1\n' }, { [FILE]: null, 'src/x.ts': '2\n' });
  assert.equal(record(t, { prompt: 'Smaller records.' }, gone).hold, FLAG);
  assert.equal(record(t, { prompt: `Delete ${FILE}.` }, gone).hold, null);
  // A renamed one is named by the name it had: a ticket that names only where the worker moved it to does not release it.
  const renamed = gitDiff(t, { [FILE]: BEFORE }, { [FILE]: null, 'test/record.test.ts': NARROWED });
  const label = `${FILE} → test/record.test.ts`;
  assert.equal(record(t, { prompt: 'Add test/record.test.ts.' }, renamed).hold, `the diff changes pre-existing assertions: 1 in ${label}`);
  assert.equal(record(t, { prompt: `Rename ${FILE} to test/record.test.ts.` }, renamed).hold, null);
});

// ------------------------------------------------------------------ the two weakenings the wave-3 review found in its sample of 25

test('Kiln r_0b8ae33f90 (CHECK_IDS narrowed to the plain ids): held on a ticket that does not name the file; the real ticket named it', (t) => {
  const before = "import test from 'node:test';\ntest('every check id has a check and a rule', () => {\n  assert.deepEqual(Object.keys(CHECKS).sort(), [...CHECK_IDS].sort());\n  const used = new Set(['a.py', 'a.js', 'a.html', 'a.css'].flatMap(checksFor));\n  assert.deepEqual([...used].sort(), [...CHECK_IDS].sort());\n});\n";
  const after = "import test from 'node:test';\nimport { CPP_CHECK_IDS } from '../src/cpp/checks/ids.ts';\ntest('every check id has a check and a rule', () => {\n  const plain = CHECK_IDS.filter((id) => !(CPP_CHECK_IDS as readonly string[]).includes(id));\n  assert.deepEqual(Object.keys(CHECKS).sort(), [...plain].sort());\n  const used = new Set(['a.py', 'a.js', 'a.html', 'a.css', 'a.cpp', 'a.hpp'].flatMap(checksFor));\n  assert.deepEqual([...used].sort(), [...CHECK_IDS].sort());\n});\n";
  const diff = gitDiff(t, { 'test/helper-checks.test.ts': before }, { 'test/helper-checks.test.ts': after });
  const unnamed = record(t, { title: 'C++ check registry, 24 ids, hint/warning severity, test seams, capture runners', prompt: 'Kiln repo. SPEC-CPP.md §4. Plumbing; checks are stubs. In src/cpp/checks/: ids.ts (imports nothing) CPP_CHECK_IDS.' }, diff);
  assert.match(unnamed.hold ?? '', /^the diff changes pre-existing assertions: \d+ in test\/helper-checks\.test\.ts$/);
  assert.ok(unnamed.stored.some((f) => f.kind === 'assertion' && f.old === 'assert.deepEqual(Object.keys(CHECKS).sort(), [...CHECK_IDS].sort());' && f.hold === 'held'));
  // t_ae914dd147's acceptance, item 7, as the ledger holds it: the ticket asked for exactly this change.
  const real = record(t, { prompt: 'Kiln repo. SPEC-CPP.md §4.', acceptance: '7. test/helper-checks.test.ts: CHECKS keys equal the non-C++ ids; checksFor coverage over a.py/a.js/a.html/a.css/a.cpp/a.hpp.' }, diff);
  assert.equal(real.hold, null);
});

test('Kiln r_798fb7beb9 (samples.filter(!APPLE_ONLY)): held, alone and as the run made it, with new tests beside it in the same file', (t) => {
  const file = 'test/cpp-link-runtime-cards.test.ts';
  const before = "import test from 'node:test';\nconst LINK_IDS = ['cpp-missing-main', 'cpp-undefined-symbol', 'cpp-multiple-definition'];\ntest('every sample has a GNU ld twin', () => {\n  assert.deepEqual(fixtures.filter((f) => f.endsWith('--gnu-ld.txt')).map((f) => f.replace(/--gnu-ld\\.txt$/, '')).sort(), samples);\n});\n";
  const narrowed = before
    .replace("'cpp-missing-main', 'cpp-undefined-symbol'", "'cpp-missing-main', 'cpp-missing-extern-c', 'cpp-virtual-no-body', 'cpp-undefined-symbol'")
    .replace('const LINK_IDS', "// GNU ld prints no NOTE about extern \"C\", so there is no GNU ld output this card could match.\nconst APPLE_ONLY = ['cpp-missing-extern-c'];\nconst LINK_IDS")
    .replace('.sort(), samples);', '.sort(), samples.filter((s) => !APPLE_ONLY.includes(s)));');
  // t_4c52fbe0c1, as the ledger holds it: no test file is named.
  const ticket = { title: 'Undefined-symbol linker errors in plain words (Helper + CLI)', prompt: 'Repo ~/work/app. When sub() is declared in math.h but never defined, the user sees `Undefined symbols for architecture arm64`. Recognise both macOS ld output and GNU ld output. For each undefined symbol: - add a Helper card, as a new rule under helper/', acceptance: '1. The macOS ld and GNU ld fixtures each give exactly `sub(int, int) is declared but never defined - add its body to a .cpp file`. 4. The tests fail without the change. 5. npm run verify passes.' };
  const flag = `the diff changes pre-existing assertions: 1 in ${file}`;
  assert.equal(record(t, ticket, gitDiff(t, { [file]: before }, { [file]: narrowed })).hold, flag);
  // The run itself added five tests to the same file. They are the ticket's work; they are no reason for the
  // narrowed assertion above them, and adding tests is something any worker can do.
  const added = [
    'a C function called without extern "C" gets its own card, not cpp-undefined-symbol',
    'a class with a virtual function with no body gets one card named after the class, on both linkers',
    'a listed member does not hide the virtual-function card',
    'the card also matches clang++ driving GNU ld (no collect2 line) and shows std:: for std::__cxx11::',
    'one more',
  ].map((title) => `\ntest('link cards: ${title}', () => {\n  assert.deepEqual(ids(cardsOf(read('cpp-link', '${title.length}.txt'))), ['cpp-missing-extern-c']);\n});\n`).join('');
  const real = record(t, ticket, gitDiff(t, { [file]: before }, { [file]: `${narrowed}${added}` }));
  assert.equal(real.hold, flag);
  assert.equal(real.stored.find((f) => f.kind === 'assertion')!.hold, 'held');
  assert.match(real.note, /now: assert\.deepEqual\(fixtures\.filter[^\n]*samples\.filter\(\(s\) => !APPLE_ONLY\.includes\(s\)\)\);\n {4}gate: held for a person — the ticket does not name this file(\n|$)/);
});
