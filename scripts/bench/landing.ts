// What landing costs when many approvals arrive at one repo: suite runs per landed ticket, landings per hour,
// approve-to-merged and merged-to-verified p50/p95, and whether a bad last change is named by the red. Each cell is a
// `foreman serve` of this checkout in a temp FOREMAN_HOME on a free loopback port (never ~/.foreman or port 4100),
// driven over its HTTP API by scripts/bench/landingRun.ts. Time is compressed: the 15-minute suite takes --suite-ms.
//   burst   the approvals are sent --burst-gap-ms apart ("20 approvals in one minute")
//   steady  one approval every --steady-gap-ms (100 merges a day at the compression)
//   mr      the burst, landed through the local fake GitLab (scripts/forge/fakeGitlab.ts) whose pipelines pass after --pipeline-ms
// each under `before` (FOREMAN_WORKER_SUITE=full, FOREMAN_POSTMERGE_MODE=per-merge) and `after` (targeted, coalesced).
// Usage: node scripts/bench/landing.ts [--scenarios burst,steady,mr] [--tickets 20] [--suite-ms 900] [--burst-gap-ms 50]
//   [--steady-gap-ms 864] [--pipeline-ms 1500] [--wait-ms 600000] [--out <dir>] [--json]
// Not part of npm run verify (too slow); docs/capacity.md holds the numbers and how to read them.
import { count, options, scratch } from './env.ts';
import { forgeFixture } from './api.ts';
import { startDaemon } from './daemon.ts';
import { runLanding, type LandingPlan, type LandingResult } from './landingRun.ts';
import { redReading } from './outcome.ts';
import { workerCommand } from './worker.ts';
import { startFakeGitlab } from '../forge/fakeGitlab.ts';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENARIOS = ['burst', 'steady', 'mr'] as const;
type Scenario = (typeof SCENARIOS)[number];
const MODES = {
  before: { workerSuite: 'full', postMerge: 'per-merge' },
  after: { workerSuite: 'targeted', postMerge: 'coalesced' },
} as const;
type Mode = keyof typeof MODES;
const PROJECT = 'group/app';

interface Cell extends LandingResult { scenario: Scenario; mode: Mode }

const { values, json } = options({
  scenarios: SCENARIOS.join(','), tickets: '20', 'suite-ms': '900', 'burst-gap-ms': '50', 'steady-gap-ms': '864', 'pipeline-ms': '1500', 'wait-ms': '600000', out: '',
});
const scenarios = values.scenarios.split(',').map((s) => {
  if (!(SCENARIOS as readonly string[]).includes(s)) throw new Error(`--scenarios takes ${SCENARIOS.join(', ')}, got ${JSON.stringify(s)}`);
  return s as Scenario;
});
const tickets = count('tickets', values.tickets);
const suiteMs = count('suite-ms', values['suite-ms']);

async function cell(scenario: Scenario, mode: Mode): Promise<Cell> {
  const { repo, bare } = forgeFixture();
  const token = randomBytes(24).toString('hex');
  const fake = scenario === 'mr'
    ? await startFakeGitlab({ projects: { [PROJECT]: bare }, token, pipeline: 'success', pipelineDelayMs: count('pipeline-ms', values['pipeline-ms']) })
    : null;
  const landing = { [repo]: { mode: 'mr', forge: 'gitlab', baseUrl: fake?.url, project: PROJECT, pushUrl: bare, targetBranch: 'main', requirePipeline: true } };
  const d = await startDaemon(`landing-${scenario}-${mode}`, root, {
    ...(fake ? { files: { 'landing.json': JSON.stringify(landing), 'secrets/gitlab-token': `${token}\n` } } : {}),
    env: {
      FOREMAN_WORKER_SUITE: MODES[mode].workerSuite, FOREMAN_POSTMERGE_MODE: MODES[mode].postMerge,
      ...(fake ? { FOREMAN_LANDING: 'mr', FOREMAN_MR_POLL_MS: '100' } : {}),
    },
  });
  try {
    const dir = scratch(`landing-${scenario}-${mode}`);
    const leasesFile = path.join(dir, 'worker-leases');
    const tmp = scratch('worker-tmp');
    const plan: LandingPlan = {
      tickets, suiteMs, leasesFile, badLast: true,
      approveGapMs: Number(scenario === 'steady' ? values['steady-gap-ms'] : values['burst-gap-ms']),
      prompt: (i) => workerCommand(i, { suite: MODES[mode].workerSuite, port: d.port, tmp, leases: leasesFile, suiteMs }),
      merged: scenario === 'mr' ? /^merged !\d+ at / : /^merge: merged/,
      waitMs: count('wait-ms', values['wait-ms']),
    };
    const result = await runLanding({ url: d.url, repo, scratch: dir }, plan);
    return { scenario, mode, ...result };
  } finally {
    await d.stop();
    await fake?.close();
  }
}

const cells: Cell[] = [];
for (const scenario of scenarios) for (const mode of ['before', 'after'] as const) cells.push(await cell(scenario, mode));
if (values.out) {
  fs.mkdirSync(values.out, { recursive: true });
  fs.writeFileSync(path.join(values.out, 'raw.json'), `${JSON.stringify(cells, null, 2)}\n`);
}
if (json) {
  console.log(JSON.stringify(cells));
} else {
  console.log(`${tickets} tickets, suite ${suiteMs} ms; the last change is bad`);
  console.log('scenario\tmode\tlanded\tsuite runs/landed\tworker leases/landed\tlandings/h\tapprove>merged p50/p95 ms\tmerged>verified p50/p95 ms\tunverified\tred names');
  for (const c of cells) {
    console.log([
      c.scenario, c.mode, `${c.landed}/${c.tickets}`, c.suiteRunsPerLanded, c.workerLeasesPerLanded, c.landingsPerHour,
      `${c.approveToMergedMs.p50}/${c.approveToMergedMs.p95}`, `${c.mergedToVerifiedMs.p50}/${c.mergedToVerifiedMs.p95}`,
      c.unverified, redReading(c.red),
    ].join('\t'));
    if (c.notLanded.length) console.log(`  ${c.notLanded.length} not landed, the first: ${c.notLanded[0]!.why}`);
    for (const e of c.errors) console.log(`  error: ${e}`);
  }
}
