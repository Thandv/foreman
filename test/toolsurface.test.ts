import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRunner, catalogSection } from '../src/runners/api.ts';
import { Store } from '../src/queue.ts';
import type { Broker } from '../src/budget.ts';
import type { RunnerContext } from '../src/runners/index.ts';
import { listTools, searchTools } from '../src/tools/catalog.ts';
import { toolSurface } from '../src/tools/forge.ts';
import { getPlaybook } from '../src/playbooks.ts';

// Experiment E-M (an expert-offload experiment, mapping M1):
// the api runner's first message carries the whole catalog. Sparse mode keeps the
// role's declared tools in full and lists the rest by name; find_tool is the miss path.

process.env['FOREMAN_PLAYBOOKS_DIR'] = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'playbooks');

const tools = (): ReturnType<typeof listTools> => listTools().filter((t) => !t.quarantined);
const dev = { playbook: 'software', role: 'dev' };

test('the default surface is unchanged: every tool, in full', () => {
  assert.ok(tools().length > 10, 'the repo toolbox is the catalog under test');
  assert.equal(catalogSection(dev, tools(), undefined), toolSurface(tools()));
});

test('sparse: the role\'s declared tools in full, every other tool by name only', () => {
  const declared = getPlaybook('software')!.tools['dev']!.map((t) => t.name);
  const out = catalogSection(dev, tools(), 'sparse');
  for (const t of tools()) {
    if (declared.includes(t.name)) {
      assert.ok(out.includes(`- ${t.name}: ${t.description}`), `${t.name} is described in full`);
    } else {
      assert.ok(out.includes(t.name), `${t.name} is still named`);
      assert.ok(!out.includes(`- ${t.name}: `), `${t.name} is not described`);
    }
  }
  assert.match(out, /find_tool/);
  assert.ok(out.length < toolSurface(tools()).length / 2, `sparse is much smaller: ${out.length} vs ${toolSurface(tools()).length}`);
});

test('sparse falls back to the full catalog when the task has no role or the role declares no tools', () => {
  const full = toolSurface(tools());
  assert.equal(catalogSection({ playbook: null, role: null }, tools(), 'sparse'), full);
  assert.equal(catalogSection({ playbook: 'software', role: 'no-such-role' }, tools(), 'sparse'), full);
  assert.equal(catalogSection({ playbook: 'no-such-playbook', role: 'dev' }, tools(), 'sparse'), full);
  // An inherited key is not a declared role (and must not crash the runner).
  assert.equal(catalogSection({ playbook: 'software', role: 'constructor' }, tools(), 'sparse'), full);
  assert.equal(catalogSection({ playbook: 'software', role: 'toString' }, tools(), 'sparse'), full);
});

test('sparse with none of the role\'s tools usable says so, and still names every other tool', () => {
  const declared = new Set(getPlaybook('software')!.tools['dev']!.map((t) => t.name));
  const others = tools().filter((t) => !declared.has(t.name));
  const out = catalogSection(dev, others, 'sparse');
  assert.match(out, /none of this role's tools can be used yet: not built, or quarantined/);
  for (const t of others) assert.ok(out.includes(t.name), `${t.name} is still named`);
});

test('the api runner sends the sparse section in its first message only when asked to', async () => {
  // The unit tests above prove the section; this proves the wiring: the first
  // message the model actually receives is built from it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-toolsurface-'));
  const store = new Store(':memory:');
  const firstMessages: string[] = [];
  const broker = {
    call: async (req: { messages: Array<{ role: string; content: string }> }) => {
      firstMessages.push(req.messages[1]!.content);
      return { text: '{"tool":"done","summary":"stub"}', tokensIn: 0, tokensOut: 0, costUsd: 0, spec: { alias: 'stub', model: 'stub' } };
    },
  } as unknown as Broker;
  const saved = process.env['FOREMAN_TOOL_SURFACE'];
  try {
    const task = store.addTask({ title: 'bump the version', prompt: 'bump it', runner: 'api', kind: 'code', playbook: 'software', role: 'dev' });
    const ctx = (): RunnerContext => ({
      task, runId: 'run-stub', dir, signal: new AbortController().signal, broker,
      stage() {}, child() {}, session() {}, log() {}, progress() {}, usage() {},
    } as unknown as RunnerContext);
    const tail = (msg: string): string => msg.slice(msg.indexOf('Tools already in the catalog:\n') + 'Tools already in the catalog:\n'.length);

    process.env['FOREMAN_TOOL_SURFACE'] = 'sparse';
    assert.equal((await apiRunner.run(ctx())).ok, true);
    assert.equal(tail(firstMessages[0]!), catalogSection(task, tools(), 'sparse'));

    delete process.env['FOREMAN_TOOL_SURFACE'];
    assert.equal((await apiRunner.run(ctx())).ok, true);
    assert.equal(tail(firstMessages[1]!), toolSurface(tools()), 'unset means the full catalog');
    assert.ok(firstMessages[0]!.length < firstMessages[1]!.length / 2);
  } finally {
    if (saved === undefined) delete process.env['FOREMAN_TOOL_SURFACE'];
    else process.env['FOREMAN_TOOL_SURFACE'] = saved;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the miss path works for EVERY catalog tool: find_tool with its exact name returns it', () => {
  // A names-only entry is only a promise if search keeps it. Parameterised over
  // the whole catalog, not a sample: one unfindable tool is one dead promise.
  for (const t of tools()) {
    const hits = searchTools(t.name).slice(0, 10).map((h) => h.name);
    assert.ok(hits.includes(t.name), `find_tool "${t.name}" → ${hits.join(', ') || '(nothing)'}`);
  }
});
