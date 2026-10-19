import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

/** Run the CLI against a stub daemon; resolves with what the stub saw and what the CLI printed. */
async function approveAgainstStub(argv: string[], delayMs: number): Promise<{ seen: { method: string; url: string; body: string }; stdout: string; code: number | null }> {
  let seen = { method: '', url: '', body: '' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method ?? '', url: req.url ?? '', body };
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 't_x', status: 'done', merge: { branch: 'b', reason: 'merged 1 commit(s)' } }));
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const child = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1' } });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    return { seen, stdout, code };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('CLI approve posts to the approve route, carries --note, and waits out a slow merge', async () => {
  const r = await approveAgainstStub(['approve', 't_x', '--note', 'live-tested: pass'], 1_500);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.seen.method, 'POST');
  assert.equal(r.seen.url, '/api/tasks/t_x/approve');
  assert.deepEqual(JSON.parse(r.seen.body), { note: 'live-tested: pass' });
  assert.match(r.stdout, /t_x → done\nmerge: merged 1 commit\(s\)/);
});

test('CLI approve without --note sends an empty object', async () => {
  const r = await approveAgainstStub(['approve', 't_x'], 0);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.seen.body), {});
});

test('CLI approve --as-is sends the tree to land as acceptTree', async () => {
  const sha = 'a8be960dea43f5d6e32e64477addce985ebefc72';
  const r = await approveAgainstStub(['approve', 't_x', '--as-is', sha, '--note', 'my own edit'], 0);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(JSON.parse(r.seen.body), { note: 'my own edit', acceptTree: sha });
});

/** Run the CLI against a stub daemon that answers each `METHOD /path` with the JSON given for it. */
async function cliAgainstRoutes(argv: string[], routes: Record<string, unknown>): Promise<{ stdout: string; code: number | null; asked: string[] }> {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const key = `${req.method} ${req.url}`;
      asked.push(key);
      const body = routes[key];
      res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? { error: 'not found' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const child = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1' } });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    return { stdout, code, asked };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const lastLine = (stdout: string): string => stdout.trimEnd().split('\n').pop() ?? '';
// What merge.ts answers for an approved ticket whose merge-on-approve is off, as the approve route returns it.
const UNMERGED = { merged: false, reason: 'merge-on-approve disabled for this task', branch: 'foreman/t_x-r_new' };
const RUNS = {
  task: { id: 't_x' },
  runs: [
    { id: 'r_new', branch: 'foreman/t_x-r_new', worktreePath: '/work/r_new' },
    { id: 'r_old', branch: 'foreman/t_x-r_old', worktreePath: '/work/r_old' },
  ],
};

test('CLI approve of a ticket whose kind does not merge ends with a loud NOT MERGED line naming the kind and where the work is', async () => {
  const r = await cliAgainstRoutes(['approve', 't_x'], {
    'POST /api/tasks/t_x/approve': { id: 't_x', status: 'done', kind: 'writing', merge: UNMERGED },
    'GET /api/tasks/t_x': RUNS,
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(
    lastLine(r.stdout),
    "NOT MERGED: this ticket's kind (writing) does not merge on approval — its work is still in /work/r_new; land it by hand or requeue it as --kind code",
  );
});

test('CLI approve: a code ticket with merging switched off is NOT MERGED too, without the advice to requeue it as code; the branch is named when the worktree is not known', async () => {
  const r = await cliAgainstRoutes(['approve', 't_x'], {
    'POST /api/tasks/t_x/approve': { id: 't_x', status: 'done', kind: 'code', merge: UNMERGED },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(lastLine(r.stdout), 'NOT MERGED: merge-on-approve is off for this ticket — its work is still in branch foreman/t_x-r_new; land it by hand');
});

test('CLI approve says NOT MERGED only for a ticket that does not merge: not for a merge, a merge that failed for another reason, or an approval with no branch', async () => {
  for (const merge of [
    { merged: true, reason: 'merged 1 commit(s)', branch: 'b' },
    { merged: false, reason: 'merge failed: conflict in README.md', branch: 'b' },
    { merged: false, reason: 'nothing to merge', branch: null },
  ]) {
    const r = await cliAgainstRoutes(['approve', 't_x'], {
      'POST /api/tasks/t_x/approve': { id: 't_x', status: 'done', kind: 'writing', merge },
      'GET /api/tasks/t_x': RUNS,
    });
    assert.equal(r.code, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /NOT MERGED/, merge.reason);
    assert.deepEqual(r.asked, ['POST /api/tasks/t_x/approve'], 'and no second request is made for it');
  }
});

test('CLI build shows a corrected kind on the ticket it changed, and not again in the plan check', async () => {
  const r = await cliAgainstRoutes(['build', 'document the lock'], {
    'POST /api/build': {
      plan: {
        epic: { title: 'Docs' }, playbook: 'soft', degraded: false, notes: '',
        tickets: [
          { ref: 't1', role: 'architect', points: 2, title: 'ADR: the lock race', after: [], acceptance: null },
          { ref: 't2', role: 'dev', points: 1, title: 'Fix the message', after: [], acceptance: null },
        ],
      },
      findings: [
        { level: 'note', code: 'kind-corrected', ticket: 't1', message: 'kind writing → code (deliverable is a file in a gated repo)' },
        { level: 'note', code: 'epic-size', message: "10 tickets, as the ask's 10 numbered items" },
      ],
      critique: null, revision: null, epic: null, queued: [],
    },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /t1 +architect +2 +ADR: the lock race\n +kind writing → code \(deliverable is a file in a gated repo\)\n +t2 /);
  assert.equal(r.stdout.split('kind writing → code').length - 1, 1, 'said once');
  assert.match(r.stdout, /plan check:\n  \[note\] epic-size: 10 tickets, as the ask's 10 numbered items\n/);
});

test('CLI build prints each note of the senior review with where it is kept, and marks the tickets that carry one', async () => {
  const r = await cliAgainstRoutes(['build', 'fix the lock', '--check', '--revise'], {
    'POST /api/build': {
      plan: {
        epic: { title: 'Lock' }, playbook: 'soft', degraded: false, notes: '',
        tickets: [
          { ref: 't4', role: 'dev', points: 2, title: 'Mark dead runs', after: [], acceptance: null, reviewNotes: ['t4: pid reuse needs a rule'] },
          { ref: 't5', role: 'dev', points: 1, title: 'Private index', after: [], acceptance: null },
        ],
        review: {
          verdict: 'risky',
          notes: [
            { text: 't4: pid reuse needs a rule', tickets: ['t4'], unmatched: [] },
            { text: 'six tickets may collide on README', tickets: [], unmatched: [] },
            { text: 't9: nobody owns the migration', tickets: [], unmatched: ['t9'] },
          ],
        },
      },
      findings: [],
      critique: { verdict: 'risky', notes: ['t4: pid reuse needs a rule', 'six tickets may collide on README', 't9: nobody owns the migration'] },
      revision: null, epic: null, queued: [],
    },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /t4 +dev +2 +Mark dead runs\n +plan review notes in its brief: 1 /);
  assert.doesNotMatch(r.stdout, /Private index\n +plan review notes/);
  assert.ok(r.stdout.includes(
    'senior review: risky\n' +
      '  - t4: pid reuse needs a rule\n      → in the brief of t4\n' +
      '  - six tickets may collide on README\n      → on the epic only (it names no ticket)\n' +
      '  - t9: nobody owns the migration\n      → NOT MATCHED to a ticket (it names t9, which the plan does not have): on the epic only\n',
  ), r.stdout);
});

// review r1 on-top: the line keys on merge.ts's own answer, taken here from merge.ts rather than from a copy of it.
test('CLI approve: the NOT MERGED line fires on what mergeApproved itself answers for a ticket that does not merge on approval', async () => {
  const { mergeApproved } = await import('../src/merge.ts');
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-notmerged-'));
  execFileSync('git', ['init', '-q', repo]);
  try {
    const task = { id: 't_x', status: 'done', kind: 'writing', repo, mergeOnApprove: false, allowCore: false };
    const merge = await mergeApproved(task as never, { id: 'r_new', branch: 'foreman/t_x-r_new' } as never);
    assert.equal(merge.merged, false);
    assert.deepEqual(merge, UNMERGED, 'the literal the tests above use is what merge.ts answers');
    const r = await cliAgainstRoutes(['approve', 't_x'], {
      'POST /api/tasks/t_x/approve': { id: 't_x', status: 'done', kind: 'writing', merge },
      'GET /api/tasks/t_x': RUNS,
    });
    assert.match(lastLine(r.stdout), /^NOT MERGED: this ticket's kind \(writing\) does not merge on approval — its work is still in \/work\/r_new; /);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
