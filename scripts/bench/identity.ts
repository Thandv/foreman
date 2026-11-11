// What identity costs and what it adds, on throwaway daemons (daemon.ts) with nothing real behind them.
//   A. Comparable, per-request latency (p50/p95) of GET /api/state and POST /api/tasks: a daemon built from --base (a
//      checkout of the commit before identity existed), the branch's daemon with auth off, and the branch's with a bearer.
//   B. A NEW CAPABILITY, not a speed-up, on the branch only: approve to merged through the local fake GitLab
//      (scripts/forge/fakeGitlab.ts), with one principal and then with four-eyes, plus a transcript of the four-eyes demo.
// Usage: node scripts/bench/identity.ts [--base <checkout>] [--branch <checkout>] [--requests 200] [--out <dir>] [--json]
// Writes raw.json, summary.md and demo-transcript.txt to --out (default comparisons/identity). Not part of npm run verify;
// comparisons/identity/method.md says how to read the numbers.
import { options, count } from './env.ts';
import { call, mint, forgeFixture, parked } from './api.ts';
import { startDaemon, openFeed, type Daemon, type Feed } from './daemon.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitlab } from '../forge/fakeGitlab.ts';
import { percentile } from '../../src/latency.ts';

interface Row { daemon: 'base' | 'branch'; auth: 'off' | 'bearer'; op: string; samples: number; p50Ms: number; p95Ms: number }
interface Landing { mode: 'single-principal' | 'four-eyes'; approveToMergedMs: number }
interface Refusal { status: number; error: string }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WARMUP = 5;
/** How long an MR may take to merge before the bench gives up. */
const WAIT_MS = 60_000;

const round = (n: number): number => Math.round(n * 100) / 100;

async function timed(d: Daemon, daemon: Row['daemon'], auth: Row['auth'], token: string | undefined, n: number): Promise<Row[]> {
  const ops: Array<[string, () => Promise<{ status: number }>]> = [
    ['GET /api/state', () => call(d, 'GET', '/api/state', token ? { token } : {})],
    // A task for a person's desk never runs, so the daemon does no work beyond the request.
    ['POST /api/tasks', () => call(d, 'POST', '/api/tasks', { body: { title: 'bench', prompt: 'true', assignee: 'human' }, ...(token ? { token } : {}) })],
  ];
  const rows: Row[] = [];
  for (const [op, run] of ops) {
    const ms: number[] = [];
    for (let i = 0; i < WARMUP + n; i++) {
      const t0 = performance.now();
      const { status } = await run();
      if (status >= 300) throw new Error(`${daemon}/${auth} ${op}: ${status}`);
      if (i >= WARMUP) ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    rows.push({ daemon, auth, op, samples: n, p50Ms: round(percentile(ms, 0.5)), p95Ms: round(percentile(ms, 0.95)) });
  }
  return rows;
}

/** One fresh daemon of `checkout`, measured as it starts, so every row sees the same empty ledger. */
async function measure(daemon: Row['daemon'], checkout: string, auth: Row['auth'], n: number, started: Daemon[]): Promise<Row[]> {
  const d = await startDaemon(`${daemon}-${auth}`, checkout);
  started.push(d);
  try {
    return await timed(d, daemon, auth, auth === 'bearer' ? await mint(d, 'alice') : undefined, n);
  } finally {
    await d.stop();
  }
}

/** From the approving call to Foreman's own "merged" event: the person's wait before approving is not in it. */
async function approveToMerged(d: Daemon, feed: Feed, token: string, id: string): Promise<{ ms: number; code: string; merged: string }> {
  const t0 = performance.now();
  const res = await call(d, 'POST', `/api/tasks/${id}/approve`, { token, body: {} });
  if (res.status !== 200) throw new Error(`approve ${id}: ${res.status} ${JSON.stringify(res.json)}`);
  const merged = await feed.waitFor((e) => e.taskId === id && e.message.startsWith('merged !'), WAIT_MS);
  return { ms: round(performance.now() - t0), code: (res.json['merge'] as { code: string }).code, merged: merged.message };
}

async function landings(branch: string, started: Daemon[]): Promise<{ landings: Landing[]; refusal: Refusal; transcript: string[] }> {
  const { repo, bare } = forgeFixture();
  const fake = await startFakeGitlab({ projects: { 'group/app': bare }, pipeline: 'success' });
  const landing = { [repo]: { mode: 'mr', forge: 'gitlab', baseUrl: fake.url, project: 'group/app', pushUrl: bare, targetBranch: 'main', requirePipeline: true } };
  const d = await startDaemon('landing', branch, {
    files: { 'landing.json': JSON.stringify(landing) },
    env: { FOREMAN_LANDING: 'mr', FOREMAN_MR_POLL_MS: '100', FOREMAN_POSTMERGE_CHECK: 'off' },
  });
  started.push(d);
  const feed = await openFeed(d.url);
  try {
    const alice = await mint(d, 'alice');
    const single = await approveToMerged(d, feed, alice, await parked(d, alice, repo, 'alice-solo'));

    const bob = await mint(d, 'bob');
    const id = await parked(d, alice, repo, 'alice');
    const refused = await call(d, 'POST', `/api/tasks/${id}/approve`, { token: alice, body: {} });
    const paired = await approveToMerged(d, feed, bob, id);
    // The notes are in order: the last is the four-eyes ticket's, approved by bob.
    const note = fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/notes')).at(-1);
    if (!note?.body) throw new Error('Foreman posted no approver note on the merge request');
    const trailers = (JSON.parse(note.body) as { body: string }).body.split('\n').filter((l) => l.startsWith('Foreman-'));
    const refusal: Refusal = { status: refused.status, error: String(refused.json['error'] ?? '') };
    return {
      landings: [{ mode: 'single-principal', approveToMergedMs: single.ms }, { mode: 'four-eyes', approveToMergedMs: paired.ms }],
      refusal,
      transcript: [
        '# The four-eyes demo on throwaway daemons: one host, the local fake GitLab, a project with no required approval rules.',
        '# Attribution, not security: see method.md.',
        ...feed.events.filter((e) => e.type === 'principal-minted' || e.type === 'token-minted').map((e) => `events: ${e.type} ${e.message}`),
        `alice submits ${id}: "alice's change"`,
        `alice approves ${id} -> ${refusal.status} ${refusal.error}`,
        `bob approves ${id} -> 200 ${paired.code}`,
        'merge request note posted by Foreman:',
        ...trailers.map((l) => `  ${l}`),
        `events: ${paired.merged}`,
      ],
    };
  } finally {
    feed.close();
    await d.stop();
    await fake.close();
  }
}

function summary(rows: Row[], landed: Landing[], o: { requests: number; hasBase: boolean }): string {
  const table = rows.map((r) => `| ${r.daemon} | ${r.auth} | ${r.op} | ${r.p50Ms} | ${r.p95Ms} |`).join('\n');
  const lines = landed.map((l) => `| ${l.mode} | ${l.approveToMergedMs} |`).join('\n');
  return `# Identity bench

## A. Comparable: per-request latency (ms), ${o.requests} requests each

${o.hasBase ? '' : 'No --base given: only the branch is measured.\n\n'}| daemon | auth | request | p50 | p95 |
|---|---|---|---|---|
${table}

## B. NEW CAPABILITY (branch only; not a speed-up, nothing to compare it with)

Approve to merged through the fake GitLab, from the approving call to Foreman's "merged" event. The person's wait is not
in it. MR poll interval 100 ms.

| mode | approve to merged (ms) |
|---|---|
${lines}
`;
}

const { values, json } = options({ base: '', branch: root, requests: '200', out: path.join(root, 'comparisons', 'identity') });
const n = count('requests', values.requests);
const started: Daemon[] = [];
const rows: Row[] = [];
if (values.base) rows.push(...await measure('base', values.base, 'off', n, started));
rows.push(...await measure('branch', values.branch, 'off', n, started));
rows.push(...await measure('branch', values.branch, 'bearer', n, started));
const landing = await landings(values.branch, started);
const result = {
  comparable: { requests: n, rows },
  newCapability: { landings: landing.landings, refusal: landing.refusal },
  isolation: { daemons: started.map((d) => ({ name: d.name, home: d.home, port: d.port })) },
};
fs.mkdirSync(values.out, { recursive: true });
fs.writeFileSync(path.join(values.out, 'raw.json'), `${JSON.stringify(result, null, 2)}\n`);
const text = summary(rows, landing.landings, { requests: n, hasBase: values.base !== '' });
fs.writeFileSync(path.join(values.out, 'summary.md'), text);
fs.writeFileSync(path.join(values.out, 'demo-transcript.txt'), `${landing.transcript.join('\n')}\n`);
console.log(json ? JSON.stringify(result) : text);
