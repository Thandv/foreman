import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintPlan } from '../src/assistant/planCheck.ts';
import type { CrewPlan, CrewTicket } from '../src/assistant/crewPlan.ts';

const HERE = path.dirname(new URL(import.meta.url).pathname);

/** A scratch "Foreman checkout": only the root marker (package.json) copied in. */
function scratchRoot(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfepic-')));
  fs.copyFileSync(path.join(HERE, '..', 'package.json'), path.join(dir, 'package.json'));
  return dir;
}

function ticket(over: Partial<CrewTicket> & { ref: string }): CrewTicket {
  return {
    title: 'A ticket', prompt: 'Do the work described in the title, carefully and with a test.', role: 'dev',
    kind: 'code', after: [], acceptance: 'It works.', testCmd: 'npm test', points: 2, ...over,
  };
}

function planOf(repo: string | null, tickets: CrewTicket[]): CrewPlan {
  return {
    ask: 'x', playbook: 'soft', epic: { title: 'e', summary: 's' }, tickets, repo, degraded: false,
    notes: '', costUsd: 0, precedents: [], findings: [],
  };
}

const refused = (plan: CrewPlan, root: string) =>
  lintPlan(plan, null, root).filter((f) => f.code === 'core-file-refused');

test('a self-epic ticket that edits src/queue.ts warns, naming the ticket and the path', () => {
  const root = scratchRoot();
  const plan = planOf(root, [
    ticket({ ref: 'a1', prompt: 'Edit src/queue.ts so tasks keep a retry counter across restarts.' }),
    ticket({ ref: 'a2', prompt: 'Edit src/lib/helper.ts only; nothing else needs to change here.' }),
  ]);
  const found = refused(plan, root);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.level, 'warn');
  assert.equal(found[0]!.ticket, 'a1');
  assert.match(found[0]!.message, /likely refused at admission: consider hand work/);
  assert.match(found[0]!.message, /a1/);
  assert.match(found[0]!.message, /src\/queue\.ts/);
});

test('excludes src/queue.ts produces no warning', () => {
  const root = scratchRoot();
  const plan = planOf(root, [
    ticket({ ref: 'a1', acceptance: 'The change excludes src/queue.ts and everything else core.' }),
    ticket({ ref: 'a2', prompt: 'Write the docs. You must not edit src/scheduler.ts, and never edit src/db.ts.' }),
  ]);
  assert.deepEqual(refused(plan, root), []);
  // Control: the same ticket without the exclusion wording does warn.
  const control = planOf(root, [ticket({ ref: 'a1', acceptance: 'The change edits src/queue.ts and everything else core.' })]);
  assert.deepEqual(refused(control, root).map((f) => f.ticket), ['a1']);
});

test('the same plan aimed at a repo that is not the Foreman root produces no warning', () => {
  const root = scratchRoot();
  const other = scratchRoot();
  const plan = planOf(other, [ticket({ ref: 'a1', prompt: 'Edit src/queue.ts so tasks keep a retry counter.' })]);
  assert.deepEqual(refused(plan, root), []);
  assert.deepEqual(refused(planOf(null, plan.tickets), root), []);
  // Control: only the repo differs.
  assert.equal(refused(planOf(root, plan.tickets), root).length, 1);
});

test('a self-epic reached through a symlink still counts as the Foreman root', () => {
  const root = scratchRoot();
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'selfepic-link-')), 'checkout');
  fs.symlinkSync(root, link);
  const plan = planOf(link, [ticket({ ref: 'a1', prompt: 'Edit src/merge.ts to refuse diverged landings.' })]);
  assert.equal(refused(plan, root).length, 1);
});

test('stop-clause examples, other directories and lookalike names do not warn', () => {
  const root = scratchRoot();
  const plan = planOf(root, [
    ticket({ ref: 'a1', prompt: 'If the work needs a core file (e.g. src/queue.ts or src/scheduler.ts), stop and say so.' }),
    ticket({ ref: 'a2', prompt: 'Edit board/src/merge.ts and src/queue.tsx and src/queue.ts.bak, nothing more.' }),
    ticket({ ref: 'a3', acceptance: 'The diff has no PROTECTED_PATHS file.' }),
    ticket({ ref: 'a4', prompt: 'Edit src/queue.ts so tasks keep a retry counter across restarts.' }),
  ]);
  // a4 is the control that really edits a protected path: it is the only ticket warned.
  assert.deepEqual(refused(plan, root).map((f) => f.ticket), ['a4']);
});

test('a directory entry such as src/security/ is a prefix, and a mention after an exclusion sentence still warns', () => {
  const root = scratchRoot();
  const plan = planOf(root, [
    ticket({ ref: 'a1', prompt: 'Edit src/security/sandbox.ts to tighten the profile and add a case.' }),
    ticket({ ref: 'a2', prompt: 'Do not touch src/db.ts. Then change src/gate.ts to log the verdict.' }),
  ]);
  const found = refused(plan, root);
  assert.deepEqual(found.map((f) => f.ticket), ['a1', 'a2']);
  assert.match(found[0]!.message, /src\/security\/sandbox\.ts/);
  assert.match(found[1]!.message, /src\/gate\.ts/);
  assert.doesNotMatch(found[1]!.message, /src\/db\.ts/);
});

test('a sentence-final full stop is not part of a directory-prefix match, and letter-case does not hide a path', () => {
  const root = scratchRoot();
  const plan = planOf(root, [
    ticket({ ref: 'a1', prompt: 'Tighten the profile in src/security/sandbox.ts.' }),
    ticket({ ref: 'a2', prompt: 'Review everything under src/security/.' }),
    ticket({ ref: 'a3', prompt: 'Edit SRC/Queue.ts, which the disk opens as src/queue.ts on macOS.' }),
  ]);
  const found = refused(plan, root);
  assert.deepEqual(found.map((f) => f.ticket), ['a1', 'a2', 'a3']);
  assert.match(found[0]!.message, /names src\/security\/sandbox\.ts$/);
  assert.match(found[1]!.message, /names src\/security\/$/);
  assert.match(found[2]!.message, /names SRC\/Queue\.ts/);
});

test('the stand-in fixture warns on exactly p1-p6 and on none of d1-d4, and never blocks', () => {
  const root = scratchRoot();
  const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'selfepic-refused-0810.json'), 'utf8')) as {
    tickets: Array<{ ref: string; title: string; prompt: string; acceptance: string; after: string[] }>;
  };
  const plan = planOf(root, fixture.tickets.map((t) => ticket(t)));
  const findings = lintPlan(plan, null, root);
  const found = findings.filter((f) => f.code === 'core-file-refused');
  assert.deepEqual(found.map((f) => f.ticket), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.ok(found.every((f) => f.level === 'warn'));
  assert.equal(findings.some((f) => f.level === 'error'), false);
  const off = lintPlan(planOf(os.tmpdir(), plan.tickets), null, root);
  assert.deepEqual(off.map((f) => f.code), findings.map((f) => f.code).filter((c) => c !== 'core-file-refused'));
});
