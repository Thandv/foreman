// One landing run against a daemon that is already up, over its HTTP API only, so the same code measures any build of
// Foreman (scripts/bench/landing.ts runs it on this branch, the comparison harness on the commit before the landing
// work too). Takes no env, home or port of its own and starts nothing: the caller owns the daemon, its repo and any forge.
// A run: `tickets` shell tickets in one repo, each parked at the gate with a fake suite that logs itself; then approvals
// `approveGapMs` apart (with `badLast`, the last ticket also writes bad.txt, which turns the post-merge suite red); then the wait until
// every merge has been covered by a check that ended after it, or `waitMs` is up.
import fs from 'node:fs';
import path from 'node:path';
import { percentile } from '../../src/latency.ts';
import { mergedToVerifiedMs, namedInRed, ownChecksOf, parseSuiteLog, perLanded, type SuiteRun } from './outcome.ts';

export interface LandingTarget {
  url: string;
  /** A git repo with a commit on main, the one every ticket lands in. */
  repo: string;
  /** A directory the run may write its suite log and stamp script to. */
  scratch: string;
}

export interface LandingPlan {
  tickets: number;
  suiteMs: number;
  /** Pause between one approval being sent and the next; the approvals are not waited for. */
  approveGapMs: number;
  /** Whether the last ticket's change is bad: it also writes bad.txt, and the run waits for the red that names it. */
  badLast: boolean;
  /** The worker's shell command for ticket `i`: it must write ticket-<i>.txt; the bad ticket also gets bad.txt written. */
  prompt(i: number): string;
  /** A file the worker appends a line to for each verify slot its wrapper was granted; none when workers run no wrapper. */
  leasesFile?: string;
  /** The event on a ticket's timeline that says its change reached main (the merge, or the merge request merging). */
  merged: RegExp;
  /** How long to wait for the tickets to park and, after the approvals, for the checks. */
  waitMs: number;
}

interface Spread { p50: number; p95: number }

export interface LandingResult {
  tickets: number;
  landed: number;
  /** Fake suite runs: each ticket's own check, post-merge checks, re-runs. */
  suiteRuns: number;
  /** Of suiteRuns, the own checks of tickets that did not land. */
  unlandedOwnChecks: number;
  /** suiteRuns less unlandedOwnChecks, per landed ticket. */
  suiteRunsPerLanded: number;
  /** Verify slots the workers' own wrapper runs were granted, per landed ticket; not in suiteRuns. */
  workerLeasesPerLanded: number;
  landingsPerHour: number;
  /** The approving call sent → the ticket's merge event. */
  approveToMergedMs: Spread;
  /** The merge event → the first suite run to end after it in a checkout holding the ticket's file. */
  mergedToVerifiedMs: Spread;
  /** Tickets whose approval did not land them: the ticket back at the gate, and the merge event that says why. */
  notLanded: Array<{ id: string; why: string }>;
  /** Landed tickets no check covered when the wait ended. */
  unverified: number;
  /** The last ticket's change is bad: did it merge, did a red name it, and how many tickets did the red name. */
  red: { culprit: string; culpritLanded: boolean; named: string[]; attributed: boolean };
  errors: string[];
}

interface TaskView { status: string; events: Array<{ ts: number; message: string }> }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function api(t: LandingTarget, method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${t.url}${urlPath}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function view(t: LandingTarget, id: string): Promise<TaskView> {
  const json = (await api(t, 'GET', `/api/tasks/${id}`)).json as { task: { status: string }; events: TaskView['events'] };
  return { status: json.task.status, events: json.events };
}

function spread(ms: number[]): Spread {
  const sorted = [...ms].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

/** The fake suite: waits suiteMs, logs when it ended and which ticket files it holds, and fails only in a post-merge checkout (foreman-main-*) that has bad.txt. */
function fakeSuite(t: LandingTarget, suiteMs: number): { cmd: string; log: string } {
  const log = path.join(t.scratch, 'suite-log');
  const stamp = path.join(t.scratch, 'stamp.cjs');
  fs.writeFileSync(stamp, `const fs = require('node:fs');
const files = fs.readdirSync('.').filter((f) => /^ticket-.*\\.txt$/.test(f));
fs.appendFileSync(process.argv[2], Date.now() + ' ' + files.join(',') + '\\n');
process.exit(/foreman-main-/.test(process.cwd()) && fs.existsSync('bad.txt') ? 1 : 0);
`);
  return { cmd: `sleep ${suiteMs / 1000}; '${process.execPath}' '${stamp}' '${log}'`, log };
}

export async function runLanding(t: LandingTarget, plan: LandingPlan): Promise<LandingResult> {
  const suite = fakeSuite(t, plan.suiteMs);
  const ids: string[] = [];
  for (let i = 0; i < plan.tickets; i++) {
    const bad = plan.badLast && i === plan.tickets - 1;
    const made = await api(t, 'POST', '/api/tasks', {
      title: `landing ${i}`, prompt: bad ? `${plan.prompt(i)} && printf 'x\\n' > bad.txt` : plan.prompt(i),
      runner: 'shell', kind: 'code', repo: t.repo, testCmd: suite.cmd,
    });
    if (made.status !== 201) throw new Error(`ticket ${i}: ${made.status} ${JSON.stringify(made.json)}`);
    ids.push(made.json['id'] as string);
  }
  const deadline = Date.now() + plan.waitMs;
  for (const id of ids) {
    for (;;) {
      const status = (await view(t, id)).status;
      if (status === 'awaiting-approval') break;
      if (status === 'failed' || Date.now() > deadline) throw new Error(`${id} did not park: ${status}`);
      await sleep(100);
    }
  }
  const errors: string[] = [];
  const approvedAt: number[] = [];
  const calls: Array<Promise<void>> = [];
  for (const id of ids) {
    approvedAt.push(Date.now());
    calls.push(api(t, 'POST', `/api/tasks/${id}/approve`, {}).then((r) => {
      if (r.status !== 200) errors.push(`approve ${id}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    }));
    await sleep(plan.approveGapMs);
  }
  await Promise.all(calls);
  const waitUntil = Date.now() + plan.waitMs;
  const last = ids.length - 1;
  let views: TaskView[] = [];
  let mergedAt: Array<number | undefined> = [];
  let verified: Array<number | undefined> = [];
  let named: string[] = [];
  let refused: boolean[] = [];
  let runs: SuiteRun[] = [];
  for (;;) {
    views = await Promise.all(ids.map((id) => view(t, id)));
    runs = parseSuiteLog(fs.existsSync(suite.log) ? fs.readFileSync(suite.log, 'utf8') : '');
    mergedAt = views.map((v) => v.events.find((e) => plan.merged.test(e.message))?.ts);
    verified = mergedAt.map((at, i) => (at === undefined ? undefined : mergedToVerifiedMs(runs, `ticket-${i}.txt`, at)));
    named = namedInRed(views.flatMap((v) => v.events.map((e) => e.message)));
    // An approval that did not land its ticket leaves it back at the gate for good; every other change is covered once
    // a check has seen it, and the bad one once a red names it.
    refused = views.map((v) => v.status !== 'done');
    const seen = (i: number): boolean => refused[i]! || (plan.badLast && i === last ? named.length > 0 : verified[i] !== undefined);
    if (ids.every((_, i) => seen(i)) || Date.now() > waitUntil) break;
    await sleep(200);
  }
  const good = ids.map((_, i) => i).filter((i) => !(plan.badLast && i === last));
  const landed = mergedAt.filter((a) => a !== undefined).length;
  const ends = verified.flatMap((v, i) => (v === undefined || mergedAt[i] === undefined ? [] : [mergedAt[i]! + v]));
  const span = ends.length ? Math.max(...ends) - approvedAt[0]! : 0;
  const leases = plan.leasesFile && fs.existsSync(plan.leasesFile) ? fs.readFileSync(plan.leasesFile, 'utf8').split('\n').filter((l) => l !== '').length : 0;
  const unlandedOwnChecks = ownChecksOf(runs, ids.flatMap((_, i) => (mergedAt[i] === undefined ? [`ticket-${i}.txt`] : [])));
  return {
    tickets: plan.tickets,
    landed,
    suiteRuns: runs.length,
    unlandedOwnChecks,
    suiteRunsPerLanded: perLanded(runs.length - unlandedOwnChecks, landed),
    workerLeasesPerLanded: perLanded(leases, landed),
    landingsPerHour: span > 0 ? Math.round((ends.length / span) * 3_600_000) : 0,
    approveToMergedMs: spread(mergedAt.flatMap((at, i) => (at === undefined ? [] : [at - approvedAt[i]!]))),
    mergedToVerifiedMs: spread(verified.filter((v): v is number => v !== undefined)),
    notLanded: ids.flatMap((id, i) => (refused[i] ? [{ id, why: views[i]!.events.findLast((e) => e.message.startsWith('merge: '))?.message.slice(0, 160) ?? views[i]!.status }] : [])),
    unverified: good.filter((i) => mergedAt[i] !== undefined && verified[i] === undefined).length,
    red: { culprit: ids[last]!, culpritLanded: mergedAt[last] !== undefined, named, attributed: named.includes(ids[last]!) },
    errors,
  };
}
