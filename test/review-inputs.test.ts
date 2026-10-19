import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler, type VerifyArgs } from '../src/scheduler.ts';
import { resetPreflightCache } from '../src/runners/cliRunners.ts';
import { createHash } from 'node:crypto';
import { crewReview, heldItems, heldReason, judgedItems, readAcceptance, reportLine } from '../src/verify/crewReview.ts';
import { hardHumanReason, reviewHolds } from '../src/gate.ts';
import { assertionFlag, assertionNote, changedAssertions, type AssertionFinding } from '../src/verify/assertionCheck.ts';
import { CITED_SOURCE_HEADING, citedPaths, citedSourceBlock } from '../src/verify/citedSource.ts';
import { tierModel } from '../src/roles.ts';
import { boundReport, cutMiddle, REPORT_ARTIFACT_MAX, storeReport, storedReport } from '../src/verify/report.ts';
import { config } from '../src/config.ts';
import type { Task } from '../src/types.ts';

/**
 * What a reviewer is given (the worker's report, the source a document cites,
 * Foreman's own checks) and what its reply may pass. Every reviewer here is a
 * stand-in script; no model is called.
 */

const SOLO = `---\n${JSON.stringify({
  id: 'solo',
  description: 'One reviewer, one chair.',
  triggers: ['solo'],
  roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
  reviewers: [{ role: 'senior', style: 'code-review' }],
  escalation: { chair: 'planner', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  constraints: [],
}, null, 2)}\n---\n\n## role: planner\n\nYou chair the crew.\n\n## role: senior\n\nYou review what you did not write.\n\n## role: dev\n\nYou implement the ticket.\n`;

const envelope = (result: string): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result });

export interface Rig {
  store: Store;
  sched: Scheduler;
  repo: string;
  /** What the stand-in worker does in its jail (a shell script) and the final message it ends with. */
  worker(script: string, report: string): void;
  /** The reviewer's reply object for every review call from now on. */
  reviewer(reply: Record<string, unknown>): void;
  /** The whole prompt of each reviewer call so far, oldest first. */
  prompts(): string[];
  /** What the local council stand-in was handed, oldest first. */
  council: VerifyArgs[];
  done(): Promise<void>;
}

/**
 * One `claude` stand-in for both seats. Called with `--output-format
 * stream-json` it is the worker: it runs the script in the jail and ends with
 * the report. Called any other way it is a reviewer: it records its prompt and
 * prints the canned reply.
 */
export function rig(files: Record<string, string> = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-revin-'));
  fs.writeFileSync(path.join(dir, 'solo.md'), SOLO);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `[ "$1" = "--version" ] && { printf '1.2.3\\n'; exit 0; }\n` +
      `worker=0; prev=""\n` +
      `for a in "$@"; do [ "$prev" = "--output-format" ] && [ "$a" = "stream-json" ] && worker=1; prev="$a"; done\n` +
      `if [ $worker = 1 ]; then sh "${dir}/work.sh" >/dev/null 2>&1; cat "${dir}/worker.ndjson"; exit 0; fi\n` +
      `tmp=$(mktemp "${dir}/argv.XXXXXX")\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> "$tmp"; done\n` +
      `printf '<<<END>>>\\n' >> "$tmp"\n` +
      `cat "$tmp" >> "${dir}/review.args"; rm -f "$tmp"\n` +
      `cat "${dir}/review.json"\n`,
  );
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  resetPreflightCache();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-revin-repo-'));
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  for (const [rel, text] of Object.entries({ 'README.md': 'base\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  git('add', '-A');
  git('commit', '-qm', 'base');
  const store = new Store(':memory:');
  const council: VerifyArgs[] = [];
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async (args) => {
      council.push(args);
      return store.addVerdict({
        runId: args.runId, taskId: args.task.id, verdict: 'pass', disagreement: false,
        council: [{ model: 'local-0', provider: 'ollama', local: true, verdict: 'pass', confidence: 0.9, critique: '', costUsd: 0, latencyMs: 5 }],
      });
    },
  });
  const r: Rig = {
    store, sched, repo, council,
    worker: (script, report) => {
      fs.writeFileSync(path.join(dir, 'work.sh'), script);
      fs.writeFileSync(
        path.join(dir, 'worker.ndjson'),
        `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['Edit'] })}\n` +
          `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: report })}\n`,
      );
    },
    reviewer: (reply) => fs.writeFileSync(path.join(dir, 'review.json'), envelope(JSON.stringify(reply))),
    prompts: () =>
      (fs.existsSync(path.join(dir, 'review.args')) ? fs.readFileSync(path.join(dir, 'review.args'), 'utf8') : '')
        .split('<<<END>>>\n')
        .filter((chunk) => chunk.trim()),
    done: async () => {
      await sched.stop();
      store.close();
      delete process.env['FOREMAN_PLAYBOOKS_DIR'];
      delete process.env['FOREMAN_CLAUDE_BIN'];
      delete process.env['FOREMAN_CREW_REVIEW'];
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
  r.reviewer({ verdict: 'pass', critique: 'fine', issues: [] });
  return r;
}

export async function settle(sched: Scheduler, until: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    await sched.tick();
    if (Date.now() > deadline) throw new Error('settle timed out');
    await new Promise((res) => setTimeout(res, 10));
  }
}

export const parked = (r: Rig, id: string) => (): boolean => !['queued', 'running', 'verifying'].includes(r.store.getTask(id)!.status);

export const add = (r: Rig, over: Partial<Task> & { prompt: string }): Task =>
  r.store.addTask({ title: 'ticket', kind: 'code', runner: 'claude-code', repo: r.repo, role: 'dev', playbook: 'solo', ...over } as never);

/** The WORKER'S REPORT block of a review prompt, up to the diff that follows it. */
const reportBlock = (prompt: string): string => {
  const from = prompt.indexOf("WORKER'S REPORT (");
  assert.ok(from >= 0, 'the prompt carries a report block');
  const to = prompt.indexOf('\n\nWORK UNDER REVIEW (diff):', from);
  return prompt.slice(prompt.indexOf('\n', from) + 1, to);
};

// ------------------------------------------------------------------ the worker's report (F39)

/**
 * A report shaped like the trial's technical-writer one (t_b36bf5a477, 13.4 KB): DONE and CHANGED first, a claims
 * table one row per line through the middle, the acceptance map last.
 */
function claimsReport(rows: number): string {
  const table = Array.from({ length: rows }, (_, i) =>
    `- claim ${i + 1}: the cap named LOG_CAP_${i + 1} is enforced | \`src/server.ts\` \`limit${i + 1}\` | read line by line`);
  return [
    'DONE: the Security model section is revised and the session cookie is documented.',
    'CHANGED: README.md',
    '',
    '## Claims',
    ...table.slice(0, Math.floor(rows / 2)),
    '- FOLLOW-UP-SENTINEL: input `-r "my reqs.txt"`, observed path `my`, expected the quoted path, file src/helper/packages.ts',
    ...table.slice(Math.floor(rows / 2)),
    '',
    'ACCEPTANCE MAP',
    '1. (diff) README.md',
    '2. (diff) README.md',
  ].join('\n');
}

test('a 13 KB report reaches the crew reviewer whole, and is stored whole as the run\'s report artifact', async () => {
  const r = rig();
  try {
    const report = claimsReport(135);
    assert.ok(report.length > 13_000 && report.length < config.reviewReportBytes, `a trial-sized report (${report.length})`);
    r.worker("printf '## Security model\\n' >> README.md", report);
    const t = add(r, { prompt: 'Revise the README security section.', acceptance: '1. README.md has one Security model section\n2. README.md documents the cookie' });
    await settle(r.sched, parked(r, t.id));
    assert.equal(r.store.getTask(t.id)!.status, 'awaiting-approval', r.store.getTask(t.id)!.error ?? '');
    assert.equal(r.prompts().length, 1);
    assert.equal(reportBlock(r.prompts()[0]!), report, 'every line of the report, in order, nothing cut');

    const run = r.store.latestRun(t.id)!;
    const artifact = r.store.artifactsForTask(t.id).filter((a) => a.type === 'report' && a.runId === run.id);
    assert.equal(artifact.length, 1, 'one report artifact for the run');
    assert.ok(artifact[0]!.path.startsWith(config.artifactRoot + path.sep), 'inside FOREMAN_HOME/artifacts, beside the diff and the log');
    assert.equal(fs.readFileSync(artifact[0]!.path, 'utf8'), `${report}\n`);
    assert.ok((run.summary ?? '').length < 4200, 'the run row still holds the bounded copy');

    // A re-review reads the stored report, not the run row's copy.
    await r.sched.reverify(t.id);
    assert.equal(r.prompts().length, 2);
    assert.equal(reportBlock(r.prompts()[1]!), report);
  } finally {
    await r.done();
  }
});

test('a report over the budget keeps its head and its tail on whole lines, and the cut names the count and the stored file', async () => {
  const r = rig();
  try {
    const report = claimsReport(400);
    assert.ok(report.length > config.reviewReportBytes * 1.5);
    r.worker("printf '## Security model\\n' >> README.md", report);
    const t = add(r, { prompt: 'Revise the README security section.', acceptance: '1. README.md has one Security model section\n2. README.md documents the cookie' });
    await settle(r.sched, parked(r, t.id));
    const shown = reportBlock(r.prompts()[0]!);
    const artifact = r.store.artifactsForTask(t.id).find((a) => a.type === 'report')!;
    assert.ok(shown.length <= config.reviewReportBytes, `bounded: ${shown.length}`);
    assert.ok(shown.startsWith('DONE: the Security model section is revised'), 'the head survives');
    assert.ok(shown.endsWith('ACCEPTANCE MAP\n1. (diff) README.md\n2. (diff) README.md'), 'the acceptance map survives');

    const lines = shown.split('\n');
    const at = lines.findIndex((l) => l.startsWith('[FOREMAN cut '));
    assert.ok(at > 0, 'one marker, in the middle');
    const original = new Set(report.split('\n'));
    for (const [i, line] of lines.entries()) if (i !== at) assert.ok(original.has(line), `a whole line of the report, never part of one: ${line.slice(0, 60)}`);
    const kept = lines.filter((_, i) => i !== at).join('\n').length;
    const said = Number(/^\[FOREMAN cut (\d+) characters from the middle/.exec(lines[at]!)?.[1]);
    assert.equal(said, report.length - kept, 'the marker counts exactly what was dropped');
    assert.ok(lines[at]!.includes(`The full report is at ${artifact.path}`), lines[at]);
    assert.match(lines[at]!, /"not shown": an acceptance item that depends on it is not verifiable, not met/);
    assert.equal(fs.readFileSync(artifact.path, 'utf8'), `${report}\n`, 'the stored report is whole');
  } finally {
    await r.done();
  }
});

test('cutMiddle: exact count, whole lines only, the marker paid for inside the budget; a short text is returned as it is', () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(i % 37)}`).join('\n');
  for (const budget of [400, 1_000, 2_500, text.length - 1]) {
    const out = cutMiddle(text, budget, (n) => `<<${n} cut>>`);
    assert.ok(out.length <= budget, `${out.length} <= ${budget}`);
    const m = /<<(\d+) cut>>\n/.exec(out)!;
    const head = out.slice(0, m.index);
    const tail = out.slice(m.index + m[0].length);
    assert.ok(text.startsWith(head) && (head === '' || head.endsWith('\n')), 'the head ends on a line break');
    assert.ok(text.endsWith(tail) && (tail === '' || text[text.length - tail.length - 1] === '\n'), 'the tail starts on one');
    assert.equal(Number(m[1]), text.length - head.length - tail.length);
    assert.ok(tail.length >= head.length, 'the end, where the map is, gets the larger share');
  }
  assert.equal(cutMiddle(text, text.length, () => 'never'), text);
  // One line longer than the whole budget cannot be shown in part: it is dropped and counted.
  const giant = `head\n${'y'.repeat(5_000)}\ntail`;
  assert.equal(cutMiddle(giant, 200, (n) => `<<${n} cut>>`), 'head\n<<5001 cut>>\ntail');
});

test('Foreman\'s own note under a long report is never cut with it', () => {
  const report = claimsReport(400);
  const note = 'FOREMAN CHECK: the deterministic pre-review check still reports these gaps:\n4. file not in diff';
  const line = reportLine(report, { reportPath: '/home/artifacts/r_1.report.md', foremanNote: note });
  assert.ok(line.endsWith(`2. (diff) README.md\n\n--- added by Foreman, not the worker ---\n${note}`));
  assert.match(line, /\[FOREMAN cut \d+ characters from the middle of this report here to fit its 24000-character budget/);
  // A short report with a note reads exactly as it did before the report had a budget of its own.
  assert.ok(reportLine('all done', { foremanNote: note }).endsWith(`):\nall done\n\n--- added by Foreman, not the worker ---\n${note}`));
  assert.equal(boundReport('short'), 'short');
});

test('a stored report over the hard cap says so in the file; a re-review reads the stored report, or the run row when there is none', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 't', prompt: 'p', kind: 'code', runner: 'shell' });
    const run = store.startRun(t.id);
    const huge = Array.from({ length: 9_000 }, (_, i) => `row ${i} ${'z'.repeat(40)}`).join('\n');
    assert.ok(huge.length > REPORT_ARTIFACT_MAX);
    const file = storeReport(store, run.id, t.id, huge)!;
    const kept = fs.readFileSync(file, 'utf8');
    assert.ok(kept.length <= REPORT_ARTIFACT_MAX + 1);
    assert.match(kept, /\[FOREMAN cut \d+ characters from the middle of this report here: it was over the 262144-character limit/);
    assert.ok(kept.startsWith('row 0 ') && kept.trimEnd().endsWith(`row 8999 ${'z'.repeat(40)}`));
    assert.deepEqual(storedReport(store, store.getRun(run.id)!), { text: kept.trimEnd(), path: file });

    const other = store.startRun(t.id);
    store.endRun(other.id, 'succeeded', { summary: 'the bounded copy' });
    assert.deepEqual(storedReport(store, store.getRun(other.id)!), { text: 'the bounded copy', path: null });
    assert.equal(storeReport(store, other.id, t.id, '   '), null, 'no report, no artifact');
  } finally {
    store.close();
  }
});

test('with no diff the worker\'s answer is the work under review, and the council is handed it whole', async () => {
  const r = rig();
  delete process.env['FOREMAN_CREW_REVIEW'];
  try {
    const answer = `${Array.from({ length: 90 }, (_, i) => `finding ${i}: ${'detail '.repeat(9)}`).join('\n')}\nMIDDLE-SENTINEL\n${Array.from({ length: 90 }, (_, i) => `source ${i}: ${'cite '.repeat(9)}`).join('\n')}END`;
    assert.ok(answer.length > 9_000);
    r.worker('true', answer);
    const t = r.store.addTask({ title: 'summarise', prompt: 'Summarise the findings.', kind: 'research', runner: 'claude-code' });
    await settle(r.sched, parked(r, t.id));
    assert.equal(r.council.length, 1);
    assert.equal(r.council[0]!.evidence.bodyLabel, 'output');
    assert.equal(r.council[0]!.evidence.body, answer, 'not the 4000-character copy with its middle cut out');
  } finally {
    await r.done();
  }
});

// ------------------------------------------------------------------ the source a document cites (F15)

const numbered = (name: string, n: number): string => Array.from({ length: n }, (_, i) => `// ${name} line ${i + 1}`).join('\n') + '\n';

/** A patch that adds one prose file whose lines are `lines`. */
const proseDiff = (file: string, lines: string[]): string =>
  `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 000..111\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;

/** A committed git tree holding `files`; removed when the test ends. */
function gitTree(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cited-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}

test('a design note reaches the reviewer with the source it cites: the cited line and 40 lines each side, or the head of the file', async () => {
  const r = rig({ 'src/server.ts': numbered('server', 300), 'test/server-lock.test.ts': numbered('lock test', 200), 'src/unrelated.ts': numbered('unrelated', 50), 'src/reported.ts': numbered('reported', 9) });
  try {
    // Shaped like the trial's ADR (t_ba3cf9733a): claims about code that is not in the diff, by file and line.
    const adr = [
      '# 0001: close the server-lock start race',
      'acquireLock re-reads the record at `src/server.ts:120` before it unlinks it.',
      'The ordering is already covered by test/server-lock.test.ts.',
      'The start script is in `package.json`, and the old probe was src/probe/lock-probe.mjs.',
    ];
    r.worker(`mkdir -p docs/decisions && cat > docs/decisions/0001-lock.md <<'DOC'\n${adr.join('\n')}\nDOC`, 'DONE: wrote the ADR; the guard would live in src/reported.ts:3.\n\nACCEPTANCE MAP\n1. (diff) docs/decisions/0001-lock.md');
    const t = add(r, { prompt: 'Write the lock ADR.', acceptance: '1. One new file under docs/decisions/ that is true to the code' });
    await settle(r.sched, parked(r, t.id));
    assert.equal(r.store.getTask(t.id)!.status, 'awaiting-approval', r.store.getTask(t.id)!.error ?? '');
    const prompt = r.prompts()[0]!;
    const at = prompt.indexOf(CITED_SOURCE_HEADING);
    assert.ok(at > 0, 'the labelled block is in the prompt');
    const block = prompt.slice(at, prompt.indexOf("\n\nWORKER'S REPORT ("));
    assert.match(block, /^--- src\/server\.ts \(lines 80-160 of 300\) ---$/m);
    assert.match(block, /^120\| \/\/ server line 120$/m, "numbered by the file's own lines");
    assert.match(block, /^ 80\| \/\/ server line 80$/m);
    assert.match(block, /^160\| \/\/ server line 160$/m);
    assert.doesNotMatch(block, /server line 79$|server line 161$/m, 'forty lines each side, no more');
    assert.match(block, /^--- test\/server-lock\.test\.ts \(lines 1-80 of 200; no line or name in it was cited, so this is the head of the file\) ---$/m);
    assert.match(block, /^ 80\| \/\/ lock test line 80$/m);
    assert.doesNotMatch(block, /lock test line 81$/m);
    assert.doesNotMatch(block, /unrelated line/, 'only what the document cites');
    assert.match(block, /^--- src\/reported\.ts \(lines 1-9 of 9\) ---$/m, "and what the worker's report cites");
    assert.match(block, /^CITED BUT NOT READ \([^)]*\): src\/probe\/lock-probe\.mjs$/m, 'a cited path that is not there is named');
    assert.ok(!block.includes('package.json'), 'a bare name that is no file of the tree is not taken for a citation');
    assert.match(prompt, /FILES ALREADY TRACKED IN THIS TREE \(6\):/, 'the tracked-files list stays');
    assert.ok(prompt.indexOf('FILES ALREADY TRACKED') < at && at < prompt.indexOf('WORK UNDER REVIEW (diff)'));
  } finally {
    await r.done();
  }
});

test('a code-only diff gets no cited-source block, even when its code names other files', async () => {
  const r = rig({ 'src/server.ts': numbered('server', 30), 'src/auth.ts': 'export const a = 1;\n' });
  try {
    r.worker("printf '// see src/server.ts:12 and `README.md`\\n' >> src/auth.ts", 'DONE.\n\nACCEPTANCE MAP\n1. (diff) src/auth.ts');
    const t = add(r, { prompt: 'Note the server in auth.', acceptance: '1. src/auth.ts points at the server' });
    await settle(r.sched, parked(r, t.id));
    assert.equal(r.prompts().length, 1);
    assert.ok(!r.prompts()[0]!.includes('SOURCE THE DOCUMENT CITES'));
    assert.ok(!r.prompts()[0]!.includes('server line 12'));
  } finally {
    await r.done();
  }
});

test('citedPaths: slashed paths anywhere, root files only in backticks, line forms, no URL and no path out of the tree', () => {
  const text = [
    'See `src/x.ts`, src/y.ts:123, `test/y.test.ts:10-20`, src/z.ts#L5-L9 and docs/a.md lines 3 to 7.',
    'Root files: `package.json`, `README.md:12`; but README.md and tsconfig.json in running text are words.',
    'Not paths: https://example.com/a/b.html, ../outside/secret.ts, ~/.foreman/foreman.db, version 1.2 and/or e.g. this.',
    'Again src/y.ts:400.',
  ].join('\n');
  assert.deepEqual(citedPaths(text), [
    { path: 'src/x.ts', ranges: [], symbols: [], bare: false },
    { path: 'src/y.ts', ranges: [[123, 123], [400, 400]], symbols: [], bare: false },
    { path: 'test/y.test.ts', ranges: [[10, 20]], symbols: [], bare: false },
    { path: 'src/z.ts', ranges: [[5, 9]], symbols: [], bare: false },
    { path: 'docs/a.md', ranges: [[3, 7]], symbols: [], bare: false },
    { path: 'package.json', ranges: [], symbols: [], bare: true },
    { path: 'README.md', ranges: [[12, 12]], symbols: [], bare: true },
  ]);
  // A line no prose has (200 KB of path-like text with no end) is not scanned at all, and costs nothing.
  const started = Date.now();
  assert.deepEqual(citedPaths(`x/${'1.'.repeat(100_000)} src/a.ts\nreal one: src/b.ts`), [{ path: 'src/b.ts', ranges: [], symbols: [], bare: false }]);
  assert.ok(Date.now() - started < 5_000);
  // A name given in backticks on the line that cites a file is looked for in that file.
  assert.deepEqual(citedPaths('- the cookie is set in `src/server.ts` `serveStatic` with `tokenEquals()`'), [
    { path: 'src/server.ts', ranges: [], symbols: ['serveStatic', 'tokenEquals'], bare: false },
  ]);
});

test('cited source is read as regular files inside the tree only: a FIFO, a link, an ignored file and an oversized file are named, not read', (t) => {
  const outside = gitTree(t, { 'secret.ts': 'OUTSIDE-SECRET\n' });
  const dir = gitTree(t, { 'src/ok.ts': 'export const ok = 1;\n', '.gitignore': 'private/\n' });
  fs.mkdirSync(path.join(dir, 'private'));
  fs.writeFileSync(path.join(dir, 'private/keys.ts'), 'IGNORED-SECRET\n');
  execFileSync('mkfifo', [path.join(dir, 'src/fifo.ts')]);
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(dir, 'src/link.ts'));
  fs.symlinkSync(outside, path.join(dir, 'linked'));
  fs.symlinkSync('/dev/zero', path.join(dir, 'src/zero.ts'));
  fs.writeFileSync(path.join(dir, 'src/big.ts'), 'x'.repeat(1024 * 1024 + 1));
  execFileSync('git', ['add', '-A', '-N'], { cwd: dir, stdio: 'ignore' }); // as diffJail leaves the index
  const doc = proseDiff('docs/note.md', ['Reads src/ok.ts, src/fifo.ts, src/link.ts, linked/secret.ts, src/zero.ts, src/big.ts, private/keys.ts and ../x/y.ts.']);
  const started = Date.now();
  const block = citedSourceBlock(doc, dir);
  assert.ok(Date.now() - started < 20_000, 'a FIFO or a device under a cited name does not hold the daemon');
  assert.match(block, /^--- src\/ok\.ts \(lines 1 of 1; no line or name in it was cited, so this is the head of the file\) ---\n1\| export const ok = 1;$/m);
  assert.doesNotMatch(block, /OUTSIDE-SECRET|IGNORED-SECRET|xxxxxxxx/);
  assert.match(block, /^CITED BUT NOT READ \([^)]*\): src\/fifo\.ts, src\/link\.ts, linked\/secret\.ts, src\/zero\.ts, src\/big\.ts, private\/keys\.ts$/m);
});

test('the cited-source block stays inside its budget and names every file it left out', (t) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 12; i++) files[`src/m${i}.ts`] = numbered(`m${i}`, 400);
  const dir = gitTree(t, files);
  const doc = proseDiff('README.md', Object.keys(files).map((f, i) => `Module ${i} is ${f}:${100 + i}.`));
  for (const budget of [3_000, 8_000, 20_000]) {
    const block = citedSourceBlock(doc, dir, null, budget);
    assert.ok(block.length <= budget, `${block.length} <= ${budget}`);
    const shown = [...block.matchAll(/^--- (src\/m\d+\.ts) \(/gm)].map((m) => m[1]!);
    const leftOut = /^NOT SHOWN, over this block's \d+-character budget \(FOREMAN_CITED_SOURCE_BYTES\): (.*)$/m.exec(block)?.[1]?.split(', ') ?? [];
    if (budget >= 8_000) assert.ok(shown.length >= 1, `something is shown at ${budget}`);
    assert.deepEqual([...shown, ...leftOut].sort(), Object.keys(files).sort(), `every cited file is shown or named at ${budget}`);
  }
  // The default budget holds all twelve windows (81 lines each).
  const whole = citedSourceBlock(doc, dir);
  assert.equal([...whole.matchAll(/^--- src\/m\d+\.ts \(lines \d+-\d+ of 400\) ---$/gm)].length, 12);
  assert.ok(!whole.includes('NOT SHOWN'));
  // No prose in the diff, or prose that cites nothing readable: no block at all.
  assert.equal(citedSourceBlock(proseDiff('src/a.ts', ['// src/m0.ts:5']), dir), '');
  assert.equal(citedSourceBlock(proseDiff('README.md', ['Nothing cited here.']), dir), '');
});

test('a README-only ticket: the files and names the worker\'s report maps its claims to are shown, and a base name finds its file', (t) => {
  // Shaped like t_b36bf5a477: the README states behaviour, and the report's claims table names the file and function.
  const server = Array.from({ length: 400 }, (_, i) => (i === 249 ? 'function serveStatic(req) {' : i === 251 ? '  const fresh = tokenEquals(supplied, token);' : `// server line ${i + 1}`)).join('\n') + '\n';
  const trust = Array.from({ length: 300 }, (_, i) => (i === 149 ? 'export const INCLUDE_DEPTH = 5;' : `// trust line ${i + 1}`)).join('\n') + '\n';
  const dir = gitTree(t, { 'src/server.ts': server, 'src/trust.ts': trust, 'src/paths.ts': numbered('paths', 20), 'src/fileops.ts': numbered('fileops', 10) });
  const readme = proseDiff('README.md', ['## Security model', 'The session cookie is set when the page is served with the right token.', 'State lives where `paths.ts` puts it; `fs.promises` does the reads.']);
  const report = [
    'DONE: revised the Security model section.',
    '## Claims',
    '- Cookie set on GET / with the right token | `src/server.ts` `serveStatic`',
    '- Includes are followed 5 levels deep | `src/trust.ts` `INCLUDE_DEPTH`',
    '- By-name moves are not confined | `src/fileops.ts` `moveNoReplace`',
  ].join('\n');
  const block = citedSourceBlock(readme, dir, report);
  assert.match(block, /^--- src\/server\.ts \(lines 238-262 of 400\) ---$/m, 'twelve lines each side of the line that holds the name');
  assert.match(block, /^250\| function serveStatic\(req\) \{$/m);
  assert.match(block, /^--- src\/trust\.ts \(lines 138-162 of 300\) ---$/m);
  assert.match(block, /^150\| export const INCLUDE_DEPTH = 5;$/m);
  assert.match(block, /^--- src\/paths\.ts \(lines 1-20 of 20; no line or name in it was cited, so this is the head of the file\) ---$/m, '`paths.ts` is the one file of that base name');
  assert.match(block, /^--- src\/fileops\.ts \(lines 1-10 of 10; no line or name in it was cited, so this is the head of the file\) ---$/m, 'a name the file does not hold: its head');
  assert.ok(!block.includes('fs.promises'), 'a backticked name that is no file of the tree is not a citation');
  // Without the report only the README's own citation is there.
  const alone = citedSourceBlock(readme, dir);
  assert.ok(alone.includes('--- src/paths.ts (') && !alone.includes('--- src/server.ts ('));
});

test('a review cached before the prompt gained these blocks is not replayed', async () => {
  const r = rig();
  try {
    const t = add(r, { prompt: 'p', acceptance: 'unnumbered acceptance' });
    const runId = r.store.startRun(t.id).id;
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n a\n+b\n';
    // The first call is made and cached under today's key.
    assert.equal((await crewReview({ task: r.store.getTask(t.id)!, runId, store: r.store, diff, council: null }))?.verdict, 'pass');
    const prompt = r.prompts()[0]!.split('\n').slice(r.prompts()[0]!.split('\n').indexOf('-p') + 1).join('\n');
    const sent = prompt.slice(0, prompt.indexOf('\n--output-format\n'));
    // The same prompt under the previous version's key holds a FAIL: it must not be what the next review returns.
    const oldKey = createHash('sha256').update([3, tierModel('senior'), sent].join('\u0000')).digest('hex');
    r.store.db.prepare('DELETE FROM crew_review_cache').run();
    r.store.putCachedReview(oldKey, tierModel('senior'), { verdict: 'fail', critique: 'a verdict on the old prompt', issuesJson: '[]' });
    const again = await crewReview({ task: r.store.getTask(t.id)!, runId, store: r.store, diff, council: null });
    assert.equal(again?.verdict, 'pass');
    assert.equal(r.prompts().length, 2, 'the reviewer was asked again');
  } finally {
    await r.done();
  }
});

// ------------------------------------------------------------------ "could not check" must not pass (F15, F9, F18)

const CODE_DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n a\n+b\n';

// The README security ticket's acceptance and its passing verdict, as the trial's ledger holds them (t_b36bf5a477,
// v_10db4e5a9c). The reviewer passed it while writing, item by item, what it had not been able to check.
const README_ACCEPTANCE =
  '1. README has exactly one Security model section, covering project confinement, the trust prompt, the session token and cookie, output caps, fixed-argv fixes and install offers. ' +
  "2. It states what Kiln does not defend, including that a program the user runs has the user's own access. " +
  '3. The session cookie is documented where the token is documented (Serve section), with attributes matching the code. ' +
  '4. The report maps every claim to a source file and function, and reviewer spot-checks find no claim the code does not keep. 5. No source file changed; `npm run verify` passes.';
const README_PASS_CRITIQUE =
  "REVIEWED: README.md (the only file in the diff); truncated: diff no, worker's report yes. The report as shown to me starts mid-row and has a 9434-character cut in the middle. " +
  'I had no access to the kiln source, so no README claim was spot-checked against code.\n\n' +
  'ACCEPTANCE: 1 met | 2 met | 3 met on its face, attributes not checked against source | 4 met as far as shown, spot-checks not run | 5 met (diff touches only README.md; Foreman\'s gate passed)';
/** That verdict's ACCEPTANCE line as the status field the reviewer is now asked for. */
const README_STATUS = [
  { item: 1, status: 'met', note: '' },
  { item: 2, status: 'met', note: '' },
  { item: 3, status: 'not-verifiable', note: 'cookie attributes not checked against source: src/server.ts was not shown' },
  { item: 4, status: 'not-verifiable', note: 'the cut part of the report holds the rows for token, Host/Origin, confinement and caps' },
  { item: 5, status: 'met', note: '' },
];

const crewTicket = (r: Rig, acceptance: string | null): { task: Task; runId: string } => {
  const t = add(r, { prompt: 'p', acceptance });
  return { task: r.store.getTask(t.id)!, runId: r.store.startRun(t.id).id };
};

test('the reviewer is told to give a status per numbered item; operator items, and a gate item the gate already proved, are not asked for', async () => {
  const r = rig();
  try {
    const acceptance = '1. the handler returns 200\n2. the page looks right (operator)\n3. reviewed by eye (review)\n4. npm run verify passes.';
    assert.deepEqual(judgedItems({ acceptance }), [1, 3, 4]);
    assert.deepEqual(judgedItems({ acceptance }, { ran: true, passed: true, cmd: 'npm run verify' }), [1, 3]);
    assert.deepEqual(judgedItems({ acceptance }, { ran: true, passed: false, cmd: 'npm run verify' }), [1, 3, 4], 'a gate that did not pass proves nothing');
    assert.deepEqual(judgedItems({ acceptance: 'requests without a token get 401' }), []);

    const { task, runId } = crewTicket(r, acceptance);
    await crewReview({ task, runId, store: r.store, diff: CODE_DIFF, council: null, tests: { ran: true, passed: true, cmd: 'npm run verify' } });
    const prompt = r.prompts()[0]!;
    assert.match(prompt, /ACCEPTANCE STATUS — required\. Add a field "acceptance" to your JSON reply with one entry for each of these numbered acceptance items: 1, 3\.\n/);
    assert.match(prompt, /"status":"met"\|"partial"\|"missing"\|"not-verifiable"/);
    assert.ok(prompt.indexOf('ACCEPTANCE CRITERIA:') < prompt.indexOf('ACCEPTANCE STATUS') && prompt.indexOf('ACCEPTANCE STATUS') < prompt.indexOf('WORK UNDER REVIEW'));
  } finally {
    await r.done();
  }
});

test('readAcceptance: one entry per judged item; a missing entry or an unknown word is unreported, never met', () => {
  const raw = [
    { item: 1, status: 'Met', note: 'ok' },
    { item: 2, status: 'not verifiable', note: 'source not shown' },
    { n: 3, status: 'PARTIAL' },
    { item: 4, status: 'met as far as shown' },
    { item: 5, status: 'not met' },
    { item: 1, status: 'missing', note: 'a second entry for one item is ignored' },
    'junk', null, { status: 'met' },
  ];
  assert.deepEqual(readAcceptance(raw, [1, 2, 3, 4, 5, 6]), [
    { item: 1, status: 'met', note: 'ok' },
    { item: 2, status: 'not-verifiable', note: 'source not shown' },
    { item: 3, status: 'partial', note: '' },
    { item: 4, status: 'unreported', note: '' },
    { item: 5, status: 'missing', note: '' },
    { item: 6, status: 'unreported', note: '' },
  ]);
  assert.deepEqual(readAcceptance(undefined, [1]), [{ item: 1, status: 'unreported', note: '' }]);
  assert.deepEqual(readAcceptance('met', []), []);
});

test('a pass whose own status list has a partial or missing item is recorded as FAIL, with a FOREMAN CHECK line naming the item', async () => {
  const r = rig();
  try {
    // t_92036a5aae's first review wrote "3 partial (see finding 1)" — and failed it. The same list under a PASS:
    r.reviewer({
      verdict: 'pass', critique: 'ACCEPTANCE: 1 met | 2 met | 3 partial (see finding 1) | 4 met', issues: [],
      acceptance: [
        { item: 1, status: 'met' }, { item: 2, status: 'met' },
        { item: 3, status: 'partial', note: 'a non-tip card that is not a compile error also jumps ahead of the Setup card' },
        { item: 4, status: 'met' },
      ],
    });
    const { task, runId } = crewTicket(r, '1. the error card leads\n2. the tool card is still shown\n3. with no compile error the order is exactly what it is today\n4. the report says how the fixture was obtained');
    const out = await crewReview({ task, runId, store: r.store, diff: CODE_DIFF, council: null });
    assert.equal(out?.verdict, 'fail');
    assert.equal(out?.record.verdict, 'fail');
    assert.match(out!.critique, /FOREMAN CHECK \(deterministic\): this review said PASS, but its own acceptance status has item 3 partial\./);
    assert.match(out!.critique, /- item 3 \(partial\): a non-tip card that is not a compile error also jumps ahead of the Setup card/);
    assert.equal(heldItems(out!.record).length, 0, 'nothing here is for a person: the worker can act on it');
    assert.deepEqual(out!.record.council[0]!.acceptance?.map((e) => e.status), ['met', 'met', 'partial', 'met'], 'the status list is on the verdict row');
  } finally {
    await r.done();
  }
});

test('trial t_b36bf5a477: "met as far as shown, spot-checks not run" under a PASS is not a pass and not a repair round — it parks for a person, and the owner gate holds it', async () => {
  const r = rig();
  try {
    r.reviewer({ verdict: 'pass', critique: README_PASS_CRITIQUE, issues: [], acceptance: README_STATUS });
    r.worker("printf '## Security model\\n' >> README.md", 'DONE.\n\nACCEPTANCE MAP\n1. (diff) README.md\n2. (diff) README.md\n3. (diff) README.md\n4. (diff) README.md\n5. (diff) README.md');
    const t = add(r, { prompt: 'Revise the README security section.', acceptance: README_ACCEPTANCE, gate: 'owner' } as never);
    await settle(r.sched, parked(r, t.id));
    const task = r.store.getTask(t.id)!;
    const run = r.store.latestRun(t.id)!;
    assert.equal(task.status, 'awaiting-approval', task.error ?? '');
    assert.equal(task.repairs, 0, 'no repair round was spent: the worker cannot fix what the reviewer was not shown');
    assert.equal(r.prompts().length, 1, 'one review, and no owner-gate call after it');
    assert.equal(run.verdict, 'split', 'not a pass');
    assert.match(task.error ?? '', /the reviewer could not verify acceptance items 3, 4 \(cookie attributes not checked against source: src\/server\.ts was not shown\) — a person decides/);

    const verdict = r.store.verdictsForTask(t.id)[0]!;
    assert.equal(verdict.source, 'crew');
    assert.deepEqual(heldItems(verdict).map((e) => [e.item, e.status]), [[3, 'not-verifiable'], [4, 'not-verifiable']]);
    assert.match(verdict.critique ?? '', /FOREMAN CHECK \(deterministic\): the review found nothing to fail, but could not verify acceptance items 3, 4/);
    assert.match(hardHumanReason(task, run, reviewHolds(r.store, t.id)) ?? '', /review verdict was 'split'/);

    // A later verdict on the same run that says pass (a council re-review, which has no status list) does not lift
    // the hold: it is keyed on what the crew reviewer recorded, not on the newest verdict or on any text.
    r.store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'pass', disagreement: false, council: [{ model: 'local-0', provider: 'ollama', local: true, verdict: 'pass', confidence: 0.9, critique: '', costUsd: 0, latencyMs: 5 }] });
    r.store.setTestsPassed(run.id, true);
    const after = r.store.latestRun(t.id)!;
    assert.equal(after.verdict, 'pass');
    const holds = reviewHolds(r.store, t.id);
    assert.match(holds.unverified ?? '', /could not verify acceptance items 3, 4/);
    assert.match(hardHumanReason({ ...task, error: null }, after, holds) ?? '', /the reviewer could not verify acceptance items 3, 4 .* a person decides/);
    assert.equal(hardHumanReason({ ...task, error: null }, after, { ...holds, unverified: null }), null, 'control: with nothing unverified this ticket is the owner gate\'s to decide');
  } finally {
    await r.done();
  }
});

test('a reply that omits the status field on a ticket with numbered acceptance is held for a person; a FAIL without it is still a FAIL', async () => {
  const r = rig();
  try {
    // The reply shape every reviewer gave before the field existed.
    r.reviewer({ verdict: 'pass', critique: 'reads fine', issues: [] });
    const first = crewTicket(r, '1. the handler returns 200\n2. the handler logs the request');
    const held = await crewReview({ ...first, store: r.store, diff: CODE_DIFF, council: null });
    assert.equal(held?.verdict, 'split');
    assert.deepEqual(heldItems(held!.record).map((e) => [e.item, e.status]), [[1, 'unreported'], [2, 'unreported']]);
    assert.match(held!.critique, /- item 1 \(no status given\)/);

    r.reviewer({ verdict: 'fail', critique: 'the handler returns 500', issues: [] });
    const second = crewTicket(r, '1. the handler returns 201\n2. the handler logs the request');
    const failed = await crewReview({ ...second, store: r.store, diff: CODE_DIFF, council: null });
    assert.equal(failed?.verdict, 'fail');
    assert.doesNotMatch(failed!.critique, /FOREMAN CHECK/);
  } finally {
    await r.done();
  }
});

test('all items met passes; an operator item needs no status; a gate item the gate proved is not held against the reply', async () => {
  const r = rig();
  try {
    r.reviewer({ verdict: 'pass', critique: 'ACCEPTANCE: 1 met', issues: [], acceptance: [{ item: 1, status: 'met', note: 'asserted in the new test' }, { item: 3, status: 'missing', note: 'I cannot confirm npm run verify passes' }] });
    const { task, runId } = crewTicket(r, '1. the handler returns 200\n2. the page looks right (operator)\n3. npm run verify passes.');
    const out = await crewReview({ task, runId, store: r.store, diff: CODE_DIFF, council: null, tests: { ran: true, passed: true, cmd: 'npm run verify' } });
    assert.equal(out?.verdict, 'pass');
    assert.deepEqual(out!.record.council[0]!.acceptance, [{ item: 1, status: 'met', note: 'asserted in the new test' }]);
    assert.equal(heldReason(out!.record), null);
    assert.equal(reviewHolds(r.store, task.id).unverified, null);
  } finally {
    await r.done();
  }
});

test('a cached reply is held to its status list on every replay, and a chair cannot turn an unverified item into a pass', async () => {
  const r = rig();
  try {
    r.reviewer({ verdict: 'pass', critique: 'fine as far as shown', issues: [], acceptance: [{ item: 1, status: 'not-verifiable', note: 'src/server.ts was not shown' }] });
    const { task, runId } = crewTicket(r, '1. the ADR is true to the code\n2. the page looks right (operator)');
    const first = await crewReview({ task, runId, store: r.store, diff: CODE_DIFF, council: null });
    assert.equal(first?.verdict, 'split');
    const replay = await crewReview({ task, runId, store: r.store, diff: CODE_DIFF, council: null });
    assert.equal(r.prompts().length, 1, 'the second review came from the cache');
    assert.equal(replay?.verdict, 'split');
    assert.deepEqual(heldItems(replay!.record), [{ item: 1, status: 'not-verifiable', note: 'src/server.ts was not shown' }]);

    // A local council that FAILED the work disagrees with the crew's pass, so the chair is called. Whatever it
    // answers (the stand-in answers "pass" to every call), the item is still unverified and the row is not a pass.
    const fail = r.store.addVerdict({
      runId, taskId: task.id, verdict: 'fail', disagreement: false, critique: 'the local council disliked it',
      council: [0, 1].map((i) => ({ model: `local-${i}`, provider: 'ollama', local: true, verdict: 'fail' as const, confidence: 0.9, critique: 'no', costUsd: 0, latencyMs: 5 })),
    });
    const chaired = await crewReview({ task, runId, store: r.store, diff: CODE_DIFF, council: fail });
    assert.equal(r.prompts().length, 2, 'the chair was asked');
    assert.equal(chaired?.chair?.verdict, 'pass');
    assert.equal(chaired?.verdict, 'split');
    assert.equal(chaired?.record.verdict, 'split');
  } finally {
    await r.done();
  }
});

test('review paths with no status list are untouched: an unnumbered ticket, a verdict row from before the field, the local council', async () => {
  const r = rig();
  try {
    // No numbered item: nothing is asked for, and the old reply shape passes as it always did.
    const plain = crewTicket(r, 'requests without a token get 401');
    const out = await crewReview({ ...plain, store: r.store, diff: CODE_DIFF, council: null });
    assert.equal(out?.verdict, 'pass');
    assert.ok(!r.prompts()[0]!.includes('ACCEPTANCE STATUS'));
    assert.equal(out!.record.council[0]!.acceptance, undefined);
    const cachedAs = r.store.db.prepare('SELECT issues_json FROM crew_review_cache').get() as { issues_json: string };
    assert.equal(cachedAs.issues_json, '[]', 'the cache row keeps the plain list it has always held');

    // A crew verdict written before the field existed: numbered acceptance, a pass, no status list on the row.
    const old = crewTicket(r, '1. the handler returns 200');
    const row = r.store.addVerdict({
      runId: old.runId, taskId: old.task.id, verdict: 'pass', disagreement: false, source: 'crew',
      council: [{ model: 'opus', provider: 'claude-cli', local: false, verdict: 'pass', confidence: 1, critique: 'Not checked: the route wiring.', costUsd: 0, latencyMs: 0, role: 'senior', style: 'code-review' }],
    });
    assert.deepEqual(heldItems(row), []);
    assert.equal(reviewHolds(r.store, old.task.id).unverified, null, 'no hold is invented for it, whatever its prose says');

    // The local council alone (no playbook): its verdict parks as before.
    r.worker("printf 'x\\n' >> README.md", 'done');
    const solo = r.store.addTask({ title: 'no crew', prompt: 'p', kind: 'code', runner: 'claude-code', repo: r.repo, acceptance: '1. README.md says x' });
    await settle(r.sched, parked(r, solo.id));
    assert.equal(r.store.getTask(solo.id)!.status, 'awaiting-approval');
    assert.equal(r.store.latestRun(solo.id)!.verdict, 'pass');
    assert.equal(r.store.getTask(solo.id)!.error, null);
    assert.equal(reviewHolds(r.store, solo.id).unverified, null);
  } finally {
    await r.done();
  }
});

// ------------------------------------------------------------------ pre-existing assertions a diff removed or changed (F35)

/**
 * Kiln's test/preview.test.ts before t_694071e43e touched it (lines 215-239 at 5216217^, read from Kiln's history),
 * and the one line the worker changed to get its suite unstuck: the saved record was checked whole, then only its
 * `steps` (the line as the reviewer quoted it in v_bb285d6148, finding 1).
 */
const PREVIEW_BEFORE = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  '',
  "test('a web run serves index.html in-process: no node on PATH, no child process, and a record without pid, CPU or peak', async () => {",
  '  const root = site();',
  '  const oldPath = process.env.PATH;',
  "  process.env.PATH = '/nonexistent'; // a spawned `node` could not be found; the in-process server needs nothing from PATH",
  '  try {',
  "    const { ex, record } = await runWeb('web-inproc', root);",
  "    assert.equal(record.status, 'pass', JSON.stringify(record));",
  '    assert.equal(record.probe?.ok, true);',
  '    assert.equal(record.appAlive, true);',
  '    const page = await get(record.previewUrl as string);',
  '    assert.equal(page.status, 200);',
  '    assert.match(page.body, /<h1>hi<\\/h1>/);',
  '',
  "    const launch = record.steps.find((s) => s.id === 'launch');",
  "    assert.equal(launch?.status, 'pass');",
  '    assert.equal(launch?.measure, undefined);',
  '    assert.equal(launch?.tty, undefined);',
  "    const saved = fs.readFileSync(recordFile('web-inproc', record.runId), 'utf8');",
  '    assert.doesNotMatch(saved, /pid|cpuMs|peakBytes|wallMs|n\\/a/i);',
  "    assert.equal(await ex.stop('web-inproc'), true);",
  '  } finally {',
  '    process.env.PATH = oldPath;',
  '  }',
  '});',
  '',
].join('\n');
const SAVED_WHOLE = "    const saved = fs.readFileSync(recordFile('web-inproc', record.runId), 'utf8');";
const SAVED_STEPS = "    const saved = JSON.stringify(JSON.parse(fs.readFileSync(recordFile('web-inproc', record.runId), 'utf8')).steps);";
const PREVIEW_NARROWED = PREVIEW_BEFORE.replace(SAVED_WHOLE, SAVED_STEPS);

/** The patch git prints for going from `before` to `after` in a real repository, taken the way a jail's diff is. */
function gitDiff(t: { after: (fn: () => void) => void }, before: Record<string, string>, after: Record<string, string>, flags: string[] = []): string {
  const dir = gitTree(t, before);
  for (const rel of Object.keys(before)) if (!(rel in after)) fs.rmSync(path.join(dir, rel));
  for (const [rel, text] of Object.entries(after)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  execFileSync('git', ['add', '-A', '-N'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['diff', '--no-color', '--no-ext-diff', ...flags, 'HEAD'], { cwd: dir, encoding: 'utf8' });
}

const kinds = (f: AssertionFinding[]): Array<[string, number, string]> => f.map((x) => [x.kind, x.line, x.file]);

test('the real preview.test.ts change: the value a pre-existing assertion checks was narrowed from the whole record to its steps, and that is listed', (t) => {
  const diff = gitDiff(t, { 'test/preview.test.ts': PREVIEW_BEFORE, 'src/executor.ts': 'export const a = 1;\n' }, { 'test/preview.test.ts': PREVIEW_NARROWED, 'src/executor.ts': 'export const a = 2;\n' });
  const found = changedAssertions(diff);
  assert.deepEqual(found, [{
    file: 'test/preview.test.ts', line: 21, kind: 'asserted-value',
    old: SAVED_WHOLE.trim(), new: SAVED_STEPS.trim(),
    detail: 'assert.doesNotMatch(saved, /pid|cpuMs|peakBytes|wallMs|n\\/a/i);',
  }]);
  assert.equal(assertionFlag(found), 'the diff changes pre-existing assertions: 1 in test/preview.test.ts');
  const note = assertionNote(found);
  assert.match(note, /^FOREMAN CHECK \(deterministic\): pre-existing assertions this diff removed or changed — each needs a reason the ticket gives; a narrowed assertion with no such reason is a blocker\./);
  assert.ok(note.includes(`- test/preview.test.ts:21 — the value an assertion checks was redefined\n    was: ${SAVED_WHOLE.trim()}\n    now: ${SAVED_STEPS.trim()}\n    checked by: assert.doesNotMatch(saved,`));

  // The version that landed after review (everything but `owner`) redefines the same value: also a person's call.
  const landed = PREVIEW_BEFORE.replace(SAVED_WHOLE, "    const { owner: _owner, ...rest } = JSON.parse(fs.readFileSync(recordFile('web-inproc', record.runId), 'utf8'));\n    const saved = JSON.stringify(rest, null, 2);");
  assert.deepEqual(kinds(changedAssertions(gitDiff(t, { 'test/preview.test.ts': PREVIEW_BEFORE }, { 'test/preview.test.ts': landed }))), [['asserted-value', 21, 'test/preview.test.ts']]);
});

test('an assertion removed or changed is listed with its old and new text; an added one, and anything in a new test file, is not', (t) => {
  const before = { 'test/a.test.ts': PREVIEW_BEFORE, 'src/x.ts': "assert.ok(1);\nexport const x = 1;\n" };
  const changed = PREVIEW_BEFORE
    .replace("    assert.equal(record.status, 'pass', JSON.stringify(record));\n", "    assert.ok(record.status);\n")
    .replace('    assert.equal(record.appAlive, true);\n', '')
    .replace('    assert.equal(page.status, 200);\n', '    assert.equal(page.status, 200);\n    assert.equal(page.headers.etag, undefined);\n');
  const diff = gitDiff(t, before, {
    'test/a.test.ts': changed,
    'test/new.test.ts': "test('new', () => { assert.equal(1, 1); });\ntest.skip('later', () => {});\n",
    'src/x.ts': 'export const x = 1;\n',
  });
  assert.deepEqual(changedAssertions(diff), [
    { file: 'test/a.test.ts', line: 10, kind: 'assertion', old: "assert.equal(record.status, 'pass', JSON.stringify(record));", new: 'assert.ok(record.status);' },
    { file: 'test/a.test.ts', line: 12, kind: 'assertion', old: 'assert.equal(record.appAlive, true);', new: null },
  ]);
  assert.match(assertionNote(changedAssertions(diff)), /- test\/a\.test\.ts:12 — assertion removed or changed\n    was: assert\.equal\(record\.appAlive, true\);\n    now: \(removed\)/);
});

test('a moved assertion and a reformatted one are not removals', (t) => {
  const moved = PREVIEW_BEFORE
    .replace('    assert.equal(record.probe?.ok, true);\n', '')
    .replace("    assert.equal(await ex.stop('web-inproc'), true);\n", "    assert.equal(await ex.stop('web-inproc'), true);\n    assert.equal(record.probe?.ok, true);\n");
  assert.deepEqual(changedAssertions(gitDiff(t, { 'test/a.test.ts': PREVIEW_BEFORE }, { 'test/a.test.ts': moved })), []);

  // Re-indented into a new block, spaces inside the call changed, the trailing semicolon dropped: whitespace only.
  const reformatted = PREVIEW_BEFORE
    .replace("    assert.equal(launch?.status, 'pass');", "      assert.equal( launch?.status,'pass' )")
    .replace('    assert.equal(launch?.measure, undefined);', '\tassert.equal(launch?.measure,  undefined);')
    .replace(SAVED_WHOLE, `  ${SAVED_WHOLE}`);
  assert.deepEqual(changedAssertions(gitDiff(t, { 'test/a.test.ts': PREVIEW_BEFORE }, { 'test/a.test.ts': reformatted })), []);
});

test('a renamed test file is not a file of removed assertions, with git\'s rename detection on or off; a real removal inside it still is', (t) => {
  const before = { 'test/preview.test.ts': PREVIEW_BEFORE };
  for (const flags of [['-M'], ['--no-renames']]) {
    const same = gitDiff(t, before, { 'test/web-preview.test.ts': PREVIEW_BEFORE }, flags);
    assert.deepEqual(changedAssertions(same), [], flags[0]);
    const less = gitDiff(t, before, { 'test/web-preview.test.ts': PREVIEW_BEFORE.replace('    assert.equal(launch?.tty, undefined);\n', '') }, flags);
    assert.deepEqual(changedAssertions(less).map((f) => [f.kind, f.old, f.file]), [['assertion', 'assert.equal(launch?.tty, undefined);', 'test/preview.test.ts → test/web-preview.test.ts']], flags[0]);
  }
  // A test file deleted outright, with nothing it could have been renamed to, is said as that.
  const deleted = changedAssertions(gitDiff(t, { ...before, 'src/x.ts': 'x\n' }, { 'src/x.ts': 'y\n' }));
  assert.deepEqual(deleted, [{ file: 'test/preview.test.ts', line: 1, kind: 'file', new: null, old: 'the whole file: 10 assertion line(s), 1 test declaration(s)' }]);
});

test('an added skip, only or todo and a removed test declaration are listed; assertions in a non-test file are not this check\'s', (t) => {
  const file = [
    "test('one', () => {", '  assert.equal(f(1), 1);', '});', '',
    "test('two', () => {", '  assert.equal(f(2), 2);', '});', '',
    "it('three', () => {", '  expect(f(3)).toBe(3);', '});', '',
    "test('four', async () => {", '  await assert.rejects(f(4));', '});', '',
  ].join('\n');
  const after = file
    .replace("test('one', () => {", "test.skip('one', () => {")
    .replace("test('two', () => {", "test('two', { skip: true }, () => {")
    .replace("it('three', () => {\n  expect(f(3)).toBe(3);\n});\n\n", '')
    .replace("test('four', async () => {", "test.only('four', async () => {");
  const diff = gitDiff(t, { 'test/f.test.ts': file, 'src/f.ts': "assert(ok);\nexpect(1);\n" }, { 'test/f.test.ts': after, 'src/f.ts': 'export {};\n' });
  assert.deepEqual(changedAssertions(diff).map((f) => [f.kind, f.line, f.old, f.new]), [
    ['test', 1, "test('one', () => {", "test.skip('one', () => {"],
    ['skip', 1, null, "test.skip('one', () => {"],
    ['test', 5, "test('two', () => {", "test('two', { skip: true }, () => {"],
    ['skip', 5, null, "test('two', { skip: true }, () => {"],
    ['test', 9, "it('three', () => {", null],
    ['assertion', 10, 'expect(f(3)).toBe(3);', null],
    ['test', 13, "test('four', async () => {", "test.only('four', async () => {"],
    ['skip', 9, null, "test.only('four', async () => {"],
  ]);
});

test('the reviewer\'s block is bounded and says how many it left out', () => {
  const many: AssertionFinding[] = Array.from({ length: 150 }, (_, i) => ({ file: `test/f${i % 3}.test.ts`, line: i + 1, kind: 'assertion', old: `assert.equal(value${i}, ${'x'.repeat(300)});`, new: null }));
  const note = assertionNote(many);
  assert.ok(note.length <= 6_000, String(note.length));
  const shown = (note.match(/^- test\//gm) ?? []).length;
  assert.ok(shown >= 5 && shown < 150);
  assert.match(note, new RegExp(`… and ${150 - shown} more, in test/f\\d\\.test\\.ts`));
  assert.ok(!note.includes('x'.repeat(260)), 'each line of text is cut');
  assert.equal(assertionNote([]), '');
});

test('a run that narrows a pre-existing assertion: the reviewer is told, the run is flagged, and the owner gate holds it for a person', async () => {
  const r = rig({ 'test/preview.test.ts': PREVIEW_BEFORE, 'src/executor.ts': 'export const owner = null;\n' });
  try {
    fs.writeFileSync(path.join(r.repo, '..', path.basename(r.repo) + '.narrowed'), PREVIEW_NARROWED);
    r.worker(`cp "${r.repo}.narrowed" test/preview.test.ts && printf 'export const owner = { pid: 1 };\\n' > src/executor.ts`, 'DONE: records carry their owner.\nCHANGED: src/executor.ts, test/preview.test.ts (steps-only check).');
    const t = add(r, { prompt: 'Stamp the owner on run records.', acceptance: 'a run record names the process that owns it', gate: 'owner' } as never);
    await settle(r.sched, parked(r, t.id));
    fs.rmSync(`${r.repo}.narrowed`, { force: true });
    const task = r.store.getTask(t.id)!;
    const run = r.store.latestRun(t.id)!;
    assert.equal(task.status, 'awaiting-approval', task.error ?? '');
    assert.equal(task.repairs, 0, 'not a repair demand');
    assert.equal(task.preReviewRepairs ?? 0, 0);

    // (a) The reviewer is given the list, under the report, as Foreman's own.
    const prompt = r.prompts()[0]!;
    const at = prompt.indexOf('--- added by Foreman, not the worker ---\nFOREMAN CHECK (deterministic): pre-existing assertions this diff removed or changed');
    assert.ok(at > prompt.indexOf("WORKER'S REPORT (") && at < prompt.indexOf('WORK UNDER REVIEW (diff)'), 'the block is in the prompt, after the report');
    assert.ok(prompt.includes(`- test/preview.test.ts:21 — the value an assertion checks was redefined\n    was: ${SAVED_WHOLE.trim()}\n    now: ${SAVED_STEPS.trim()}`));

    // (b) The flag is on the run: an artifact row of type `assertions`, its findings in a file beside the diff.
    const rows = r.store.artifactsForTask(t.id).filter((a) => a.type === 'assertions' && a.runId === run.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.summary, 'the diff changes pre-existing assertions: 1 in test/preview.test.ts');
    assert.equal((JSON.parse(fs.readFileSync(rows[0]!.path, 'utf8')) as AssertionFinding[])[0]!.kind, 'asserted-value');

    // The owner-model gate does not sign it off, for that reason and by that row.
    r.store.setTestsPassed(run.id, true);
    const holds = reviewHolds(r.store, t.id);
    const now = r.store.latestRun(t.id)!;
    assert.equal(now.verdict, 'pass');
    assert.equal(hardHumanReason(task, now, holds), 'the diff changes pre-existing assertions: 1 in test/preview.test.ts');
    assert.equal(hardHumanReason(task, now, { ...holds, assertions: null }), null, 'control: nothing else holds this ticket');

    // A re-review is told too, from the stored findings.
    r.reviewer({ verdict: 'pass', critique: 'second look', issues: [] });
    await r.sched.reverify(t.id);
    assert.ok(r.prompts().at(-1)!.includes('- test/preview.test.ts:21 — the value an assertion checks was redefined'));
  } finally {
    await r.done();
  }
});

test('a run that only adds tests and assertions is not flagged and its review prompt carries no such block', async () => {
  const r = rig({ 'test/preview.test.ts': PREVIEW_BEFORE });
  try {
    r.worker(`printf "test('more', () => { assert.equal(1, 1); });\\n" >> test/preview.test.ts && printf "test('new', () => { assert.ok(true); });\\n" > test/new.test.ts`, 'DONE: two tests added.');
    const t = add(r, { prompt: 'Add tests.', acceptance: 'more tests' });
    await settle(r.sched, parked(r, t.id));
    assert.equal(r.store.getTask(t.id)!.status, 'awaiting-approval');
    assert.ok(!r.prompts()[0]!.includes('pre-existing assertions'));
    assert.equal(r.store.artifactsForTask(t.id).filter((a) => a.type === 'assertions').length, 0);
    assert.equal(reviewHolds(r.store, t.id).assertions, null);
  } finally {
    await r.done();
  }
});
