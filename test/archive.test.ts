import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { archiveTerms, estimateFrom, humanDuration, scoreRecord, type ArchiveRecord } from '../src/archive.ts';

const store = (): Store => new Store(':memory:');
const DAY = 86_400_000;

/** Close a task and backdate its terminal stamp, so a sweep can see it. */
function close(s: Store, taskId: string, status: 'done' | 'failed' | 'rejected' | 'canceled', agoDays: number): void {
  s.setStatus(taskId, status);
  s.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - agoDays * DAY, taskId);
}

test('a sweep folds closed tasks past the window and leaves fresh ones alone', () => {
  const s = store();
  const old = s.addTask({ title: 'old work', prompt: 'x' });
  const fresh = s.addTask({ title: 'fresh work', prompt: 'x' });
  close(s, old.id, 'done', 30);
  close(s, fresh.id, 'done', 1);

  assert.equal(s.archiveClosed(7), 1);
  assert.equal(s.getTask(old.id)!.archivedAt !== null, true);
  assert.equal(s.getTask(fresh.id)!.archivedAt, null);
  assert.equal(s.archiveCount(), 1);
  s.close();
});

test('an open task is never archived, however old it is', () => {
  const s = store();
  const t = s.addTask({ title: 'still going', prompt: 'x' });
  s.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 400 * DAY, t.id);
  assert.equal(s.archiveClosed(7), 0);
  s.close();
});

test('a second sweep is a no-op: archiving is idempotent', () => {
  const s = store();
  const t = s.addTask({ title: 'work', prompt: 'x' });
  close(s, t.id, 'done', 30);
  assert.equal(s.archiveClosed(7), 1);
  assert.equal(s.archiveClosed(7), 0);
  assert.equal(s.archiveCount(), 1);
  s.close();
});

test('archiving keeps the task; it is not a delete', () => {
  const s = store();
  const t = s.addTask({ title: 'work', prompt: 'the full prompt survives' });
  close(s, t.id, 'done', 30);
  s.archiveClosed(7);
  const still = s.getTask(t.id);
  assert.equal(still!.prompt, 'the full prompt survives');
  assert.equal(still!.status, 'done');
  s.close();
});

test('the record carries measured actuals, denormalised so a later prune cannot erase them', () => {
  const s = store();
  const t = s.addTask({ title: 'chapter 21', prompt: 'x', playbook: 'publishing', role: 'author', points: 5 });
  const run = s.startRun(t.id);
  s.addUsage(run.id, t.id, { tokensIn: 900, tokensOut: 4100, costUsd: 0.42 });
  s.endRun(run.id, 'succeeded', { summary: 'drafted' });
  // A run whose start and end are far apart is what makes durationMs real.
  s.db.prepare('UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?')
    .run(1_000_000, 1_000_000 + 90 * 60_000, run.id);
  close(s, t.id, 'done', 30);
  s.archiveClosed(7);

  const [rec] = s.listArchive();
  assert.equal(rec!.title, 'chapter 21');
  assert.equal(rec!.role, 'author');
  assert.equal(rec!.playbook, 'publishing');
  assert.equal(rec!.points, 5);
  assert.equal(rec!.durationMs, 90 * 60_000);
  assert.equal(rec!.costUsd, 0.42);
  assert.equal(rec!.tokensOut, 4100);
  assert.equal(rec!.assignee, 'ai');

  // The whole point of denormalising: blow the ledgers away and the
  // measurement is still there.
  s.db.exec('DELETE FROM runs');
  assert.equal(s.listArchive()[0]!.durationMs, 90 * 60_000);
  s.close();
});

test('a task that never ran archives with a zero duration rather than a wrong one', () => {
  const s = store();
  const t = s.addTask({ title: 'never started', prompt: 'x' });
  close(s, t.id, 'canceled', 30);
  s.archiveClosed(7);
  assert.equal(s.listArchive()[0]!.durationMs, 0);
  s.close();
});

test('unarchive puts the card back without forgetting the measurement', () => {
  const s = store();
  const t = s.addTask({ title: 'work', prompt: 'x' });
  close(s, t.id, 'done', 30);
  s.archiveClosed(7);

  assert.equal(s.unarchive(t.id), true);
  assert.equal(s.getTask(t.id)!.archivedAt, null);
  assert.equal(s.archiveCount(), 1, 'the record is the history; un-hiding a card does not erase it');
  assert.equal(s.unarchive(t.id), false, 'unarchiving twice reports honestly');
  s.close();
});

test('days=0 archives on close; a negative window is the caller saying "not yet"', () => {
  const s = store();
  const t = s.addTask({ title: 'work', prompt: 'x' });
  s.setStatus(t.id, 'done');
  assert.equal(s.archiveClosed(0), 1);
  s.close();
});

test('every terminal status is archivable, and only terminal statuses are', () => {
  const s = store();
  const ids: string[] = [];
  for (const status of ['done', 'failed', 'rejected', 'canceled'] as const) {
    const t = s.addTask({ title: status, prompt: 'x' });
    close(s, t.id, status, 30);
    ids.push(t.id);
  }
  const waiting = s.addTask({ title: 'waiting', prompt: 'x' });
  s.setStatus(waiting.id, 'awaiting-approval');
  s.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 400 * DAY, waiting.id);

  assert.equal(s.archiveClosed(7), ids.length);
  assert.equal(s.getTask(waiting.id)!.archivedAt, null);
  s.close();
});

// ------------------------------------------------------------------ estimation

const rec = (over: Partial<ArchiveRecord> = {}): ArchiveRecord => ({
  taskId: 't1', archivedAt: 0, closedAt: 0, createdAt: 0,
  title: 'draft chapter', kind: 'writing', status: 'done',
  repo: null, playbook: 'publishing', role: 'author', runner: 'api', assignee: 'ai',
  epicId: null, points: 5, repairs: 0, attempts: 1,
  durationMs: 60 * 60_000, costUsd: 0.4, tokensIn: 0, tokensOut: 0,
  verdict: 'pass', error: null, acceptance: null, summary: null,
  terms: archiveTerms('draft chapter', null, 'author', 'publishing'),
  ...over,
});

test('an exact role match outscores mere word overlap', () => {
  const query = { text: 'draft chapter', role: 'author', playbook: 'publishing' };
  const sameRole = scoreRecord(rec(), query);
  const otherRole = scoreRecord(rec({ role: 'copyeditor', terms: archiveTerms('draft chapter', null, 'copyeditor', 'publishing') }), query);
  assert.ok(sameRole > otherRole, 'the same job done before is the best predictor there is');
});

test('the estimate is a median, so one outlier cannot move it', () => {
  const records = [
    rec({ taskId: 'a', durationMs: 60 * 60_000 }),
    rec({ taskId: 'b', durationMs: 70 * 60_000 }),
    rec({ taskId: 'c', durationMs: 65 * 60_000 }),
    rec({ taskId: 'd', durationMs: 40 * 3_600_000 }), // the one that ran overnight
  ];
  const est = estimateFrom(records, { text: 'draft chapter', role: 'author', playbook: 'publishing' });
  assert.equal(est.samples, 4);
  assert.equal(est.medianDurationMs, 67.5 * 60_000);
});

test('records that never ran shape the landing rate but not the duration', () => {
  const records = [
    rec({ taskId: 'a', durationMs: 60 * 60_000, status: 'done' }),
    rec({ taskId: 'b', durationMs: 80 * 60_000, status: 'done' }),
    rec({ taskId: 'c', durationMs: 0, status: 'canceled' }),
    rec({ taskId: 'd', durationMs: 0, status: 'canceled' }),
  ];
  const est = estimateFrom(records, { text: 'draft chapter', role: 'author', playbook: 'publishing' });
  assert.equal(est.medianDurationMs, 70 * 60_000, 'a task that never ran says nothing about how long the work takes');
  assert.equal(est.successRate, 0.5, 'but it says everything about whether work of this shape lands');
});

test('nothing comparable returns zero samples rather than a confident zero', () => {
  const est = estimateFrom([rec()], { text: 'rebalance the portfolio', role: 'analyst', playbook: 'investment' });
  assert.equal(est.samples, 0);
  assert.deepEqual(est.basis, []);
});

test('the estimate reports its own evidence', () => {
  const est = estimateFrom([rec({ taskId: 'x' })], { text: 'draft chapter' });
  assert.deepEqual(est.basis.map((b) => b.taskId), ['x']);
});

test('estimateTask widens past the role narrowing rather than answering from one sample', () => {
  const s = store();
  // One publishing/author record, and four elsewhere that still share words.
  const seed = (title: string, playbook: string, role: string, durationMs: number): void => {
    const t = s.addTask({ title, prompt: 'x', playbook, role });
    const run = s.startRun(t.id);
    s.endRun(run.id, 'succeeded');
    s.db.prepare('UPDATE runs SET started_at = 0, ended_at = ? WHERE id = ?').run(durationMs, run.id);
    close(s, t.id, 'done', 30);
  };
  seed('draft chapter one', 'publishing', 'author', 60 * 60_000);
  for (let i = 0; i < 4; i++) seed(`draft chapter ${i + 2}`, 'publishing', 'line-editor', 20 * 60_000);
  s.archiveClosed(7);

  const est = s.estimateTask({ text: 'draft chapter', playbook: 'publishing', role: 'author' });
  assert.ok(est.samples > 1, 'one sample is not an estimate; the search widens instead of pretending');
  s.close();
});

test('humanDuration never prints a bare zero for work that did not run', () => {
  assert.equal(humanDuration(0), '—');
  assert.equal(humanDuration(30_000), '30s');
  assert.equal(humanDuration(10 * 60_000), '10m');
  assert.equal(humanDuration(3 * 3_600_000), '3.0h');
  assert.equal(humanDuration(72 * 3_600_000), '3.0d');
});

test('archiveTerms drops stopwords and duplicates so search scans words, not prose', () => {
  const t = archiveTerms('Draft the chapter and fix the chapter', null, 'author', 'publishing');
  const words = t.split(' ');
  assert.equal(new Set(words).size, words.length, 'no duplicates');
  assert.ok(!words.includes('the'));
  assert.ok(words.includes('chapter'));
});
