import fs from 'node:fs';
import path from 'node:path';
import type { Broker } from './budget.ts';
import { extractJson, pickAlias } from './models.ts';
import type { Store } from './queue.ts';
import { rosterAlias } from './bench.ts';
import { CoreChangeRefused, coreRefusal, foremanRoot, isProtectedPath, isSelfTask, PROTECTED_PATHS } from './security/coreGuard.ts';
import { listTools } from './tools/catalog.ts';
import type { Task } from './types.ts';

// The protected list, the self-task test and the path listing live with the
// guard in src/security/coreGuard.ts; they are re-exported for the callers
// that have always imported them from here.
export { CoreChangeRefused, foremanRoot, isSelfTask, PROTECTED_PATHS };

/**
 * Paths a unified diff touches, from its file headers. Reads the `---`/`+++`
 * bodies, the `diff --git a/X b/Y` header, and `rename`/`copy from`/`to` lines
 * — the last two matter because a pure rename (100% similarity) carries NO
 * `---`/`+++` lines, so parsing only those would let a worker relocate a
 * protected file past the guard.
 */
export function pathsInDiff(diff: string): string[] {
  const paths = new Set<string>();
  const add = (p: string | undefined): void => {
    const clean = p?.replace(/^"|"$/g, '').trim();
    if (clean && clean !== 'dev/null' && clean !== '/dev/null') paths.add(clean);
  };
  for (const line of diff.split('\n')) {
    let m = line.match(/^(?:\+\+\+|---) [ab]\/(.+?)\s*$/);
    if (m) { add(m[1]); continue; }
    m = line.match(/^(?:rename|copy) (?:from|to) (.+?)\s*$/);
    if (m) { add(m[1]); continue; }
    m = line.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/);
    if (m) { add(m[1]); add(m[2]); }
  }
  return [...paths];
}

export function protectedViolations(diff: string): string[] {
  return pathsInDiff(diff).filter(isProtectedPath);
}

/**
 * The self-modification check on a diff's TEXT. It reads patch headers, so it
 * sees only what the diff shows and only when the headers carry their a/ b/
 * prefixes: the checks that decide are the run's (scheduler.ts) and the
 * landing's (merge.ts), which both ask git for the paths (coreGuard.ts). This
 * one is run beside the run's check, on the stored diff artifact.
 */
export function assertSelfDiffAllowed(task: Task, diff: string, selfRoot: string = foremanRoot(), isSelf?: boolean): void {
  if (!(isSelf ?? isSelfTask(task, selfRoot)) || task.allowCore) return;
  const refusal = coreRefusal(protectedViolations(diff), false);
  if (refusal) throw new CoreChangeRefused(refusal);
}

export interface Evidence {
  failuresByRunner: Array<{ runner: string; total: number; failed: number }>;
  councilOutcomes: Array<{ verdict: string; n: number }>;
  topErrors: Array<{ message: string; n: number }>;
  rejections: Array<{ title: string; reason: string }>;
  quarantinedTools: string[];
  slowestKinds: Array<{ kind: string; medianMs: number }>;
  limitations: string[];
}

/** What Foreman knows about its own behaviour, from its own ledgers. */
export function gatherEvidence(store: Store): Evidence {
  const rows = <T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] =>
    store.db.prepare(sql).all(...(args as never[])) as T[];

  const failuresByRunner = rows<{ runner: string; total: number; failed: number }>(
    `SELECT runner, COUNT(*) AS total,
            SUM(CASE WHEN status IN ('failed','rejected') THEN 1 ELSE 0 END) AS failed
       FROM tasks GROUP BY runner ORDER BY failed DESC`,
  ).map((r) => ({ runner: String(r.runner), total: Number(r.total), failed: Number(r.failed) }));

  const councilOutcomes = rows<{ verdict: string; n: number }>(
    'SELECT verdict, COUNT(*) AS n FROM verdicts GROUP BY verdict',
  ).map((r) => ({ verdict: String(r.verdict), n: Number(r.n) }));

  const topErrors = rows<{ message: string; n: number }>(
    `SELECT substr(message, 1, 160) AS message, COUNT(*) AS n
       FROM events WHERE type = 'error' GROUP BY substr(message, 1, 60) ORDER BY n DESC LIMIT 8`,
  ).map((r) => ({ message: String(r.message), n: Number(r.n) }));

  const rejections = rows<{ title: string; error: string }>(
    "SELECT title, COALESCE(error, '') AS error FROM tasks WHERE status = 'rejected' ORDER BY updated_at DESC LIMIT 8",
  ).map((r) => ({ title: String(r.title), reason: String(r.error).slice(0, 200) }));

  const slowestKinds = rows<{ kind: string; ms: number }>(
    `SELECT t.kind AS kind, AVG(COALESCE(r.ended_at, 0) - r.started_at) AS ms
       FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.ended_at IS NOT NULL
      GROUP BY t.kind ORDER BY ms DESC LIMIT 5`,
  ).map((r) => ({ kind: String(r.kind), medianMs: Math.round(Number(r.ms)) }));

  return {
    failuresByRunner,
    councilOutcomes,
    topErrors,
    rejections,
    quarantinedTools: listTools().filter((t) => t.quarantined).map((t) => `${t.name}: ${t.quarantineReason ?? ''}`),
    slowestKinds,
    limitations: readLimitations(),
  };
}

/** Foreman's own README is its most honest list of what is wrong with it. */
export function readLimitations(): string[] {
  const file = path.join(foremanRoot(), 'README.md');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const section = text.split(/^##\s+Known limitations\s*$/m)[1];
  if (!section) return [];
  return section
    .split(/^##\s/m)[0]!
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

export interface Proposal {
  title: string;
  area: string;
  rationale: string;
  prompt: string;
  degraded: boolean;
}

const SYSTEM = `You choose ONE improvement to a codebase from evidence about how it behaves.
Reply with JSON only:
{"title":"short imperative title","area":"which part of the system","rationale":"why this is the highest-value fix",
 "prompt":"a complete brief for a worker: what to change, where, and how to prove it"}
Rules:
- Pick exactly one change, the smallest one with the largest payoff.
- It must be verifiable by the project's own test suite; say in the prompt which test to add.
- Never propose changes to security scanning, the approval gate, merge logic, or tool registration.
- Never propose widening any permission, disabling a check, or relaxing a guardrail.
- Prefer a fix the evidence actually supports over a general improvement.`;

export async function proposeImprovement(
  broker: Broker,
  evidence: Evidence,
  opts: { area?: string | null; signal?: AbortSignal } = {},
): Promise<Proposal> {
  const summary = [
    `Task outcomes by runner: ${JSON.stringify(evidence.failuresByRunner)}`,
    `Council verdicts: ${JSON.stringify(evidence.councilOutcomes)}`,
    `Most frequent errors: ${JSON.stringify(evidence.topErrors)}`,
    `Recently rejected work: ${JSON.stringify(evidence.rejections)}`,
    `Quarantined tools: ${JSON.stringify(evidence.quarantinedTools)}`,
    `Slowest task kinds (ms): ${JSON.stringify(evidence.slowestKinds)}`,
    `Documented limitations:\n${evidence.limitations.map((l) => `- ${l}`).join('\n')}`,
  ].join('\n\n');

  const fallback = (reason: string): Proposal => ({
    title: evidence.limitations[0]
      ? `Address: ${evidence.limitations[0].slice(0, 80)}`
      : 'Improve test coverage of the weakest area',
    area: opts.area ?? 'unknown',
    rationale: reason,
    prompt:
      `${evidence.limitations[0] ?? 'Improve the most fragile part of this codebase.'}\n\n` +
      'Make the smallest change that fixes this, and add a test that fails without the fix. ' +
      'Run the existing suite (npm test) and leave it green.',
    degraded: true,
  });

  let alias: string;
  try {
    alias = pickAlias(rosterAlias('reason', ['local-code', 'local-general']), 'S2');
  } catch (err) {
    return fallback(`no local planner available: ${(err as Error).message}`);
  }

  try {
    const res = await broker.call({
      taskId: null, runId: null, kind: 'improve', alias,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${opts.area ? `FOCUS AREA: ${opts.area}\n\n` : ''}EVIDENCE:\n${summary}` },
      ],
      // Foreman's own ledger is private: this reasoning stays on the machine.
      sensitivity: 'S2',
      maxTokens: 900,
      json: true,
      signal: opts.signal,
    });
    const parsed = extractJson<Record<string, unknown>>(res.text);
    const title = String(parsed?.['title'] ?? '').trim();
    const prompt = String(parsed?.['prompt'] ?? '').trim();
    if (!title || !prompt) return fallback('the proposer returned no usable proposal');
    return {
      title: title.slice(0, 120),
      area: String(parsed?.['area'] ?? opts.area ?? 'general').slice(0, 80),
      rationale: String(parsed?.['rationale'] ?? '').slice(0, 800),
      prompt,
      degraded: false,
    };
  } catch (err) {
    return fallback(`proposer unavailable: ${(err as Error).message.slice(0, 200)}`);
  }
}

const GUARDRAIL_BRIEF = [
  '',
  '--- HARD CONSTRAINTS (a change that breaks any of these is refused automatically) ---',
  `Do not modify any of: ${PROTECTED_PATHS.join(', ')}.`,
  'Do not weaken, disable or bypass any existing check, gate or scan.',
  'Do not touch anything under ~/.foreman — that is live operator data, not source.',
  'Keep the change small and self-contained; the full suite (npm test) must pass.',
  'Add a test that fails without your change.',
].join('\n');

export interface QueueImproveOptions {
  allowCore?: boolean;
  budgetUsd?: number | null;
  runner?: Task['runner'];
}

/**
 * Queue a proposal as an ordinary code task against Foreman's own repo: same
 * jail, same test gate, same council, same human gate. It is deliberately the
 * lowest-priority work in the queue and never merges on approval.
 */
export function queueImprovement(store: Store, proposal: Proposal, opts: QueueImproveOptions = {}): Task {
  return store.addTask({
    title: `improve: ${proposal.title}`,
    prompt: `${proposal.prompt}\n${GUARDRAIL_BRIEF}`,
    kind: 'code',
    repo: foremanRoot(),
    runner: opts.runner ?? 'api',
    sensitivity: 'S2',
    // Self-improvement yields to every piece of real work.
    priority: Number(process.env['FOREMAN_IMPROVE_PRIORITY'] ?? -10),
    budgetUsd: opts.budgetUsd ?? Number(process.env['FOREMAN_IMPROVE_BUDGET_USD'] ?? 0.5),
    testCmd: 'npm test',
    // Never auto-merge: a change to Foreman is landed by a human, by hand.
    mergeOnApprove: false,
    allowCore: opts.allowCore ?? false,
    maxRepairs: 1,
  });
}
