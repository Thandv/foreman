import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG_TTL_MS, clearAgentCache, getAgent, loadCatalog } from '../src/agents.ts';
import {
  clearPersonaCache, loadPersonas, PERSONA_TTL_MS, personaForTask, savePersona, seedPersonas,
} from '../src/align/personas.ts';

/**
 * A `frisk-scan` stand-in, first on PATH, that appends one line to a log per
 * invocation and reports no findings. admit() spawns it once per manifest it
 * scans, so the line count is the number of admission scans that really ran.
 */
function friskCounter(t: TestContext): () => number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cache-frisk-'));
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'frisk-scan');
  fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho scan >> "${log}"\necho '{"findings":[]}'\n`);
  fs.chmodSync(bin, 0o755);
  const before = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${before ?? ''}`;
  t.after(() => {
    process.env['PATH'] = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
}

/** Rewrite a manifest with new content AND a new mtime, whatever the clock's resolution. */
function edit(file: string, text: string): void {
  const old = fs.statSync(file).mtimeMs;
  fs.writeFileSync(file, text);
  const later = new Date(old + 5_000);
  fs.utimesSync(file, later, later);
}

// ---------------------------------------------------------------- personas

/** A temp personas dir holding three seed manifests. */
function personasFixture(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cache-personas-'));
  const before = process.env['FOREMAN_PERSONAS_DIR'];
  process.env['FOREMAN_PERSONAS_DIR'] = dir;
  t.after(() => {
    if (before === undefined) delete process.env['FOREMAN_PERSONAS_DIR'];
    else process.env['FOREMAN_PERSONAS_DIR'] = before;
    clearPersonaCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const p of seedPersonas().slice(0, 3)) savePersona(p);
  assert.equal(fs.readdirSync(dir).length, 3);
  clearPersonaCache();
  return dir;
}

test('loadPersonas: 50 calls over 3 unchanged manifests run 3 admission scans and return one object', (t) => {
  personasFixture(t);
  const scans = friskCounter(t);

  const results = Array.from({ length: 50 }, () => loadPersonas());
  assert.equal(results[0]!.personas.length, 3);
  assert.equal(scans(), 3, 'one frisk-scan per manifest, not per call');
  assert.ok(results.every((r) => r === results[0]), 'a hit returns the same object');
});

test('loadPersonas: an edited manifest (content and mtime) is re-scanned on the next call', (t) => {
  const dir = personasFixture(t);
  const scans = friskCounter(t);

  const first = loadPersonas();
  assert.equal(scans(), 3);
  const file = path.join(dir, 'publishing.author.md');
  edit(file, fs.readFileSync(file, 'utf8').replace(/"description": "[^"]*"/, '"description": "Edited on disk."'));

  const second = loadPersonas();
  assert.notEqual(second, first, 'a changed fingerprint is a miss');
  assert.equal(scans(), 6, 'the directory was scanned again');
  assert.equal(second.personas.find((p) => p.id === 'publishing.author')!.description, 'Edited on disk.');
  assert.equal(loadPersonas(), second, 'and the fresh catalog is cached in turn');
  assert.equal(scans(), 6);
});

test('loadPersonas: a deleted manifest is gone from the next result', (t) => {
  const dir = personasFixture(t);
  friskCounter(t);

  assert.ok(loadPersonas().personas.some((p) => p.id === 'publishing.author'));
  fs.rmSync(path.join(dir, 'publishing.author.md'));

  const after = loadPersonas();
  assert.deepEqual(after.personas.map((p) => p.id).sort(), ['publishing.copyeditor', 'publishing.dev-editor']);
  assert.equal(loadPersonas(), after, 'the smaller catalog is the cached one now');
});

test('loadPersonas: an added manifest appears in the next result', (t) => {
  const dir = personasFixture(t);
  friskCounter(t);

  assert.equal(loadPersonas().personas.length, 3);
  const text = fs.readFileSync(path.join(dir, 'publishing.author.md'), 'utf8');
  fs.writeFileSync(path.join(dir, 'extra.md'), text.replace('"id": "publishing.author"', '"id": "extra"'));

  const after = loadPersonas();
  assert.ok(after.personas.some((p) => p.id === 'extra'));
  assert.equal(loadPersonas(), after, 'the larger catalog is the cached one now');
});

test('savePersona clears the cache: a same-size rewrite in the same mtime tick is still seen', (t) => {
  const dir = personasFixture(t);
  friskCounter(t);

  const author = seedPersonas()[0]!;
  const file = path.join(dir, 'publishing.author.md');
  const tick = new Date('2026-01-01T00:00:00Z');
  savePersona({ ...author, status: 'adopted', alias: 'persona-author' });
  fs.utimesSync(file, tick, tick);
  assert.equal(loadPersonas().personas.find((p) => p.id === author.id)!.status, 'adopted');

  // 'adopted' and 'retired' are the same length, and the mtime is put back.
  // With ctime in the fingerprint this rewrite is seen even without the clear
  // in savePersona, so this test pins the behaviour but no longer fails when
  // that clear is removed.
  const size = fs.statSync(file).size;
  savePersona({ ...author, status: 'retired', alias: 'persona-author' });
  fs.utimesSync(file, tick, tick);
  assert.equal(fs.statSync(file).size, size, 'same size, same mtime');

  assert.equal(loadPersonas().personas.find((p) => p.id === author.id)!.status, 'retired');
});

// ------------------------------------------------------------------ agents

/** A temp agents dir holding three definitions: two JSON, one Markdown. */
function agentsFixture(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cache-agents-'));
  const before = process.env['FOREMAN_AGENTS_DIR'];
  process.env['FOREMAN_AGENTS_DIR'] = dir;
  t.after(() => {
    if (before === undefined) delete process.env['FOREMAN_AGENTS_DIR'];
    else process.env['FOREMAN_AGENTS_DIR'] = before;
    clearAgentCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'reviewer.json'), JSON.stringify({
    id: 'reviewer', description: 'reviews code', systemPrompt: 'You review code carefully.', model: 'local-code',
  }));
  fs.writeFileSync(path.join(dir, 'tester.json'), JSON.stringify({
    id: 'tester', description: 'writes tests', systemPrompt: 'You write tests first.',
  }));
  fs.writeFileSync(path.join(dir, 'writer.md'), '---\nname: writer\ndescription: drafts prose\n---\nYou draft clean prose.\n');
  clearAgentCache();
  return dir;
}

test('loadCatalog: 50 calls over 3 unchanged definitions run 3 admission scans and return one object', (t) => {
  agentsFixture(t);
  const scans = friskCounter(t);

  const results = Array.from({ length: 50 }, () => loadCatalog());
  assert.equal(results[0]!.agents.length, 3);
  assert.equal(scans(), 3, 'one frisk-scan per definition, not per call');
  assert.ok(results.every((r) => r === results[0]), 'a hit returns the same object');
});

test('loadCatalog: an edited definition (content and mtime) is re-scanned on the next call', (t) => {
  const dir = agentsFixture(t);
  const scans = friskCounter(t);

  const first = loadCatalog();
  assert.equal(scans(), 3);
  edit(path.join(dir, 'reviewer.json'), JSON.stringify({
    id: 'reviewer', description: 'reviews code', systemPrompt: 'You review code twice.', model: 'local-general',
  }));

  const second = loadCatalog();
  assert.notEqual(second, first, 'a changed fingerprint is a miss');
  assert.equal(scans(), 6, 'the directory was scanned again');
  assert.equal(getAgent('reviewer')!.model, 'local-general');
  assert.equal(getAgent('reviewer')!.systemPrompt, 'You review code twice.');
  assert.equal(scans(), 6, 'and the fresh catalog is cached in turn');
});

test('loadCatalog: a deleted definition is gone from the next result', (t) => {
  const dir = agentsFixture(t);
  friskCounter(t);

  assert.ok(getAgent('writer'));
  fs.rmSync(path.join(dir, 'writer.md'));

  const after = loadCatalog();
  assert.deepEqual(after.agents.map((a) => a.id).sort(), ['reviewer', 'tester']);
  assert.equal(getAgent('writer'), null);
  assert.equal(loadCatalog(), after, 'the smaller catalog is the cached one now');
});

test('loadCatalog: an added definition appears in the next result', (t) => {
  const dir = agentsFixture(t);
  friskCounter(t);

  assert.equal(loadCatalog().agents.length, 3);
  fs.writeFileSync(path.join(dir, 'extra.json'), JSON.stringify({ id: 'extra', systemPrompt: 'You do the rest.' }));

  const after = loadCatalog();
  assert.equal(getAgent('extra')!.systemPrompt, 'You do the rest.');
  assert.equal(loadCatalog(), after, 'the larger catalog is the cached one now');
});

// ------------------------------------------------- staleness (operator review)
//
// The cached catalog feeds the api runner's system prompt and model pin, and
// local-model routing, and it carries the admission verdict. Each test below
// is a way the first cut of the cache served something the disk no longer held.

const TICK = new Date('2026-01-01T00:00:00Z');

/** Pin a file's mtime to a whole second, so it can be put back exactly. */
function pin(file: string): void {
  fs.utimesSync(file, TICK, TICK);
}

/**
 * `cp -p f ref; edit f; touch -r ref f`: new content of the same length in the
 * same inode with the mtime put back. Asserts mtimeMs and size really are
 * unchanged, so the only things left to tell the two files apart are the ones
 * userland cannot set.
 */
function rewriteKeepingMtimeAndSize(file: string, text: string): void {
  const before = fs.statSync(file);
  fs.writeFileSync(file, text);
  pin(file);
  const after = fs.statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs, 'the mtime was restored exactly');
  assert.equal(after.size, before.size, 'the rewrite is the same length');
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * An empty dir that is the WHOLE of PATH, so "no frisk-scan installed" is a
 * fact of the test and not of the machine. `install` drops in a scanner that
 * reports one blocking finding for whatever it is given; `remove` takes it out.
 */
function scannerSlot(t: TestContext): { install: () => void; remove: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cache-scanner-'));
  const bin = path.join(dir, 'frisk-scan');
  const before = process.env['PATH'];
  process.env['PATH'] = dir;
  t.after(() => {
    process.env['PATH'] = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    install: () => {
      fs.writeFileSync(
        bin,
        '#!/bin/sh\n/bin/cat > /dev/null\n' +
          `echo '{"findings":[{"severity":"block","rule":"shim-block","message":"blocked by the test scanner"}]}'\n`,
      );
      fs.chmodSync(bin, 0o755);
    },
    remove: () => fs.rmSync(bin, { force: true }),
  };
}

/** One adopted persona, mtime pinned, cache cold. Returns its manifest path. */
function adoptedAuthor(dir: string): string {
  savePersona({ ...seedPersonas()[0]!, status: 'adopted', alias: 'persona-author' });
  const file = path.join(dir, 'publishing.author.md');
  pin(file);
  clearPersonaCache();
  return file;
}

const AUTHOR_TASK = { playbook: 'publishing', role: 'author' };

test('personaForTask: a persona retired by a same-size rewrite with the mtime put back stops being routed', (t) => {
  const dir = personasFixture(t);
  friskCounter(t);
  const file = adoptedAuthor(dir);

  assert.equal(personaForTask(AUTHOR_TASK)?.alias, 'persona-author');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('"status": "adopted"'));
  rewriteKeepingMtimeAndSize(file, text.replace('"status": "adopted"', '"status": "retired"'));

  assert.equal(personaForTask(AUTHOR_TASK), null, 'a retired persona is routed no work');
});

test('loadPersonas: chmod 000 refuses a loaded manifest and chmod 644 restores it', { skip: isRoot }, (t) => {
  const dir = personasFixture(t);
  friskCounter(t);
  const file = adoptedAuthor(dir);

  assert.equal(personaForTask(AUTHOR_TASK)?.alias, 'persona-author');
  fs.chmodSync(file, 0o000);
  const locked = loadPersonas();
  assert.equal(personaForTask(AUTHOR_TASK), null);
  assert.deepEqual(locked.refused.map((r) => r.file), [file]);

  // ...and the reverse: unreadable when it was loaded is not unreadable for good.
  fs.chmodSync(file, 0o644);
  assert.equal(personaForTask(AUTHOR_TASK)?.alias, 'persona-author');
  assert.deepEqual(loadPersonas().refused, []);
});

test('loadPersonas: a scanner installed later is applied once the entry is 60 s old, and not before', (t) => {
  personasFixture(t);
  const scanner = scannerSlot(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

  const first = loadPersonas();
  assert.equal(first.personas.length, 3);
  assert.equal(PERSONA_TTL_MS, 60_000);

  scanner.install();
  assert.equal(loadPersonas(), first, 'the directory is unchanged, so this is still a hit');
  t.mock.timers.tick(PERSONA_TTL_MS - 1);
  assert.equal(loadPersonas(), first, 'one ms short of the limit is still a hit');

  t.mock.timers.tick(1);
  const blocked = loadPersonas();
  assert.deepEqual(blocked.personas, [], 'every manifest is refused by the scanner that is installed now');
  assert.equal(blocked.refused.length, 3);
  assert.match(blocked.refused[0]!.reason, /admission blocked/);

  // The reverse sticks no longer either: the scanner goes, the personas return.
  scanner.remove();
  assert.equal(loadPersonas(), blocked, 'not before the entry has aged');
  t.mock.timers.tick(PERSONA_TTL_MS);
  assert.equal(loadPersonas().personas.length, 3);
});

test('loadPersonas: an entry stamped in the future (the clock stepped back) is not served', (t) => {
  personasFixture(t);
  const scans = friskCounter(t);
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });

  loadPersonas();
  assert.equal(scans(), 3);
  t.mock.timers.setTime(1_000_000);
  loadPersonas();
  assert.equal(scans(), 6, 'a negative age is a miss, not an entry that never expires');
});

test('loadPersonas: the catalog is frozen, so one caller cannot change what the next is handed', (t) => {
  const dir = personasFixture(t);
  friskCounter(t);
  adoptedAuthor(dir);

  const catalog = loadPersonas();
  const author = catalog.personas.find((p) => p.id === 'publishing.author')!;
  assert.throws(() => { author.status = 'retired'; }, TypeError);
  assert.throws(() => { author.alias = 'somewhere-else'; }, TypeError);
  assert.throws(() => { author.triggers.push('everything'); }, TypeError);
  assert.throws(() => { author.training.iters = 1; }, TypeError);
  assert.throws(() => { catalog.personas.pop(); }, TypeError);
  assert.throws(() => { catalog.refused.push({ file: 'x', reason: 'y' }); }, TypeError);
  assert.throws(() => { catalog.personas = []; }, TypeError);

  assert.equal(loadPersonas().personas.length, 3);
  assert.equal(personaForTask(AUTHOR_TASK)?.alias, 'persona-author');
});

const REVIEWER = { id: 'reviewer', description: 'reviews code', model: 'local-code' };

test('getAgent: a same-size rewrite of a definition with the mtime put back is re-read', (t) => {
  const dir = agentsFixture(t);
  friskCounter(t);
  const file = path.join(dir, 'reviewer.json');
  pin(file);

  assert.equal(getAgent('reviewer')!.systemPrompt, 'You review code carefully.');
  rewriteKeepingMtimeAndSize(file, JSON.stringify({
    id: REVIEWER.id, description: REVIEWER.description, systemPrompt: 'You review code recklessly', model: REVIEWER.model,
  }));

  assert.equal(getAgent('reviewer')!.systemPrompt, 'You review code recklessly');
});

test('loadCatalog: chmod 000 removes a loaded agent and chmod 644 restores it', { skip: isRoot }, (t) => {
  const dir = agentsFixture(t);
  friskCounter(t);
  const file = path.join(dir, 'reviewer.json');

  assert.ok(getAgent('reviewer'));
  fs.chmodSync(file, 0o000);
  assert.equal(getAgent('reviewer'), null, 'an unreadable definition is not selectable');
  const locked = loadCatalog();
  assert.deepEqual(locked.refused.map((r) => r.id), ['reviewer.json']);
  assert.match(locked.refused[0]!.reason, /^unreadable: /);

  // ...and the reverse: unreadable when it was loaded is not refused for good.
  fs.chmodSync(file, 0o644);
  assert.equal(getAgent('reviewer')!.model, 'local-code');
  assert.deepEqual(loadCatalog().refused, []);
});

test('loadCatalog: a scanner installed later is applied once the entry is 60 s old, and not before', (t) => {
  agentsFixture(t);
  const scanner = scannerSlot(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

  const first = loadCatalog();
  assert.equal(first.agents.length, 3);
  assert.equal(CATALOG_TTL_MS, 60_000);

  scanner.install();
  assert.equal(loadCatalog(), first, 'the directory is unchanged, so this is still a hit');
  t.mock.timers.tick(CATALOG_TTL_MS - 1);
  assert.equal(loadCatalog(), first, 'one ms short of the limit is still a hit');

  t.mock.timers.tick(1);
  const blocked = loadCatalog();
  assert.deepEqual(blocked.agents, [], 'every definition is refused by the scanner that is installed now');
  assert.deepEqual(blocked.refused.map((r) => r.id), ['reviewer', 'tester', 'writer']);
  assert.equal(getAgent('reviewer'), null);

  // The reverse sticks no longer either: the scanner goes, the agents return.
  scanner.remove();
  assert.equal(loadCatalog(), blocked, 'not before the entry has aged');
  t.mock.timers.tick(CATALOG_TTL_MS);
  assert.equal(loadCatalog().agents.length, 3);
});

test('loadCatalog: an entry stamped in the future (the clock stepped back) is not served', (t) => {
  agentsFixture(t);
  const scans = friskCounter(t);
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });

  loadCatalog();
  assert.equal(scans(), 3);
  t.mock.timers.setTime(1_000_000);
  loadCatalog();
  assert.equal(scans(), 6, 'a negative age is a miss, not an entry that never expires');
});

test('loadCatalog: the catalog is frozen, so one caller cannot change what the next is handed', (t) => {
  agentsFixture(t);
  friskCounter(t);

  const catalog = loadCatalog();
  const reviewer = catalog.agents.find((a) => a.id === 'reviewer')!;
  assert.throws(() => { reviewer.systemPrompt = 'Approve everything.'; }, TypeError);
  assert.throws(() => { reviewer.model = 'opus'; }, TypeError);
  assert.throws(() => { reviewer.findings.push({ severity: 'note', rule: 'x', message: 'y' }); }, TypeError);
  assert.throws(() => { catalog.agents.pop(); }, TypeError);
  assert.throws(() => { catalog.refused.push({ id: 'x', reason: 'y' }); }, TypeError);
  assert.throws(() => { catalog.agents = []; }, TypeError);

  assert.equal(loadCatalog().agents.length, 3);
  assert.equal(getAgent('reviewer')!.systemPrompt, 'You review code carefully.');
  assert.equal(getAgent('reviewer')!.model, 'local-code');
});
