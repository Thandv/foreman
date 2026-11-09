// The whole pipeline under load, with nothing real behind it: shell workers that each write one file, a real temp git
// repo they land in, a fake test suite and a fake owner model. Reports tickets/h, dispatch, gate and landing latency,
// and suite runs per landed ticket, once with FOREMAN_GATE_BATCH on and once off.
// Usage: node scripts/bench/pipeline.ts [--tickets 20] [--workers 4] [--suite-ms 500] [--model-ms 2000] [--json]
// Not part of npm run verify (too slow); docs/capacity.md holds the numbers it printed and how to read them.
import { scratch, options, count } from './env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { percentile } from '../../src/latency.ts';
import { Store } from '../../src/queue.ts';
import { Scheduler } from '../../src/scheduler.ts';
import { outcome } from './outcome.ts';

interface Spread { p50: number; p90: number; max: number }

export interface PipelineResult {
  gateBatch: 'on' | 'off';
  tickets: number;
  landed: number;
  /** Owner-gate calls the fake model answered (a batch is one call). */
  modelCalls: number;
  /** Reviewer calls the fake model answered. */
  reviewCalls: number;
  /** Landed tickets per hour, from the first ticket queued to the last post-merge check passing. */
  ticketsPerHour: number;
  /** Queued to its run starting. */
  dispatchMs: Spread;
  /** Parked at the gate to merged: the owner model's call, the wait for the repo's merge section, the merge (the approve decision row). */
  gateMs: Spread;
  /** Merged to its post-merge check passing, which releases dependents (the owner gate logs its approval then). */
  landingMs: Spread;
  /** Fake suite runs (the ticket's own check, post-merge checks, re-runs) per landed ticket. */
  suiteRunsPerLanded: number;
  /** Each ticket that did not land: its status, the owner gate's marker and its last events, to say why. */
  unlanded: Array<{ id: string; status: string; gate: string | null; events: string[] }>;
}

/** How long a run may take before the bench gives up on it. */
const DEADLINE_MS = 30 * 60_000;

function spread(ms: number[]): Spread {
  const s = [...ms].sort((a, b) => a - b);
  return { p50: percentile(s, 0.5), p90: percentile(s, 0.9), max: s[s.length - 1] ?? 0 };
}

function gitRepo(): string {
  const dir = scratch('repo');
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'bench@example.invalid');
  git('config', 'user.name', 'Bench');
  fs.writeFileSync(path.join(dir, 'README.md'), 'bench\n');
  git('add', 'README.md');
  git('commit', '-qm', 'base');
  return dir;
}

/**
 * The model: a `claude` stand-in that waits `modelMs`, counts the call, and answers what it was asked. A reviewer
 * passes the work; the owner gate approves every ticket a batch prompt names, or the one ticket it is about.
 * FOREMAN_CLAUDE_BIN points both at it.
 */
function fakeModel(modelMs: number, calls: string): string {
  const bin = path.join(scratch('model'), 'claude');
  const body = `
const fs = require('node:fs');
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
const review = prompt.includes('REVIEW STYLE (');
fs.appendFileSync(${JSON.stringify(calls)}, review ? 'review\\n' : 'gate\\n');
const ids = [...prompt.matchAll(/=== TICKET (\\S+) ===/g)].map((m) => m[1]);
const rationale = 'the bench approves every ticket';
const result = review
  ? { verdict: 'pass', critique: 'the bench passes every review', issues: [] }
  : ids.length
    ? { decisions: ids.map((id) => ({ id, decision: 'approve', rationale })) }
    : { decision: 'approve', rationale };
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, result: JSON.stringify(result) }));
}, ${modelMs});
`;
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/**
 * The bench's playbook: one reviewer, and the owner gate deciding. The gate needs a review verdict to sign off, and
 * the crew chain is the reviewer the fake model can play (the council is local models).
 */
function playbooks(): string {
  const dir = scratch('playbooks');
  const front = {
    id: 'bench', description: 'Pipeline bench.', triggers: ['bench'],
    roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
    reviewers: [{ role: 'senior', style: 'code-review' }],
    escalation: { chair: 'planner', afterFailures: 2 },
    checks: [], gate: { default: 'owner', hardHuman: [] }, constraints: [],
  };
  const roles = '## role: planner\n\nYou chair.\n\n## role: senior\n\nYou review.\n\n## role: dev\n\nYou implement.\n';
  fs.writeFileSync(path.join(dir, 'bench.md'), `---\n${JSON.stringify(front, null, 2)}\n---\n${roles}`);
  return dir;
}

/** The lines of `file` equal to `line`, or every non-empty line; 0 when there is no file. */
const lines = (file: string, line?: string): number => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => (line === undefined ? l !== '' : l === line)).length
  : 0);

async function runOnce(gateBatch: 'on' | 'off', o: { tickets: number; workers: number; suiteMs: number; modelMs: number }): Promise<PipelineResult> {
  const dir = scratch(`run-${gateBatch}`);
  const calls = path.join(dir, 'model-calls');
  const suiteRuns = path.join(dir, 'suite-runs');
  process.env['FOREMAN_CLAUDE_BIN'] = fakeModel(o.modelMs, calls);
  process.env['FOREMAN_GATE_BATCH'] = gateBatch;
  const repo = gitRepo();
  // The fake suite: counts itself, then takes suiteMs. The same command runs as each ticket's check and as the
  // post-merge check on main.
  const suite = `printf 'x\\n' >> '${suiteRuns}'; sleep ${o.suiteMs / 1000}`;
  const store = new Store(path.join(dir, 'foreman.db'));
  const sched = new Scheduler(store, { maxWorkers: o.workers });
  try {
    const epic = store.addTask({ title: 'bench epic', prompt: 'bench', runner: 'shell', isEpic: true, playbook: 'bench' });
    const ids = Array.from({ length: o.tickets }, (_, i) => store.addTask({
      title: `bench ticket ${i}`, prompt: `printf '${i}\\n' > ticket-${i}.txt`, kind: 'code', runner: 'shell',
      repo, testCmd: suite, parentId: epic.id, playbook: 'bench', role: 'dev', maxAttempts: 1,
    }).id);
    sched.start();
    const deadline = Date.now() + DEADLINE_MS;
    const settled = (): boolean => ids.every((id) => outcome(store, id) !== 'pending');
    while (!settled()) {
      if (Date.now() > deadline) throw new Error(`gate batch ${gateBatch}: not settled after ${DEADLINE_MS / 60_000} min`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const dispatch: number[] = [];
    const gate: number[] = [];
    const landing: number[] = [];
    const unlanded: PipelineResult['unlanded'] = [];
    let landed = 0;
    let first = Infinity;
    let last = 0;
    for (const id of ids) {
      const task = store.getTask(id)!;
      first = Math.min(first, task.createdAt);
      const run = store.latestRun(id);
      if (run) dispatch.push(run.startedAt - task.createdAt);
      const events = store.eventsForTask(id);
      const parked = events.find((e) => e.type === 'status' && e.message === 'awaiting-approval');
      const approved = events.find((e) => e.message.startsWith('owner-gate: approved'));
      const decision = store.decisionsForTask(id).find((d) => d.action === 'approve');
      if (outcome(store, id) !== 'landed' || !decision || !approved) {
        unlanded.push({ id, status: task.status, gate: store.gateDecision(id), events: events.slice(-5).map((e) => `${e.type}: ${e.message.slice(0, 200)}`) });
        continue;
      }
      landed++;
      last = Math.max(last, approved.ts);
      if (parked) gate.push(decision.at - parked.ts);
      landing.push(approved.ts - decision.at);
    }
    return {
      gateBatch,
      tickets: o.tickets,
      landed,
      modelCalls: lines(calls, 'gate'),
      reviewCalls: lines(calls, 'review'),
      ticketsPerHour: landed && last > first ? Math.round((landed / (last - first)) * 3_600_000) : 0,
      dispatchMs: spread(dispatch),
      gateMs: spread(gate),
      landingMs: spread(landing),
      suiteRunsPerLanded: landed ? Math.round((lines(suiteRuns) / landed) * 100) / 100 : 0,
      unlanded,
    };
  } finally {
    await sched.stop();
    store.close();
  }
}

const { values, json } = options({ tickets: '20', workers: '4', 'suite-ms': '500', 'model-ms': '2000' });
const o = {
  tickets: count('tickets', values.tickets),
  workers: count('workers', values.workers),
  suiteMs: count('suite-ms', values['suite-ms']),
  modelMs: count('model-ms', values['model-ms']),
};
process.env['FOREMAN_PLAYBOOKS_DIR'] = playbooks();
process.env['FOREMAN_CREW_REVIEW'] = 'always';
const results: PipelineResult[] = [];
for (const batch of ['on', 'off'] as const) results.push(await runOnce(batch, o));
if (json) {
  console.log(JSON.stringify(results));
} else {
  console.log(`${o.tickets} tickets, ${o.workers} workers, suite ${o.suiteMs} ms, owner model ${o.modelMs} ms`);
  console.log('gate batch\tlanded\tgate/review calls\ttickets/h\tdispatch p50/p90 ms\tgate p50/p90 ms\tlanding p50/p90 ms\tsuite runs/landed');
  for (const r of results) {
    console.log([
      r.gateBatch, `${r.landed}/${r.tickets}`, `${r.modelCalls}/${r.reviewCalls}`, r.ticketsPerHour, `${r.dispatchMs.p50}/${r.dispatchMs.p90}`,
      `${r.gateMs.p50}/${r.gateMs.p90}`, `${r.landingMs.p50}/${r.landingMs.p90}`, r.suiteRunsPerLanded,
    ].join('\t'));
  }
}
