import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.ts';
import { PLAN_SKILLS_MAX_BYTES, cloneEpic, crewPlan, parseCrewPlan, planSkillsBrief, planSkillsSection, queueCrewPlan } from '../src/assistant/crewPlan.ts';
import { openDb } from '../src/db.ts';
import { clearPlaybookCache, getPlaybook, loadPlaybooks, type Playbook } from '../src/playbooks.ts';
import { Store } from '../src/queue.ts';
import { resumedSkillsBrief, skillsRunEvent } from '../src/roles.ts';
import { resetPreflightCache } from '../src/runners/cliRunners.ts';
import { Scheduler, briefFor, repairBrief } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import {
  SKILLS_HEADER, TicketSkillsRefused, assertTicketSkills, carriedSkills, checkTicketSkills, clearSkillCache, setTicketSkills,
} from '../src/skills.ts';
import type { RunEvent, Task } from '../src/types.ts';
import { crewReview } from '../src/verify/crewReview.ts';

// Every fixture is built in a temp dir; the real skills repository and the
// operator's daemon and database are never read.

const FULL = (name: string): string => `1. FULL-BODY-${name}: do the first thing.\n2. Report what you did.\n`;
const CARD = (name: string): string => `1. CARD-BODY-${name}: do the first thing.\n`;
const section = (name: string): string => `## ${name}\n${FULL(name).trim()}`;

function writeSkill(root: string, name: string, roles = ['soft.dev'], extra: Record<string, unknown> = {}): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skill.json'),
    JSON.stringify({ name, description: `the ${name} procedure`, roles, kinds: ['code'], when: `Use ${name} when the ticket calls for it.`, status: 'draft', ...extra }),
  );
  fs.writeFileSync(path.join(dir, 'full.md'), FULL(name));
  fs.writeFileSync(path.join(dir, 'card.md'), CARD(name));
}

function writeLoadouts(root: string, roles: Record<string, { default?: string[]; allowed?: string[] }>): void {
  fs.writeFileSync(path.join(root, 'loadouts.json'), JSON.stringify({ roles }));
}

const PB_BODY = `
## role: lead

You lead the work and review it for correctness.

## role: dev

You implement exactly what the ticket asks.
`;

function pbText(extra: Record<string, unknown> = {}): string {
  const fm = {
    id: 'soft',
    description: 'a test crew',
    triggers: ['code'],
    roles: { lead: { tier: 'senior' }, dev: { tier: 'worker' } },
    reviewers: [{ role: 'lead', style: 'code-review' }],
    escalation: { chair: 'lead', afterFailures: 2 },
    checks: [],
    gate: { default: 'human', hardHuman: ['S2'] },
    constraints: ['Never do the bad thing.'],
    ...extra,
  };
  return `---\n${JSON.stringify(fm, null, 2)}\n---\n${PB_BODY}`;
}

const ENV_KEYS = [
  'FOREMAN_SKILLS_DIR', 'FOREMAN_SKILL_BRIEF_BYTES', 'FOREMAN_PLAYBOOKS_DIR', 'FOREMAN_LOCAL_ONLY', 'FOREMAN_CLAUDE_BIN',
  'FOREMAN_MODEL_WORKER', 'FOREMAN_MODEL_SENIOR', 'FOREMAN_MODEL_OWNER',
];

interface World {
  base: string;
  root: string;
  pbDir: string;
  pb: (extra?: Record<string, unknown>) => Playbook;
}

/**
 * One isolated world per test: a skills repo and a playbooks dir in a temp
 * dir, skills ON. soft.dev carries `one` and `two` by default and may carry
 * `debug`, `docs` and `foreign` (which its own skill.json gives to lead only);
 * `unlisted` is a loaded dev skill the loadout does not offer.
 */
async function world(fn: (w: World) => void | Promise<void>): Promise<void> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ticket-skills-')));
  const root = path.join(base, 'repo');
  const pbDir = path.join(base, 'playbooks');
  for (const d of [path.join(root, 'skills'), pbDir]) fs.mkdirSync(d, { recursive: true });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['FOREMAN_SKILLS_DIR'] = root;
  process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
  process.env['FOREMAN_LOCAL_ONLY'] = '0';
  for (const name of ['one', 'two', 'debug', 'docs', 'unlisted']) writeSkill(root, name);
  writeSkill(root, 'foreign', ['soft.lead']);
  writeSkill(root, 'review', ['soft.lead']);
  writeLoadouts(root, {
    'soft.dev': { default: ['one', 'two'], allowed: ['debug', 'docs', 'foreign'] },
    'soft.lead': { default: ['review'], allowed: [] },
  });
  clearSkillCache();
  clearPlaybookCache();
  const pb = (extra: Record<string, unknown> = {}): Playbook => {
    fs.writeFileSync(path.join(pbDir, 'soft.md'), pbText(extra));
    clearPlaybookCache();
    const loaded = getPlaybook('soft');
    assert.ok(loaded, JSON.stringify(loadPlaybooks().refused));
    return loaded;
  };
  pb();
  try {
    await fn({ base, root, pbDir, pb });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearSkillCache();
    clearPlaybookCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const crew = (over: Record<string, unknown> = {}): Parameters<Store['addTask']>[0] => ({
  title: 'crew ticket', prompt: 'TICKET-TEXT build the thing', runner: 'echo', role: 'dev', playbook: 'soft', ...over,
});

/** The names of the `## <skill>` sections a brief carries, in order. */
const sections = (brief: string): string[] => [...brief.matchAll(/^## ([a-z0-9-]+)$/gm)].map((m) => m[1]!);

// ---------------------------------------------------------------- storage

/** A row as main's own INSERT would have left it, written with only the columns the base schema and main's migrations have. */
function insertOldRow(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO tasks (id,title,prompt,kind,runner,status,created_at,updated_at,role,playbook) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'an old ticket', 'made before skills were per ticket', 'code', 'echo', 'queued', 1, 1, 'dev', 'soft');
}

const taskColumns = (file: string): string[] => {
  const db = new DatabaseSync(file);
  try {
    return (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    db.close();
  }
};

/** The commit this change was cut from: its db.ts is "the schema before". */
const BEFORE = '4288cb5';

test('migration: a database created by the previous schema (its own db.ts) gains tasks.skills, and its rows read as the role default', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-olddb-'));
  try {
    let oldSource: string;
    try {
      oldSource = execFileSync('git', ['-C', config.sourceRoot, 'show', `${BEFORE}:src/db.ts`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      t.skip(`commit ${BEFORE} is not in this checkout; the next test covers the same migration without it`);
      return;
    }
    // db.ts imports only node modules and types, so the old file runs on its own.
    const oldFile = path.join(dir, 'db-before.ts');
    fs.writeFileSync(oldFile, oldSource);
    const old = (await import(pathToFileURL(oldFile).href)) as { openDb: (p: string) => DatabaseSync };
    const file = path.join(dir, 'foreman.db');
    const db = old.openDb(file);
    insertOldRow(db, 't_old');
    db.close();
    assert.ok(!taskColumns(file).includes('skills'), 'the old schema has no skills column');

    const store = new Store(file);
    try {
      assert.ok(taskColumns(file).includes('skills'));
      const row = store.getTask('t_old')!;
      assert.equal(row.title, 'an old ticket');
      assert.equal(row.skills, null, 'an existing row means: the role default');
      // And the reopened database takes a ticket with skills like a new one does.
      await world(() => {
        const made = store.addTask(crew({ skills: ['debug'] }));
        assert.deepEqual(store.getTask(made.id)!.skills, ['debug']);
      });
    } finally {
      store.close();
    }
    // Idempotent: a second open neither fails nor duplicates the column.
    new Store(file).close();
    assert.equal(taskColumns(file).filter((c) => c === 'skills').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: a database with every column but tasks.skills gains it on open, rows intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-olddb-'));
  try {
    const file = path.join(dir, 'foreman.db');
    const db = openDb(file);
    insertOldRow(db, 't_old');
    // What the previous schema is, relative to this one. A build without the
    // migration has no such column to drop, and fails here.
    db.exec('ALTER TABLE tasks DROP COLUMN skills');
    db.close();
    assert.ok(!taskColumns(file).includes('skills'));

    const store = new Store(file);
    try {
      assert.ok(taskColumns(file).includes('skills'));
      assert.equal(store.getTask('t_old')!.skills, null);
      assert.deepEqual(store.listTasks().map((t) => t.id), ['t_old']);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- the check, on the way in

test('addTask stores a checked list; a ticket that names none stores NULL', async () => {
  await world(() => {
    const store = new Store(':memory:');
    try {
      const named = store.addTask(crew({ skills: ['debug', 'one'] }));
      assert.deepEqual(named.skills, ['debug', 'one']);
      assert.deepEqual(store.getTask(named.id)!.skills, ['debug', 'one']);
      assert.equal(store.db.prepare('SELECT skills FROM tasks WHERE id = ?').get(named.id)!['skills'], '["debug","one"]');

      for (const none of [undefined, null, []]) {
        const plain = store.addTask(crew({ skills: none }));
        assert.equal(plain.skills, null);
        assert.equal(store.db.prepare('SELECT skills FROM tasks WHERE id = ?').get(plain.id)!['skills'], null);
      }
      assert.deepEqual(store.listTasks().find((t) => t.id === named.id)!.skills, ['debug', 'one'], 'the list read carries it too');
    } finally {
      store.close();
    }
  });
});

const REFUSALS: Array<{ name: string; over: Record<string, unknown>; off?: boolean; says: RegExp[] }> = [
  { name: 'an unknown name', over: { skills: ['no-such-skill'] }, says: [/skill no-such-skill refused/, /not in the allowed list for soft\.dev/] },
  { name: 'a loaded skill the role is not allowed', over: { skills: ['unlisted'] }, says: [/skill unlisted refused/, /not in the allowed list for soft\.dev/] },
  { name: 'a skill that does not list the role', over: { skills: ['foreign'] }, says: [/skill foreign refused/, /does not list soft\.dev in its roles/] },
  { name: 'more than two', over: { skills: ['debug', 'docs', 'one'] }, says: [/skill one refused/, /over the limit of 2 skills per ticket/] },
  { name: 'one bad name beside a good one', over: { skills: ['debug', 'typo'] }, says: [/skill typo refused/] },
  { name: 'a name that is not a skill name', over: { skills: ['Bad Name;rm'] }, says: [/skill "Bad Name;rm" refused/, /not a valid skill name/] },
  { name: 'the feature off', over: { skills: ['debug'] }, off: true, says: [/skill debug refused/, /skills are off \(FOREMAN_SKILLS_DIR is not set/] },
  { name: 'a ticket with no role', over: { skills: ['debug'], role: null }, says: [/skill debug refused/, /needs both a playbook and a role/] },
  { name: 'a ticket with no playbook', over: { skills: ['debug'], playbook: null }, says: [/needs both a playbook and a role/] },
  { name: 'a ticket that names an agent', over: { skills: ['debug'], agent: 'someone' }, says: [/names an agent \('someone'\); only a playbook role carries skills/] },
  { name: 'a role with no loadout', over: { skills: ['debug'], role: 'ghost' }, says: [/skill debug refused/, /soft\.ghost has no skills it may carry/] },
];

for (const row of REFUSALS) {
  test(`addTask refuses ${row.name}: the refusal names the skill, and no ticket is queued`, async () => {
    await world(() => {
      if (row.off) delete process.env['FOREMAN_SKILLS_DIR'];
      const store = new Store(':memory:');
      try {
        let message = '';
        assert.throws(() => store.addTask(crew(row.over)), (err: Error) => {
          message = err.message;
          return err instanceof TicketSkillsRefused;
        });
        for (const re of row.says) assert.match(message, re);
        assert.equal(store.listTasks().length, 0, 'refused whole: nothing was queued, with or without the list');
      } finally {
        store.close();
      }
    });
  });
}

test('a refusal says what the role may carry instead: its default, then its allowed list', async () => {
  await world(() => {
    assert.throws(
      () => assertTicketSkills({ playbook: 'soft', role: 'dev' }, ['nope']),
      /soft\.dev may carry: one, two, debug, docs, foreign \(at most 2\)/,
    );
    // Not a list at all (a request body can hold anything).
    assert.throws(() => assertTicketSkills({ playbook: 'soft', role: 'dev' }, 'debug'), /skills must be a list of skill names/);
    assert.throws(() => assertTicketSkills({ playbook: 'soft', role: 'dev' }, ['debug', 7]), /a skill is named by a string/);
    assert.equal(assertTicketSkills({ playbook: 'soft', role: 'dev' }, null), null);
    assert.equal(assertTicketSkills({}, []), null, 'nothing asked for is nothing to refuse, role or no role');
    // The same check, reporting instead of throwing: what a plan keeps.
    const check = checkTicketSkills({ playbook: 'soft', role: 'dev' }, ['debug', 'nope', 'docs', 'one']);
    assert.deepEqual(check.names, ['debug', 'docs']);
    assert.deepEqual(check.refused.map((r) => r.name), ['nope', 'one']);
  });
});

test('setTicketSkills changes a queued ticket\'s list, clears it, and leaves it alone on a refusal', async () => {
  await world(() => {
    const store = new Store(':memory:');
    try {
      const t = store.addTask(crew());
      assert.deepEqual(setTicketSkills(store, t.id, ['debug']).skills, ['debug']);
      assert.deepEqual(store.getTask(t.id)!.skills, ['debug']);
      assert.ok(store.eventsForTask(t.id).some((e) => e.type === 'status' && e.message === 'skills set: debug'));

      assert.throws(() => setTicketSkills(store, t.id, ['debug', 'nope']), /skill nope refused/);
      assert.throws(() => setTicketSkills(store, t.id, ['debug', 'docs', 'one']), /over the limit of 2/);
      assert.deepEqual(store.getTask(t.id)!.skills, ['debug'], 'a refused change changes nothing');

      assert.equal(setTicketSkills(store, t.id, null).skills, null);
      assert.equal(store.db.prepare('SELECT skills FROM tasks WHERE id = ?').get(t.id)!['skills'], null);
      assert.throws(() => setTicketSkills(store, 't_none', ['debug']), /task not found/);

      const plain = store.addTask({ title: 'no crew', prompt: 'x', runner: 'echo' });
      assert.throws(() => setTicketSkills(store, plain.id, ['debug']), /needs both a playbook and a role/);
      delete process.env['FOREMAN_SKILLS_DIR'];
      assert.throws(() => setTicketSkills(store, t.id, ['debug']), /skills are off/);
      assert.equal(setTicketSkills(store, t.id, null).skills, null, 'clearing needs nothing switched on');
    } finally {
      store.close();
    }
  });
});

// ------------------------------------------------------------------ the brief

/** The whole brief of the fixture's dev ticket, as it is composed with `block` for skills ('' for none). */
const devBrief = (block: string): string =>
  `You implement exactly what the ticket asks.\n\nHard constraints:\n- Never do the bad thing.${block ? `\n\n${block}` : ''}\n\n---\n\nTICKET-TEXT build the thing`;

test('a ticket with its own skills gets exactly those blocks in its brief, and not the role default', async () => {
  await world(() => {
    const store = new Store(':memory:');
    try {
      const t = store.addTask(crew({ skills: ['debug', 'docs'] }));
      const brief = briefFor(store, store.getTask(t.id)!);
      assert.deepEqual(sections(brief), ['debug', 'docs']);
      assert.equal(brief, devBrief(`${SKILLS_HEADER}\n\n${section('debug')}\n\n${section('docs')}`));
      assert.ok(!brief.includes('FULL-BODY-one') && !brief.includes('FULL-BODY-two'), 'the default pair is replaced, not added to');
      assert.ok(!brief.includes('Foreman left out'), 'nothing was dropped, so nothing is said');
      // A mix of a default and an allowed name is the ticket's choice too.
      const mixed = store.addTask(crew({ skills: ['two', 'debug'] }));
      assert.deepEqual(sections(briefFor(store, store.getTask(mixed.id)!)), ['two', 'debug']);
    } finally {
      store.close();
    }
  });
});

test('precedence: the ticket\'s list, else the playbook\'s skills key, else the loadout default', async () => {
  await world(({ pb }) => {
    const store = new Store(':memory:');
    try {
      const own = store.addTask(crew({ skills: ['debug'] }));
      const none = store.addTask(crew());
      const read = (id: string): string[] => sections(briefFor(store, store.getTask(id)!));

      assert.deepEqual(read(none.id), ['one', 'two'], 'loadout default');
      assert.deepEqual(read(own.id), ['debug'], 'ticket over loadout default');

      const keyed = pb({ skills: { dev: ['docs'] } });
      assert.deepEqual(read(none.id), ['docs'], 'playbook key over loadout default');
      assert.deepEqual(read(own.id), ['debug'], 'ticket over playbook key');
      assert.equal(carriedSkills(keyed, 'dev', ['debug']).source, 'ticket');
      assert.equal(carriedSkills(keyed, 'dev', null).source, 'playbook');
      assert.equal(carriedSkills(pb(), 'dev', []).source, 'default');
    } finally {
      store.close();
    }
  });
});

test('skills NULL, or the feature off: the brief is byte-for-byte what it was', async () => {
  await world(() => {
    const store = new Store(':memory:');
    try {
      const plain = store.addTask(crew());
      const named = store.addTask(crew({ skills: ['debug'] }));
      // NULL with skills on: the role default block, composed exactly as before this change.
      assert.equal(briefFor(store, store.getTask(plain.id)!), devBrief(`${SKILLS_HEADER}\n\n${section('one')}\n\n${section('two')}`));

      delete process.env['FOREMAN_SKILLS_DIR'];
      assert.equal(briefFor(store, store.getTask(plain.id)!), devBrief(''));
      // Off wins over a list stored while it was on: no block, no line about it.
      assert.equal(briefFor(store, store.getTask(named.id)!), devBrief(''));
      assert.equal(skillsRunEvent(store.getTask(named.id)!), null, 'and no skills event is written');
    } finally {
      store.close();
    }
  });
});

test('a skill made invalid after the ticket was queued is left out and the brief says so; with none left the role default is carried', async () => {
  await world(({ root }) => {
    const store = new Store(':memory:');
    try {
      const t = store.addTask(crew({ skills: ['debug', 'docs'] }));
      const read = (): string => briefFor(store, store.getTask(t.id)!);
      assert.deepEqual(sections(read()), ['debug', 'docs']);

      // Retired since: one of two.
      writeSkill(root, 'debug', ['soft.dev'], { status: 'retired' });
      clearSkillCache();
      let brief = read();
      assert.deepEqual(sections(brief), ['docs']);
      assert.ok(brief.includes('Foreman left out: debug — refused at load (see: foreman skills).'), brief);
      assert.ok(!brief.includes('usual skills apply'), 'one of the ticket\'s own is still served: no fallback');

      // Taken off the role's list since: the other one too. Nothing of the ticket's is left.
      writeLoadouts(root, { 'soft.dev': { default: ['one', 'two'], allowed: ['debug'] } });
      clearSkillCache();
      brief = read();
      assert.deepEqual(sections(brief), ['one', 'two'], 'the role default, not an empty brief');
      assert.ok(
        brief.includes(
          "Foreman left out: debug — refused at load (see: foreman skills); docs — not in the allowed list for soft.dev. The role's usual skills apply instead.",
        ),
        brief,
      );
      assert.deepEqual(store.getTask(t.id)!.skills, ['debug', 'docs'], 'the ticket keeps what it was given');
      const event = JSON.parse(skillsRunEvent(store.getTask(t.id)!)!);
      assert.deepEqual(event.skills, ['one', 'two']);
      assert.equal(event.source, 'default');
      assert.equal(event.fellBack, true);
      assert.deepEqual(event.dropped.map((d: { name: string }) => d.name), ['debug', 'docs']);

      // No default either: the brief still carries the line, and only the line.
      writeLoadouts(root, { 'soft.dev': { default: [], allowed: [] } });
      clearSkillCache();
      brief = read();
      assert.deepEqual(sections(brief), []);
      assert.ok(!brief.includes(SKILLS_HEADER));
      assert.ok(brief.includes("docs — not in the allowed list for soft.dev. The role's usual skills apply instead."), brief);

      // Put right again, the ticket's own list is served again.
      writeSkill(root, 'debug');
      writeLoadouts(root, { 'soft.dev': { default: ['one', 'two'], allowed: ['debug', 'docs'] } });
      clearSkillCache();
      assert.deepEqual(sections(read()), ['debug', 'docs']);
    } finally {
      store.close();
    }
  });
});

// ------------------------------------------------------- the run: event and repair round

const skillEvents = (store: Store, taskId: string): RunEvent[] => store.eventsForTask(taskId).filter((e) => e.type === 'skills');

test('each run starts with a skills event on the run: role, source, variant, what the brief carries and what was dropped', async () => {
  await world(async ({ root }) => {
    const store = new Store(':memory:');
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });
    try {
      const named = store.addTask(crew({ skills: ['debug', 'docs'] }));
      const plain = store.addTask(crew());
      const noCrew = store.addTask({ title: 'no crew', prompt: 'plain work', runner: 'echo' });
      // Retired after queueing, before the run: the event must say what ran, not what was asked.
      writeSkill(root, 'docs', ['soft.dev'], { status: 'retired' });
      clearSkillCache();
      await sched.drain(30_000);

      const [ev, ...rest] = skillEvents(store, named.id);
      assert.equal(rest.length, 0, 'one event per run');
      assert.equal(ev!.runId, store.latestRun(named.id)!.id, 'on the run, so outcomes join to it');
      assert.deepEqual(JSON.parse(ev!.message), {
        role: 'soft.dev', source: 'ticket', variant: 'full', skills: ['debug'],
        dropped: [{ name: 'docs', reason: 'refused at load (see: foreman skills)' }],
      });
      assert.deepEqual(JSON.parse(skillEvents(store, plain.id)[0]!.message), {
        role: 'soft.dev', source: 'default', variant: 'full', skills: ['one', 'two'], dropped: [],
      });
      assert.equal(skillEvents(store, noCrew.id).length, 0, 'a ticket with no role carries no skills and gets no event');
      // The run's log artifact keeps the line too: events are pruned per task, the log file is not.
      const log = fs.readFileSync(store.artifactsForTask(named.id).find((a) => a.type === 'log')!.path, 'utf8');
      assert.match(log, /skills \{"role":"soft\.dev","source":"ticket"/);
    } finally {
      await sched.stop();
      store.close();
    }
  });
});

test('a runner that takes no brief (shell) gets no skills event: the event says what a brief carried, and there was none', async () => {
  await world(async () => {
    const store = new Store(':memory:');
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });
    try {
      // The same crew role on two runners. The shell runner is handed the prompt as a command, never a brief.
      const shell = store.addTask(crew({ runner: 'shell', prompt: 'true', kind: 'general' }));
      const echo = store.addTask(crew());
      await sched.drain(30_000);
      assert.ok(store.latestRun(shell.id), 'the shell ticket ran');
      assert.equal(skillEvents(store, echo.id).length, 1, 'the control: a runner that takes a brief has its event');
      assert.equal(skillEvents(store, shell.id).length, 0, 'no brief, so nothing carried and nothing claimed');
      const log = store.artifactsForTask(shell.id).find((a) => a.type === 'log');
      if (log) assert.doesNotMatch(fs.readFileSync(log.path, 'utf8'), / skills \{/);
    } finally {
      await sched.stop();
      store.close();
    }
  });
});

test('an absurdly long list is refused once, not name by name: the refusal stays small on every way in', async () => {
  await world(async () => {
    const store = new Store(':memory:');
    try {
      const many = Array.from({ length: 10_000 }, (_, i) => `n${i}`);
      const before = store.listTasks().length;
      assert.throws(() => store.addTask(crew({ skills: many })), (err: Error) => {
        assert.ok(err instanceof TicketSkillsRefused);
        assert.match(err.message, /10000 names/);
        assert.match(err.message, /at most 2 skills/);
        assert.ok(err.message.length < 400, `one line, not ten thousand (${err.message.length} chars)`);
        return true;
      });
      assert.equal(store.listTasks().length, before, 'no ticket');
      // Repeats count toward the length too: the list is not read.
      assert.throws(() => store.addTask(crew({ skills: Array.from({ length: 17 }, () => 'debug') })), TicketSkillsRefused);
      // Sixteen is still read, and repeats within it still count once.
      assert.deepEqual(store.addTask(crew({ skills: Array.from({ length: 16 }, () => 'debug') })).skills, ['debug']);
      // A plan keeps its ticket and shows one warning.
      const plan = parseCrewPlan({ ask: 'do it', playbook: 'soft', tickets: [{ ref: 't1', title: 'x', prompt: 'p', role: 'dev', skills: many }] });
      const dropped = plan.findings.filter((f) => f.code === 'skill-dropped');
      assert.equal(dropped.length, 1);
      assert.equal(plan.tickets.length, 1);
      assert.equal(plan.tickets[0]!.skills ?? null, null);
    } finally {
      store.close();
    }
  });
});

test('a local-model role records the card variant', async () => {
  await world(() => {
    process.env['FOREMAN_LOCAL_ONLY'] = '1';
    const event = JSON.parse(skillsRunEvent({ playbook: 'soft', role: 'dev', agent: null, skills: ['debug'] })!);
    assert.equal(event.variant, 'card');
    assert.equal(JSON.parse(skillsRunEvent({ playbook: 'soft', role: 'dev', agent: null, skills: null }, true)!).resumed, true);
    assert.equal(skillsRunEvent({ playbook: 'soft', role: 'dev', agent: 'someone', skills: null }), null, 'an explicit agent carries no skills');
    assert.equal(skillsRunEvent({ playbook: 'nope', role: 'dev', agent: null, skills: null }), null);
  });
});

test('a repair round carries the same skills as the first round', async () => {
  await world(async () => {
    const store = new Store(':memory:');
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
    try {
      // The echo runner fails any brief containing the word, which queues one repair round.
      const t = store.addTask(crew({ prompt: 'TICKET-TEXT please fail', skills: ['debug'], maxRepairs: 1 }));
      const first = briefFor(store, store.getTask(t.id)!);
      await sched.drain(30_000);

      const runs = store.runsForTask(t.id);
      assert.equal(runs.length, 2, 'the first run and its repair round');
      const events = skillEvents(store, t.id);
      assert.deepEqual(events.map((e) => JSON.parse(e.message).skills), [['debug'], ['debug']]);
      assert.deepEqual(new Set(events.map((e) => e.runId)), new Set(runs.map((r) => r.id)), 'one event on each run');

      const after = store.getTask(t.id)!;
      assert.ok(after.repairNotes, 'the ticket is in its repair state');
      assert.deepEqual(after.skills, ['debug']);
      const repair = briefFor(store, after);
      assert.deepEqual(sections(repair), ['debug']);
      assert.ok(repair.startsWith(first), 'the repair brief is the first brief plus the critique');
      assert.match(repair.slice(first.length), /REJECTED by the verification council/);

      // A retry is a new attempt at the same ticket: it keeps the list unless told otherwise.
      assert.deepEqual(store.retry(t.id).skills, ['debug']);
    } finally {
      await sched.stop();
      store.close();
    }
  });
});

// ------------------------------------------------- a resumed round (claude --resume)

test('a resumed round re-sends nothing while the skills are the same, and the new block once they are not', async () => {
  await world(({ root }) => {
    const store = new Store(':memory:');
    try {
      const t = store.addTask(crew({ skills: ['debug'] }));
      const task = (): Task => store.getTask(t.id)!;
      const ran = (): void => {
        store.record({ taskId: t.id, type: 'skills', message: skillsRunEvent(task())! });
      };
      // No earlier event to compare with: a ticket with its own list is sent it; one on the default is not.
      assert.match(resumedSkillsBrief(store, task()), /These replace any you were given earlier:\n\n.*\n\n## debug\n/);
      const plain = store.addTask(crew());
      assert.equal(resumedSkillsBrief(store, store.getTask(plain.id)!), '');

      ran();
      assert.equal(resumedSkillsBrief(store, task()), '', 'the session already holds them');

      setTicketSkills(store, t.id, ['docs']);
      const changed = resumedSkillsBrief(store, task());
      assert.ok(changed.startsWith('\n---\nThe skills for this ticket are not the ones this session began with. These replace any you were given earlier:\n\n'), changed);
      assert.ok(changed.endsWith(`${SKILLS_HEADER}\n\n${section('docs')}`), changed);
      assert.ok(!changed.includes('FULL-BODY-debug'));
      ran();
      assert.equal(resumedSkillsBrief(store, task()), '', 'sent once, not on every later round');

      // Back on the role default: that is a change too.
      setTicketSkills(store, t.id, null);
      assert.deepEqual(sections(resumedSkillsBrief(store, task())), ['one', 'two']);
      ran();

      // Retired between rounds, nothing left for the role at all.
      writeLoadouts(root, { 'soft.dev': { default: [], allowed: [] } });
      clearSkillCache();
      assert.match(resumedSkillsBrief(store, task()), /The ones you were given earlier no longer apply to it\.$/);

      delete process.env['FOREMAN_SKILLS_DIR'];
      assert.equal(resumedSkillsBrief(store, task()), '', 'off: the resumed brief is the critique alone');
    } finally {
      store.close();
    }
  });
});

/** A `claude` stand-in: answers the preflight, announces a session, changes a file, and logs its argv. `runs()` is the worker's. */
function stubWorkerCli(dir: string): { runs: () => string[][] } {
  const log = path.join(dir, 'worker-argv.log');
  const count = path.join(dir, 'worker-count');
  const bin = path.join(dir, 'claude-worker');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n` +
      `printf '<<<END>>>\\n' >> "${log}"\n` +
      `[ "$1" = "--version" ] && { printf '1.2.3\\n'; exit 0; }\n` +
      `n=0\n[ -f "${count}" ] && n=$(cat "${count}")\n` +
      `n=$((n+1))\nprintf '%s' "$n" > "${count}"\n` +
      // Only a worker run edits its tree. The crew reviewer is this same binary, run from the test's own directory.
      `case "$*" in *"REVIEW STYLE ("*) ;; *) printf 'round %s\\n' "$n" >> stub-work.txt ;; esac\n` +
      `printf '{"type":"system","subtype":"init","session_id":"sess-%s","tools":["Edit"]}\\n' "$n"\n` +
      `printf '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-%s","result":"round %s done"}\\n' "$n" "$n"\n`,
  );
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  resetPreflightCache();
  return {
    runs: () =>
      (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
        .split('<<<END>>>\n')
        // What follows the last marker is an invocation still writing its argv: not a run yet.
        .slice(0, -1)
        .map((chunk) => chunk.split('\n').filter(Boolean))
        // The worker's runs only: not the preflight, and not the crew reviewer, which is the same binary.
        .filter((argv) => argv[0] !== '--version' && !argv.some((a) => a.startsWith('REVIEW STYLE ('))),
  };
}

function fixtureRepo(dir: string): string {
  const repo = path.join(dir, 'work-repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return repo;
}

async function settle(sched: Scheduler, until: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    await sched.tick();
    if (Date.now() > deadline) throw new Error('settle timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

for (const change of [false, true]) {
  test(`end to end: a resumed repair round ${change ? 'whose skills were changed is sent the new block with the critique' : 'with unchanged skills is sent the critique alone'}`, async () => {
    await world(async ({ base }) => {
      const stub = stubWorkerCli(base);
      const repo = fixtureRepo(base);
      const store = new Store(':memory:');
      let round = 0;
      const sched = new Scheduler(store, {
        tickMs: 5,
        maxWorkers: 1,
        verify: async ({ task, runId }) => {
          round++;
          // Between the rounds, as an operator requeueing with other skills would.
          if (round === 1 && change) setTicketSkills(store, task.id, ['docs']);
          return store.addVerdict({
            runId, taskId: task.id, disagreement: false, council: [],
            verdict: round === 1 ? 'fail' : 'pass',
            critique: round === 1 ? 'CRITIQUE-TEXT the cause was never found' : null,
          });
        },
      });
      try {
        const t = store.addTask(crew({ kind: 'code', runner: 'claude-code', repo, skills: ['debug'], maxRepairs: 2 }));
        await settle(sched, () => stub.runs().length >= 2);
        const [cold, resumed] = stub.runs().map((argv) => argv.join('\n'));
        assert.deepEqual(sections(cold!), ['debug'], 'round one: the full brief, with the ticket\'s skills');
        assert.match(resumed!, /^--resume\nsess-1\n/);
        assert.match(resumed!, /CRITIQUE-TEXT/);
        assert.ok(!resumed!.includes('TICKET-TEXT'), 'the ticket is not re-sent');
        if (change) {
          assert.deepEqual(sections(resumed!), ['docs']);
          assert.match(resumed!, /not the ones this session began with\. These replace any you were given earlier:/);
        } else {
          assert.ok(!resumed!.includes(SKILLS_HEADER) && !resumed!.includes('FULL-BODY-'), 'the session holds them already');
          // Byte-for-byte the resumed brief as it is without skills: the -p argument is exactly repairBrief.
          const expected = repairBrief({ ...store.getTask(t.id)!, repairNotes: 'CRITIQUE-TEXT the cause was never found' });
          assert.ok(resumed!.includes(`\n-p\n${expected}\n`), resumed);
        }
        await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval');
        const events = skillEvents(store, t.id).map((e) => JSON.parse(e.message));
        assert.deepEqual(events.map((e) => e.skills), [['debug'], [change ? 'docs' : 'debug']]);
        assert.deepEqual(events.map((e) => e.resumed ?? false), [false, true]);
      } finally {
        await sched.stop();
        store.close();
        resetPreflightCache();
      }
    });
  });
}

// ------------------------------------------------------------------ the planner

const envelope = (result: string): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result });

/** A stand-in for the claude CLI: records its argv and prints a canned reply. */
function stubClaude(dir: string, body: string): { prompts: () => string[] } {
  const bin = path.join(dir, 'claude');
  const bodyFile = path.join(dir, 'body.json');
  const logFile = path.join(dir, 'argv.log');
  fs.writeFileSync(bodyFile, body);
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${logFile}"; done\nprintf '<<<END>>>\\n' >> "${logFile}"\ncat "${bodyFile}"\n`,
  );
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  return {
    prompts: () =>
      (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
        .split('<<<END>>>\n')
        .filter((chunk) => chunk.trim())
        .map((chunk) => {
          const argv = chunk.split('\n');
          return argv.slice(argv.indexOf('-p') + 1).join('\n');
        }),
  };
}

const ticket = (ref: string, role: string, skills?: unknown): Record<string, unknown> => ({
  ref, title: `Ticket ${ref}`, prompt: `Do the work of ${ref} in the code.`, role, kind: 'code', after: [],
  acceptance: `${ref} is done and tested`, testCmd: null, points: 2, ...(skills === undefined ? {} : { skills }),
});

const PLAN_REPLY = JSON.stringify({
  epic: { title: 'Fix the crash', summary: 'find it, fix it, document it' },
  tickets: [
    ticket('t1', 'dev', ['debug']),
    ticket('t2', 'dev', ['debug', 'no-such-skill']),
    ticket('t3', 'dev', ['debug', 'docs', 'one']),
    ticket('t4', 'lead', ['debug']),
    ticket('t5', 'dev'),
    ticket('t6', 'dev', 'debug'),
  ],
});

async function withDaemon<T>(store: Store, fn: (base: string, port: number) => Promise<T>): Promise<T> {
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
  }
}

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

/** Run the CLI as a child against the daemon on `port`; never the operator's. */
async function cli(port: number, argv: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ticket-skills-cli-'));
  try {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, FOREMAN_HOME: home, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    return { code, stdout, stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a plan\'s ticket skills: valid ones are stored, an invalid, a third and a wrong-role name are dropped with a visible warning, and the plan still queues', async () => {
  await world(async ({ base }) => {
    stubClaude(base, envelope(PLAN_REPLY));
    const store = new Store(':memory:');
    try {
      await withDaemon(store, async (url, port) => {
        const res = await fetch(`${url}/api/build`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ask: 'fix the crash in the code', playbook: 'soft', auto: true, runner: 'echo', check: false }),
        });
        const body = await res.json();
        assert.equal(res.status, 201, JSON.stringify(body));

        const planned = Object.fromEntries(body.plan.tickets.map((t: { ref: string; skills?: string[] }) => [t.ref, t.skills ?? null]));
        assert.deepEqual(planned, { t1: ['debug'], t2: ['debug'], t3: ['debug', 'docs'], t4: null, t5: null, t6: null });

        const dropped = (body.findings as Array<{ level: string; code: string; ticket?: string; message: string }>).filter((f) => f.code === 'skill-dropped');
        assert.ok(dropped.every((f) => f.level === 'warn'), 'a warning, never a blocker: the plan queued under --auto');
        assert.deepEqual(dropped.map((f) => f.ticket), ['t2', 't3', 't4', 't6']);
        assert.match(dropped[0]!.message, /skill no-such-skill refused — not in the allowed list for soft\.dev; soft\.dev may carry: one, two, debug, docs, foreign/);
        assert.match(dropped[1]!.message, /skill one refused — over the limit of 2 skills per ticket/);
        assert.match(dropped[2]!.message, /skill debug refused — not in the allowed list for soft\.lead; soft\.lead may carry: review/);
        assert.match(dropped[3]!.message, /skills must be a list of skill names/);

        // What reached the database is what the plan showed.
        const stored = Object.fromEntries((body.queued as Task[]).map((t) => [t.title, store.getTask(t.id)!.skills ?? null]));
        assert.deepEqual(stored, {
          'Ticket t1': ['debug'], 'Ticket t2': ['debug'], 'Ticket t3': ['debug', 'docs'],
          'Ticket t4': null, 'Ticket t5': null, 'Ticket t6': null,
        });
        assert.equal(body.epic.skills ?? null, null, 'the container carries none');

        // The printed plan shows each ticket's skills and the warnings.
        const shown = await cli(port, ['build', 'fix the crash in the code', '--playbook', 'soft', '--no-check']);
        assert.equal(shown.code, 0, shown.stderr);
        assert.match(shown.stdout, /t1 .*Ticket t1\n(?: +(?:after|accept):.*\n)* +skills: debug\n/);
        assert.match(shown.stdout, /t3 .*Ticket t3\n(?: +(?:after|accept):.*\n)* +skills: debug, docs\n/);
        assert.doesNotMatch(shown.stdout, /Ticket t5\n(?: +(?:after|accept):.*\n)* +skills:/, 'a ticket on its role default prints no skills line');
        assert.match(shown.stdout, /plan check:\n(?:.*\n)*? {2}\[warn\] skill-dropped \(t2\): skill no-such-skill refused/);

        // And `foreman show` prints a ticket's own list, or its role's default.
        const idOf = (title: string): string => (body.queued as Task[]).find((t) => t.title === title)!.id;
        const own = await cli(port, ['show', idOf('Ticket t3')]);
        assert.match(own.stdout, /^Ticket t3\n.*\nskills: debug, docs \(named on the ticket\)\n\n/);
        const usual = await cli(port, ['show', idOf('Ticket t5')]);
        assert.match(usual.stdout, /^Ticket t5\n.*\nskills: role default: one, two\n\n/);
        const off = await cli(port, ['show', idOf('Ticket t5')], { FOREMAN_SKILLS_DIR: '' });
        assert.match(off.stdout, /^Ticket t5\n.*\n\n/, 'no skills dir in this shell: no line, and the output is what it was');
        assert.doesNotMatch(off.stdout, /^skills:/m);
      });
    } finally {
      store.close();
    }
  });
});

test('a plan handed in over the wire is checked the same way, and with skills off every name is dropped with the reason', async () => {
  await world(() => {
    const wire = { ask: 'fix the crash', playbook: 'soft', tickets: JSON.parse(PLAN_REPLY).tickets };
    const on = parseCrewPlan(wire);
    assert.deepEqual(on.tickets.map((t) => t.skills ?? null), [['debug'], ['debug'], ['debug', 'docs'], null, null, null]);

    delete process.env['FOREMAN_SKILLS_DIR'];
    const off = parseCrewPlan(wire);
    assert.ok(off.tickets.every((t) => t.skills === undefined), 'off: no ticket carries a list');
    const warned = off.findings.filter((f) => f.code === 'skill-dropped');
    assert.ok(warned.length >= 4 && warned.every((f) => /skills are off|must be a list/.test(f.message)), JSON.stringify(warned));
    // A plan that names no skills has no such finding, on or off.
    const quiet = parseCrewPlan({ ...wire, tickets: [ticket('t1', 'dev')] });
    assert.deepEqual(quiet.findings.filter((f) => f.code === 'skill-dropped'), []);
  });
});

test('a clone of an epic keeps each ticket\'s skills; a name that stopped passing since is dropped at queue time with a warning on the ticket', async () => {
  await world(({ root }) => {
    const store = new Store(':memory:');
    try {
      const plan = parseCrewPlan({ ask: 'fix the crash', playbook: 'soft', tickets: [ticket('t1', 'dev', ['debug', 'docs']), ticket('t2', 'dev')] });
      const first = queueCrewPlan(store, plan, { runner: 'echo' });
      assert.deepEqual(first.tickets.map((t) => t.skills ?? null), [['debug', 'docs'], null]);

      const clone = cloneEpic(store, first.epic.id);
      assert.deepEqual(clone.tickets.map((t) => t.skills ?? null), [['debug', 'docs'], null]);

      writeSkill(root, 'docs', ['soft.dev'], { status: 'retired' });
      clearSkillCache();
      const second = queueCrewPlan(store, clone, { runner: 'echo' });
      assert.deepEqual(second.tickets.map((t) => t.skills ?? null), [['debug'], null], 'queued, with what still passes');
      const warnings = store.eventsForTask(second.tickets[0]!.id).filter((e) => e.type === 'warning');
      assert.match(warnings[0]!.message, /skill docs refused — refused at load .*queued without it/);
    } finally {
      store.close();
    }
  });
});

test('the planner prompt lists each role\'s choices and their `when` lines only with skills on; off, the prompt is what it was', async () => {
  await world(async ({ base, pb }) => {
    const stub = stubClaude(base, envelope(PLAN_REPLY));
    const store = new Store(':memory:');
    try {
      const playbook = pb();
      const section = planSkillsBrief(playbook);
      assert.match(section, /^TICKET SKILLS: /);
      assert.match(section, /Add "skills":\["name"\] to a ticket ONLY when its nature differs from its role's default/);
      assert.match(section, /at most 2, from its own role's list below; they REPLACE the default\. Otherwise omit the field\./);
      assert.match(section, /^- dev: default one, two; may carry instead debug, docs$/m, 'only what the role would really be served: `foreign` does not list dev');
      assert.match(section, /^- debug: Use debug when the ticket calls for it\.$/m);
      assert.doesNotMatch(section, /^- lead:/m, 'a role with nothing to choose is not listed');
      assert.doesNotMatch(section, /unlisted|foreign/);

      await crewPlan({ ask: 'fix the crash in the code', store, playbook: 'soft' });
      delete process.env['FOREMAN_SKILLS_DIR'];
      assert.equal(planSkillsBrief(playbook), '');
      await crewPlan({ ask: 'fix the crash in the code', store, playbook: 'soft' });

      const [on, off] = stub.prompts();
      assert.ok(on!.includes(section), 'on: the section is in the prompt the owner is sent');
      assert.ok(!off!.includes('TICKET SKILLS'));
      assert.equal(on!.replace(section, ''), off, 'off: byte-for-byte the prompt without the section');
      // Static text, ahead of the per-ask part, so the prompt-cache prefix holds.
      assert.ok(on!.indexOf('TICKET SKILLS') < on!.indexOf('REQUEST: '));
    } finally {
      store.close();
    }
  });
});

test('the planner section is bounded whatever the catalogue holds, gives way in a fixed order, and says so in the plan check once it loses what the planner chooses by', async () => {
  await world(async ({ base, root, pbDir }) => {
    const roles = ['lead', 'dev', 'qa', 'writer', 'architect'];
    fs.writeFileSync(path.join(pbDir, 'soft.md'), pbText({ roles: Object.fromEntries(roles.map((r) => [r, { tier: r === 'lead' ? 'senior' : 'worker' }])) })
      + roles.filter((r) => r !== 'lead' && r !== 'dev').map((r) => `\n## role: ${r}\n\nYou are the ${r}.\n`).join(''));
    clearPlaybookCache();
    const playbook = getPlaybook('soft');
    assert.ok(playbook, JSON.stringify(loadPlaybooks().refused));
    const when = `${'This is a long description of when the skill applies, with detail. '.repeat(2)}END`;
    /** A catalogue of `count` skills every role may carry, each role defaulting to two of them. */
    const catalogue = (count: number, name: (i: number) => string): string[] => {
      fs.rmSync(path.join(root, 'skills'), { recursive: true });
      const names = Array.from({ length: count }, (_, i) => name(i + 1));
      for (const n of names) writeSkill(root, n, roles.map((r) => `soft.${r}`), { when });
      writeLoadouts(root, Object.fromEntries(roles.map((r, i) => [`soft.${r}`, { default: names.slice(i, i + 2), allowed: names }])));
      clearSkillCache();
      return names;
    };
    const measured = (): { text: string; lost: string | null; bytes: number } => {
      const out = planSkillsSection(playbook);
      const bytes = Buffer.byteLength(out.text);
      assert.ok(bytes <= PLAN_SKILLS_MAX_BYTES, `${bytes} bytes`);
      return { ...out, bytes };
    };
    // A ceiling on growth, not the cap itself: the section sits in every plan prompt, so it must stay small.
    assert.ok(PLAN_SKILLS_MAX_BYTES <= 4_096);

    // Step 0 — it all fits: every role, every `when` whole (the defaults' too).
    let names = catalogue(3, (i) => `s${i}`);
    let out = measured();
    assert.equal(out.lost, null);
    assert.equal((out.text.match(/END$/gm) ?? []).length, 3);

    // Steps 1-2 — the defaults' lines go, then whole entries from the end: none is cut, one line counts what is not shown.
    names = catalogue(11, (i) => `s${i}`);
    out = measured();
    assert.ok(out.text.includes('USE A SKILL WHEN:'), out.text);
    for (const r of roles) assert.match(out.text, new RegExp(`^- ${r}: default `, 'm'));
    const shownWhens = out.text.match(/^- s\d+: .*$/gm) ?? [];
    assert.ok(shownWhens.length > 0 && shownWhens.every((l) => l.endsWith('END')), out.text);
    assert.match(out.text, new RegExp(`^\\(${11 - shownWhens.length} more not shown\\)$`, 'm'));
    assert.match(out.lost!, /did not fit in 2048 bytes: \d+ `when` line\(s\) were left out, so the planner chose those skills by name alone$/);

    // Step 3 — no `when` line fits: all go, every role is still listed, and it is reported.
    names = catalogue(30, (i) => `skill-${String(i).padStart(2, '0')}`);
    out = measured();
    assert.ok(!out.text.includes('USE A SKILL WHEN:'));
    assert.match(out.text, /^\(\d+ more not shown\)$/m);
    for (const r of roles) assert.match(out.text, new RegExp(`^- ${r}: default `, 'm'));
    assert.match(out.lost!, /did not fit in 2048 bytes: every `when` line was left out, so the planner chose skills by name alone$/);

    // Step 4 — the role lines alone are too much: roles go from the end of the playbook's order, by name.
    names = catalogue(30, (i) => `skill-number-${String(i).padStart(2, '0')}-with-a-long-name`);
    out = measured();
    assert.ok(out.bytes > 0);
    assert.match(out.text, /^- lead: default /m);
    assert.doesNotMatch(out.text, /^- (dev|qa|writer|architect): /m);
    assert.match(out.text, /^\(4 more role\(s\) not listed: their default applies\)$/m);
    assert.match(out.lost!, /was not told what dev, qa, writer, architect may carry \(their tickets get the role default\)$/);
    assert.equal(planSkillsBrief(playbook), out.text);

    // The plan says so: a warning in the plan check, which `foreman build` prints. And a skill named for a
    // role the prompt did not list is still checked the ordinary way.
    stubClaude(base, envelope(JSON.stringify({ epic: { title: 'x', summary: 'y' }, tickets: [ticket('t1', 'qa', [names[5]])] })));
    const store = new Store(':memory:');
    try {
      const plan = await crewPlan({ ask: 'fix the crash in the code', store, playbook: 'soft' });
      const trimmed = plan.findings.filter((f) => f.code === 'skills-prompt-trimmed');
      assert.equal(trimmed.length, 1);
      assert.equal(trimmed[0]!.level, 'warn');
      assert.equal(trimmed[0]!.message, out.lost);
      assert.deepEqual(plan.tickets[0]!.skills, [names[5]]);

      // Nothing lost, nothing said.
      catalogue(3, (i) => `s${i}`);
      const quiet = await crewPlan({ ask: 'fix the crash in the code', store, playbook: 'soft' });
      assert.deepEqual(quiet.findings.filter((f) => f.code === 'skills-prompt-trimmed'), []);
    } finally {
      store.close();
    }
  });
});

/** The planner section for a dev role that defaults to its first two of `count` skills and may carry all of them, each with a 130-character `when`. */
async function menuFor(count: number, fn: (out: { text: string; lost: string | null }, whenOf: (n: number) => string) => void): Promise<void> {
  await world(({ root }) => {
    fs.rmSync(path.join(root, 'skills'), { recursive: true });
    const whenOf = (i: number): string => `Pick m${i} when the ticket needs it, and say why in one clause. ${'x'.repeat(130 - 55)}`;
    const names = Array.from({ length: count }, (_, i) => `m${i + 1}`);
    names.forEach((n, i) => writeSkill(root, n, ['soft.dev'], { when: whenOf(i + 1) }));
    writeLoadouts(root, { 'soft.dev': { default: names.slice(0, 2), allowed: names } });
    clearSkillCache();
    clearPlaybookCache();
    const playbook = getPlaybook('soft');
    assert.ok(playbook, JSON.stringify(loadPlaybooks().refused));
    fn(planSkillsSection(playbook), whenOf);
  });
}

test('no when line in the planner section is ever cut, however many skills there are', async () => {
  for (const count of [3, 8, 14, 30]) {
    await menuFor(count, (out, whenOf) => {
      const lines = out.text.match(/^- m\d+: .*$/gm) ?? [];
      assert.ok(lines.length > 0, `${count} skills: ${out.text}`);
      for (const line of lines) {
        const i = Number(/^- m(\d+):/.exec(line)![1]);
        assert.equal(line, `- m${i}: ${whenOf(i)}`, `${count} skills`);
      }
    });
  }
});

test('when the planner section does not fit, whole entries are dropped and one line says how many are not shown', async () => {
  await menuFor(14, (out) => {
    const shown = (out.text.match(/^- m\d+: .*$/gm) ?? []).length;
    // m1 and m2 are the role's default (their lines go first); the 12 others are the entries.
    assert.ok(shown > 0 && shown < 12, out.text);
    assert.match(out.text, new RegExp(`^\\(${12 - shown} more not shown\\)$`, 'm'));
    assert.ok(out.lost?.includes('left out'), String(out.lost));
  });
  // Nothing dropped, nothing said.
  await menuFor(3, (out) => {
    assert.doesNotMatch(out.text, /more not shown/);
    assert.equal(out.lost, null);
  });
});

test('a catalogue sized like the real one (9 extras, 78-character when lines) is listed whole: nothing left out, nothing cut, no trim finding', async () => {
  await world(async ({ base, root, pbDir }) => {
    const roles = ['lead', 'dev', 'qa', 'writer', 'architect'];
    fs.writeFileSync(path.join(pbDir, 'soft.md'), pbText({ roles: Object.fromEntries(roles.map((r) => [r, { tier: r === 'lead' ? 'senior' : 'worker' }])) })
      + roles.filter((r) => r !== 'lead' && r !== 'dev').map((r) => `\n## role: ${r}\n\nYou are the ${r}.\n`).join(''));
    clearPlaybookCache();
    const playbook = getPlaybook('soft');
    assert.ok(playbook, JSON.stringify(loadPlaybooks().refused));
    fs.rmSync(path.join(root, 'skills'), { recursive: true });
    const whenOf = (i: number): string => `Pick k${String(i).padStart(2, '0')} when the ticket needs it. ${'x'.repeat(78 - 35)}`;
    assert.equal(whenOf(1).length, 78);
    const names = Array.from({ length: 11 }, (_, i) => `k${String(i + 1).padStart(2, '0')}`);
    names.forEach((n, i) => writeSkill(root, n, roles.map((r) => `soft.${r}`), { when: whenOf(i + 1) }));
    writeLoadouts(root, Object.fromEntries(roles.map((r) => [`soft.${r}`, { default: names.slice(0, 2), allowed: names }])));
    clearSkillCache();

    const out = planSkillsSection(playbook);
    const bytes = Buffer.byteLength(out.text);
    // Over the old 1,600-byte cap, so this fails if the cap goes back down.
    assert.ok(bytes > 1_600 && bytes <= PLAN_SKILLS_MAX_BYTES, `${bytes} bytes`);
    assert.equal(out.lost, null);
    assert.doesNotMatch(out.text, /more not shown|more role\(s\) not listed/);
    for (const r of roles) assert.match(out.text, new RegExp(`^- ${r}: default `, 'm'));
    for (const [i, n] of names.entries()) assert.ok(out.text.includes(`- ${n}: ${whenOf(i + 1)}\n`), `${n} whole`);

    stubClaude(base, envelope(JSON.stringify({ epic: { title: 'x', summary: 'y' }, tickets: [ticket('t1', 'qa', [names[5]!])] })));
    const store = new Store(':memory:');
    try {
      const plan = await crewPlan({ ask: 'fix the crash in the code', store, playbook: 'soft' });
      assert.deepEqual(plan.findings.filter((f) => f.code === 'skills-prompt-trimmed'), []);
    } finally {
      store.close();
    }
  });
});

test('the planner section stays within its cap at every catalogue size', async () => {
  for (const count of [3, 8, 14, 30, 60]) {
    await menuFor(count, (out) => {
      assert.ok(Buffer.byteLength(out.text) <= PLAN_SKILLS_MAX_BYTES, `${count} skills: ${Buffer.byteLength(out.text)} bytes`);
    });
  }
});

// ------------------------------------------------------- follow-ups do not inherit

test('a follow-up a reviewer files carries exactly the reviewed ticket\'s skills, not its role default', async () => {
  await world(async ({ base }) => {
    stubClaude(base, envelope(JSON.stringify({
      verdict: 'pass', critique: 'fine, but one thing is left',
      issues: [{ title: 'Write it up', prompt: 'document the cause', severity: 'normal', role: 'dev' }],
    })));
    const store = new Store(':memory:');
    try {
      const parent = store.addTask(crew({ kind: 'code', runner: 'claude-code', skills: ['debug'] }));
      const runId = store.startRun(parent.id).id;
      const out = await crewReview({ task: store.getTask(parent.id)!, runId, store, diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n' });
      assert.equal(out!.filed.length, 1, JSON.stringify(out));
      const child = store.childrenOf(parent.id)[0]!;
      assert.equal(child.title, 'Write it up');
      assert.equal(child.role, 'dev');
      assert.deepEqual(child.skills, ['debug'], 'the parent was a debugging ticket; its follow-up is too');
      assert.deepEqual(sections(briefFor(store, child)), sections(briefFor(store, store.getTask(parent.id)!)));
      assert.deepEqual(store.getTask(parent.id)!.skills, ['debug']);
    } finally {
      store.close();
    }
  });
});

// ------------------------------------------------- the daemon's add and retry routes

const postJson = async (url: string, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

/** A crew ticket parked by a human assignee, so nothing runs it while the test looks at it. */
const parked = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'crew ticket', prompt: 'TICKET-TEXT build the thing', runner: 'echo', role: 'dev', playbook: 'soft', assignee: 'human', ...over,
});

test('POST /api/tasks: a valid list is stored and shown; a refused one is a 400 with the reason and no ticket; a non-list is a 400', async () => {
  await world(async () => {
    const store = new Store(':memory:');
    try {
      await withDaemon(store, async (url, port) => {
        const made = await postJson(`${url}/api/tasks`, parked({ skills: ['debug', 'docs'] }));
        assert.equal(made.status, 201, JSON.stringify(made.body));
        assert.deepEqual(made.body.skills, ['debug', 'docs']);
        assert.deepEqual(store.getTask(made.body.id)!.skills, ['debug', 'docs']);
        const shown = await (await fetch(`${url}/api/tasks/${made.body.id}`)).json();
        assert.deepEqual(shown.task.skills, ['debug', 'docs']);
        assert.match((await cli(port, ['show', made.body.id])).stdout, /\nskills: debug, docs \(named on the ticket\)\n/);

        // Absent and null both mean the role default, as before.
        for (const none of [{}, { skills: null }]) {
          const plain = await postJson(`${url}/api/tasks`, parked(none));
          assert.equal(plain.status, 201);
          assert.equal(plain.body.skills, null);
        }
        const before = store.listTasks().length;

        const refusals: Array<[unknown, RegExp]> = [
          [['no-such-skill'], /skill no-such-skill refused — not in the allowed list for soft\.dev; soft\.dev may carry: one, two, debug, docs, foreign \(at most 2\)/],
          [['unlisted'], /skill unlisted refused — not in the allowed list for soft\.dev/],
          [['foreign'], /skill foreign refused — the skill does not list soft\.dev in its roles/],
          [['debug', 'docs', 'one'], /skill one refused — over the limit of 2 skills per ticket/],
          [['debug', 'typo'], /skill typo refused/],
        ];
        for (const [skills, says] of refusals) {
          const r = await postJson(`${url}/api/tasks`, parked({ skills }));
          assert.equal(r.status, 400, JSON.stringify(r.body));
          assert.match(r.body.error, says);
        }
        for (const skills of ['debug', { a: 1 }, ['debug', 7], 7, true]) {
          const r = await postJson(`${url}/api/tasks`, parked({ skills }));
          assert.equal(r.status, 400, JSON.stringify(skills));
          assert.equal(r.body.error, 'skills must be a list of skill names');
        }
        assert.equal(store.listTasks().length, before, 'no refused request left a ticket behind, with or without its list');

        // The CLI, end to end against the real handler.
        const ok = await cli(port, ['add', 'fix the crash', '--playbook', 'soft', '--role', 'dev', '--assignee', 'human', '--skills', 'debug']);
        assert.equal(ok.code, 0, ok.stderr);
        assert.match(ok.stdout, /^t_\w+  awaiting-human  fix the crash  skills: debug\n$/);
        assert.deepEqual(store.getTask(ok.stdout.split(' ')[0]!)!.skills, ['debug']);
        const bad = await cli(port, ['add', 'fix the crash', '--playbook', 'soft', '--role', 'dev', '--skills', 'debug,nope']);
        assert.equal(bad.code, 1);
        assert.match(bad.stderr, /skill nope refused — not in the allowed list for soft\.dev/);
        assert.equal(store.listTasks().length, before + 1);

        // Off: refused with the reason, nothing queued.
        delete process.env['FOREMAN_SKILLS_DIR'];
        const off = await postJson(`${url}/api/tasks`, parked({ skills: ['debug'] }));
        assert.equal(off.status, 400);
        assert.match(off.body.error, /skill debug refused — skills are off \(FOREMAN_SKILLS_DIR is not set/);
        assert.equal(store.listTasks().length, before + 1);
      });
    } finally {
      store.close();
    }
  });
});

test('POST /api/tasks/:id/retry: a list changes the ticket\'s skills, "default" clears them, no key leaves them; a refused list leaves the ticket unchanged and not requeued', async () => {
  await world(async () => {
    const store = new Store(':memory:');
    try {
      await withDaemon(store, async (url, port) => {
        const t = store.addTask(crew({ assignee: 'human', skills: ['debug'] }));
        const retry = (body: unknown): Promise<{ status: number; body: any }> => postJson(`${url}/api/tasks/${t.id}/retry`, body);
        const end = (): void => {
          store.cancel(t.id);
          assert.equal(store.getTask(t.id)!.status, 'canceled');
        };
        const now = (): Task => store.getTask(t.id)!;
        end();

        // Changed, requeued, and the next brief carries them.
        const set = await retry({ skills: ['docs', 'one'], note: 'it wants writing up' });
        assert.equal(set.status, 200, JSON.stringify(set.body));
        assert.deepEqual(set.body.skills, ['docs', 'one']);
        assert.notEqual(now().status, 'canceled', 'requeued');
        assert.deepEqual(sections(briefFor(store, now())), ['docs', 'one']);
        assert.match(briefFor(store, now()), /it wants writing up/, 'the note went with it');

        // No key: the list is left as it is.
        end();
        const kept = await retry({ note: 'again' });
        assert.equal(kept.status, 200);
        assert.deepEqual(now().skills, ['docs', 'one']);
        end();
        assert.deepEqual((await retry({})).body.skills, ['docs', 'one']);

        // A refused list: 400 with the reason, and the ticket exactly as it was — still ended, same skills.
        end();
        const stamp = now().updatedAt;
        const refusals: Array<[unknown, RegExp]> = [
          [['nope'], /skill nope refused — not in the allowed list for soft\.dev; soft\.dev may carry: one, two, debug, docs, foreign/],
          [['debug', 'docs', 'one'], /over the limit of 2 skills per ticket/],
          [['foreign'], /does not list soft\.dev in its roles/],
          ['debug', /^skills must be a list of skill names, or "default"$/],
          [['debug', 7], /^skills must be a list of skill names, or "default"$/],
          [{ a: 1 }, /^skills must be a list of skill names, or "default"$/],
        ];
        for (const [skills, says] of refusals) {
          const r = await retry({ skills, note: 'must not land either' });
          assert.equal(r.status, 400, JSON.stringify(r.body));
          assert.match(r.body.error, says);
          assert.equal(now().status, 'canceled', 'not requeued');
          assert.deepEqual(now().skills, ['docs', 'one']);
          assert.equal(now().updatedAt, stamp, 'nothing about the ticket moved');
          assert.ok(!now().repairNotes?.includes('must not land either'), 'no half of the retry was applied');
        }

        // "default" (and null, which is what the CLI sends for it) clears the list.
        for (const clear of ['default', null]) {
          setTicketSkills(store, t.id, ['debug']);
          const cleared = await retry({ skills: clear });
          assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
          assert.equal(cleared.body.skills, null);
          assert.deepEqual(sections(briefFor(store, now())), ['one', 'two']);
          end();
        }

        // The CLI, end to end against the real handler.
        const viaCli = await cli(port, ['retry', t.id, '--skills', 'debug']);
        assert.equal(viaCli.code, 0, viaCli.stderr);
        // The second line is the ledger's confirmation of the retry (test/ledger-records.test.ts).
        assert.match(viaCli.stdout, /→ \S+  skills: debug\nrecorded d_\w+: retry by human; → \S+; no note\n$/);
        assert.deepEqual(now().skills, ['debug']);
        end();
        const cliDefault = await cli(port, ['retry', t.id, '--skills', 'default']);
        assert.equal(cliDefault.code, 0, cliDefault.stderr);
        assert.equal(now().skills, null);
        end();
        const cliBad = await cli(port, ['retry', t.id, '--skills', 'nope']);
        assert.equal(cliBad.code, 1);
        assert.match(cliBad.stderr, /skill nope refused/);
        assert.equal(now().status, 'canceled');

        // A ticket that is not ended is refused as it always was, before its skills are looked at.
        const live = store.addTask(crew({ assignee: 'human' }));
        const early = await postJson(`${url}/api/tasks/${live.id}/retry`, { skills: ['debug'] });
        assert.equal(early.status, 409);
        assert.equal(store.getTask(live.id)!.skills, null);

        // Off: a list is refused with the reason and nothing is requeued; a retry that names none still works.
        delete process.env['FOREMAN_SKILLS_DIR'];
        const off = await retry({ skills: ['debug'] });
        assert.equal(off.status, 400);
        assert.match(off.body.error, /skill debug refused — skills are off/);
        assert.equal(now().status, 'canceled');
        assert.equal((await retry({})).status, 200);
      });
    } finally {
      store.close();
    }
  });
});

// ------------------------------------------------------------- the CLI flags

interface Seen { method: string; url: string; body: string }

/** A stub daemon: answers each request with what `reply` returns, and records what it was sent. */
async function withStub<T>(
  reply: (req: Seen) => { status?: number; json: unknown },
  fn: (port: number, seen: Seen[]) => Promise<T>,
): Promise<T> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', body };
      seen.push(entry);
      const out = reply(entry);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn((server.address() as AddressInfo).port, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('foreman add --skills sends the list, and prints it once the daemon has stored it', async () => {
  await withStub(
    (req) => ({ json: { id: 't_new', status: 'queued', title: 'fix it', skills: JSON.parse(req.body || '{}').skills ?? null } }),
    async (port, seen) => {
      const r = await cli(port, ['add', 'fix it', '--playbook', 'soft', '--role', 'dev', '--skills', 'debug, docs']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.length, 1);
      const sent = JSON.parse(seen[0]!.body);
      assert.deepEqual(sent.skills, ['debug', 'docs']);
      assert.equal(sent.role, 'dev');
      assert.equal(sent.playbook, 'soft');
      assert.equal(r.stdout, 't_new  queued  fix it  skills: debug, docs\n');

      // Without the flag the request and the line are what they were.
      const plain = await cli(port, ['add', 'fix it']);
      assert.equal(plain.stdout, 't_new  queued  fix it\n');
      assert.ok(!('skills' in JSON.parse(seen[1]!.body)));
    },
  );
});

test('foreman add --skills: a daemon that refuses is quoted; one that queues the ticket without the list has it canceled, loudly', async () => {
  const refusal = 'skill nope refused — not in the allowed list for soft.dev; soft.dev may carry: one, two, debug (at most 2)';
  await withStub(() => ({ status: 400, json: { error: refusal } }), async (port, seen) => {
    const r = await cli(port, ['add', 'fix it', '--playbook', 'soft', '--role', 'dev', '--skills', 'nope']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(refusal), r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(seen.length, 1, 'refused by the daemon: nothing to cancel');
  });

  // A daemon that does not know the field: it queues the ticket and drops the list unseen.
  await withStub(
    (req) => ({ json: req.url.endsWith('/cancel') ? { id: 't_new', status: 'canceled' } : { id: 't_new', status: 'queued', title: 'fix it' } }),
    async (port, seen) => {
      const r = await cli(port, ['add', 'fix it', '--playbook', 'soft', '--role', 'dev', '--skills', 'debug']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /did not store --skills for t_new/);
      assert.match(r.stderr, /t_new was canceled so it cannot run on the wrong skills/);
      assert.equal(r.stdout, '', 'the ticket is not reported as queued');
      assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ['POST /api/tasks', 'POST /api/tasks/t_new/cancel']);
    },
  );

  // Malformed flags never reach the daemon.
  await withStub(() => ({ json: {} }), async (port, seen) => {
    for (const argv of [['add', 'fix it', '--skills'], ['add', 'fix it', '--skills', ' , ']]) {
      const r = await cli(port, argv);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /--skills takes one or two skill names/);
    }
    assert.equal(seen.length, 0);
  });
});

test('foreman retry --skills changes or clears the list on the requeue, and checks the daemon took it', async () => {
  let stored: string[] | null = ['one'];
  await withStub(
    (req) => {
      if (req.url.endsWith('/cancel')) return { json: { id: 't_x', status: 'canceled' } };
      const body = JSON.parse(req.body || '{}');
      if ('skills' in body) stored = body.skills;
      return { json: { id: 't_x', status: 'queued', skills: stored } };
    },
    async (port, seen) => {
      const set = await cli(port, ['retry', 't_x', '--skills', 'debug', '--note', 'it is a bug, not a feature']);
      assert.equal(set.code, 0, set.stderr);
      assert.equal(seen[0]!.url, '/api/tasks/t_x/retry');
      assert.deepEqual(JSON.parse(seen[0]!.body), { note: 'it is a bug, not a feature', skills: ['debug'] });
      // This stub answers without a decision record, which the CLI says on a second line.
      assert.match(set.stdout, /^t_x → queued  skills: debug\nNOT RECORDED: [^\n]*\n$/);

      const cleared = await cli(port, ['retry', 't_x', '--skills', 'default']);
      assert.equal(cleared.code, 0, cleared.stderr);
      assert.deepEqual(JSON.parse(seen[1]!.body), { skills: null });
      assert.match(cleared.stdout, /^t_x → queued  skills: role default\nNOT RECORDED: [^\n]*\n$/);

      // No flag: the body is what it always was, and the list is left alone.
      const plain = await cli(port, ['retry', 't_x', '--note', 'again']);
      assert.deepEqual(JSON.parse(seen[2]!.body), { note: 'again' });
      assert.match(plain.stdout, /^t_x → queued\nNOT RECORDED: [^\n]*\n$/);

      // --skills belongs to retry only; a reopen is refused before any request.
      const reopen = await cli(port, ['reopen', 't_x', '--skills', 'debug']);
      assert.equal(reopen.code, 1);
      assert.match(reopen.stderr, /--skills goes with retry/);
      assert.equal(seen.length, 3);
    },
  );

  // A daemon that requeues without taking the list.
  await withStub(
    (req) => ({ json: req.url.endsWith('/cancel') ? { id: 't_x', status: 'canceled' } : { id: 't_x', status: 'queued', skills: ['one'] } }),
    async (port, seen) => {
      const r = await cli(port, ['retry', 't_x', '--skills', 'debug']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /did not store --skills for t_x \(it holds: one\)/);
      assert.deepEqual(seen.map((s) => s.url), ['/api/tasks/t_x/retry', '/api/tasks/t_x/cancel']);
    },
  );
});
