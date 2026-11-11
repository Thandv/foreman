// The signed-in, four-eyes merge-request landing, end to end on this machine: two people sign in on a throwaway daemon, and
// approvals land through the local fake GitLab (scripts/forge/fakeGitlab.ts) in three passes.
//   1. alice's approval of alice's own ticket is refused; bob's opens the MR; the pipeline passes; it merges at the
//      reviewed sha, the checkout is synced, the main check is green and the dependent ticket is released;
//   2. the pipeline fails: the ticket is back at the gate;
//   3. the MR's head moves and its pipeline passes: GitLab refuses a merge at the reviewed sha (409) and the ticket is
//      back at the gate.
// Usage: node scripts/demo/mr-landing.ts [--keep] [--check]
//   --keep   leave the temp dirs (daemon home with landing.json and the token file, repo, forge) and print them
//   --check  no pauses and a pipeline that answers at once: the mode the suite runs (test/demo-mr-landing.test.ts)
// Nothing is touched outside temp dirs: the daemon has its own FOREMAN_HOME and port (never ~/.foreman or the live
// daemon's), and nothing leaves this machine. The GitLab token is generated here and is never printed.
import { keepScratch } from '../bench/env.ts';
import { call, mint, forgeFixture, parked, submit, untilStatus } from '../bench/api.ts';
import { startDaemon, openFeed, type Daemon, type Feed } from '../bench/daemon.ts';
import { startFakeGitlab, type FakeGitlab } from '../forge/fakeGitlab.ts';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { keep: { type: 'boolean' }, check: { type: 'boolean' } }, strict: true });
const check = values.check === true;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WAIT_MS = 60_000;
const PROJECT = 'group/app';
const TEST_CMD = { testCmd: 'true' };
/** How long the fake reports 'checking' after a push or a pipeline change. */
const CHECKING_MS = check ? 0 : 1_000;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
const short = (sha: string): string => sha.slice(0, 7);
/** A person has time to read the steps; the suite does not wait. */
const pause = (ms: number): Promise<void> => (check ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

async function main(): Promise<void> {
  const { repo, bare } = forgeFixture();
  const token = randomBytes(24).toString('hex');
  const fake = await startFakeGitlab({ projects: { [PROJECT]: bare }, token, pipeline: 'manual', checkingMs: CHECKING_MS });
  const landing = { [repo]: { mode: 'mr', forge: 'gitlab', baseUrl: fake.url, project: PROJECT, pushUrl: bare, targetBranch: 'main', requirePipeline: true } };
  const d = await startDaemon('demo', root, {
    files: { 'landing.json': JSON.stringify(landing), 'secrets/gitlab-token': `${token}\n` },
    env: { FOREMAN_LANDING: 'mr', FOREMAN_WORKER_SUITE: 'targeted', FOREMAN_MR_POLL_MS: check ? '100' : '500' },
  });
  const feed = await openFeed(d.url);
  try {
    await passes(d, feed, fake, { repo, bare, token });
  } finally {
    feed.close();
    await d.stop();
    await fake.close();
  }
}

/** The forge's own answer, as the demo's person at GitLab would see it. */
async function forge(fake: FakeGitlab, method: string, urlPath: string, token: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${fake.url}${urlPath}`, { method, headers: { 'private-token': token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function passes(d: Daemon, feed: Feed, fake: FakeGitlab, { repo, bare, token }: { repo: string; bare: string; token: string }): Promise<void> {
  const mrPath = (iid: number): string => `/api/v4/projects/${encodeURIComponent(PROJECT)}/merge_requests/${iid}`;
  const alice = await mint(d, 'alice');
  const bob = await mint(d, 'bob');
  const event = (id: string, text: string): Promise<string> => feed.waitFor((e) => e.taskId === id && e.message.includes(text), WAIT_MS).then((e) => e.message);
  /** bob approves `id`: the MR's iid and the commit its head is, which must be the ticket's reviewed commit. */
  const approved = async (id: string): Promise<{ iid: number; head: string }> => {
    const res = await call(d, 'POST', `/api/tasks/${id}/approve`, { token: bob, body: {} });
    const merge = res.json['merge'] as { code: string; branch: string };
    const iid = (res.json['decision'] as { extra: { mrIid?: number } }).extra.mrIid;
    if (res.status !== 200 || merge.code !== 'mr-opened' || !iid) throw new Error(`bob's approval of ${id}: ${res.status} ${JSON.stringify(res.json)}`);
    const head = String((await forge(fake, 'GET', mrPath(iid), token)).json['sha']);
    if (head !== git(repo, 'rev-parse', merge.branch)) throw new Error(`!${iid} head is not the ticket's reviewed commit`);
    return { iid, head };
  };
  const backAtGate = async (id: string): Promise<string> => {
    const reason = (await event(id, 'back to the gate')).replace(/^.*back to the gate: /, '');
    await untilStatus(d, bob, id, 'awaiting-approval');
    return reason;
  };

  console.log('pass 1: the pipeline passes');
  const t1 = await parked(d, alice, repo, 'alpha', TEST_CMD);
  const t2 = await submit(d, alice, repo, 'beta', { ...TEST_CMD, deps: [t1] });
  const own = await call(d, 'POST', `/api/tasks/${t1}/approve`, { token: alice, body: {} });
  if (own.status !== 403) throw new Error(`alice's approval of her own ticket was not refused: ${own.status}`);
  console.log(`  1. alice approves her own ticket ${t1}: refused (403) ${String(own.json['error'])}`);
  const first = await approved(t1);
  console.log(`  2. bob approves ${t1}: mr-opened, !${first.iid} head ${short(first.head)} is the reviewed commit`);
  await pause(1_500);
  await forge(fake, 'POST', `/__fake/pipelines/${first.head}`, token, { status: 'success' });
  const merged = /at ([0-9a-f]+)/.exec(await event(t1, `merged !${first.iid} at`))![1]!;
  await event(t1, `checkout synced to ${merged}`);
  if (git(repo, 'rev-parse', 'HEAD') !== merged) throw new Error('the checkout is not at the merge commit');
  await untilStatus(d, bob, t2, 'awaiting-approval');
  console.log(`  3. pipeline success: merged !${first.iid} at ${short(merged)}, checkout synced, main check green, dependent ${t2} released`);

  console.log('pass 2: the pipeline fails');
  const t3 = await parked(d, alice, repo, 'gamma', TEST_CMD);
  const second = await approved(t3);
  console.log(`  1. bob approves ${t3}: mr-opened, !${second.iid} head ${short(second.head)} is the reviewed commit`);
  await pause(1_500);
  await forge(fake, 'POST', `/__fake/pipelines/${second.head}`, token, { status: 'failed' });
  console.log(`  2. pipeline failed: ${t3} is back at the gate (awaiting-approval): ${await backAtGate(t3)}`);

  console.log('pass 3: the MR head moves');
  const t4 = await parked(d, alice, repo, 'delta', TEST_CMD);
  const third = await approved(t4);
  console.log(`  1. bob approves ${t4}: mr-opened, !${third.iid} head ${short(third.head)} is the reviewed commit`);
  const moved = git(bare, 'commit-tree', `${third.head}^{tree}`, '-p', third.head, '-m', 'pushed after review');
  git(bare, 'update-ref', `refs/heads/foreman/${t4}`, moved);
  // GitLab checks mergeability before the sha (405 while the pipeline runs), so the moved head is made mergeable first:
  // read the MR (the fake sees the push), pass its pipeline and wait out the checking window. The stale sha is then the
  // only reason left to refuse.
  await forge(fake, 'GET', mrPath(third.iid), token);
  await forge(fake, 'POST', `/__fake/pipelines/${moved}`, token, { status: 'success' });
  await pause(CHECKING_MS);
  const refused = await forge(fake, 'PUT', `${mrPath(third.iid)}/merge?sha=${third.head}`, token);
  if (refused.status !== 409) throw new Error(`the merge at the reviewed sha was not refused: ${refused.status}`);
  console.log(`  2. head moved to ${short(moved)} and its pipeline passed: the merge at the reviewed sha was refused (409) ${String(refused.json['message'])}`);
  console.log(`  3. ${t4} is back at the gate (awaiting-approval): ${await backAtGate(t4)}`);
}

const t0 = Date.now();
await main();
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
if (values.keep) for (const dir of keepScratch()) console.log(`kept: ${dir}`);
