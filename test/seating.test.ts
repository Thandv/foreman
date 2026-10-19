import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { benchPath } from '../src/bench.ts';
import { councilAliases } from '../src/verify/council.ts';
import { reloadSpecs, resolveSpec } from '../src/models.ts';
import { config } from '../src/config.ts';
import { setCloudDown } from '../src/localOnly.ts';

// The bench this machine actually wrote (2026-08-19): the 9B and the coder-14B
// both scored 1.00, so the roster names the FASTER one for both the reason and
// the code seat. Tests without a bench file never see that collision — which
// is how a prose council seated the 2B and every chair went to the two weakest
// reasoners on the machine while the suite stayed green.
const REAL_ROSTER = { reason: 'local-reason', code: 'local-reason', fast: 'local-fast' };
const WEAK = new Set(['qwen3.5:2b', 'llama3.1:8b']);

function withBench<T>(roster: Record<string, string>, fn: () => T): T {
  fs.mkdirSync(config.home, { recursive: true });
  fs.writeFileSync(benchPath(), JSON.stringify({ models: [], roster, measuredAt: '' }));
  const restore = (): void => fs.rmSync(benchPath(), { force: true });
  let out: T;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  // An async body must finish with the bench it asked for still on disk.
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  reloadSpecs();
  const restore = (): void => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    reloadSpecs();
  };
  let out: T;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  // An async body must finish under the env it asked for, not after it.
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}

const model = (alias: string): string => resolveSpec(alias).model;

for (const [label, roster] of [['real bench', REAL_ROSTER], ['no bench', null]] as const) {
  test(`${label}: no chair is ever a weak reasoner while a strong one exists`, () => {
    const run = (): void => {
      for (const sensitivity of ['S1', 'S2'] as const) {
        for (const kind of ['code', 'writing', 'general'] as const) {
          for (const rung of [0, 1, 2]) {
            const { chair } = councilAliases(sensitivity, rung, kind);
            assert.ok(!WEAK.has(model(chair)), `${sensitivity} ${kind} rung ${rung}: chair ${chair} (${model(chair)})`);
          }
        }
      }
    };
    if (roster) withBench(roster, run);
    else run();
  });

  test(`${label}: prose advisors are two different capable models — never the 2B`, () => {
    const run = (): void => {
      for (const rung of [0, 1, 2]) {
        const { advisors } = councilAliases('S1', rung, 'writing');
        assert.equal(new Set(advisors.map(model)).size, 2, `rung ${rung}: ${advisors.join(', ')}`);
        for (const a of advisors) assert.ok(!WEAK.has(model(a)), `rung ${rung} seated ${a} (${model(a)}) on prose`);
      }
    };
    if (roster) withBench(roster, run);
    else run();
  });

  test(`${label}: escalated code councils seat two different models and no llama`, () => {
    const run = (): void => {
      for (const rung of [1, 2]) {
        const { advisors } = councilAliases('S1', rung, 'code');
        assert.equal(new Set(advisors.map(model)).size, 2, `rung ${rung}: ${advisors.join(', ')}`);
        for (const a of advisors) assert.notEqual(model(a), 'llama3.1:8b', `rung ${rung} seated llama`);
      }
    };
    if (roster) withBench(roster, run);
    else run();
  });
}

test('rung 0 for code still leads with the cheap seat', () => {
  withBench(REAL_ROSTER, () => {
    assert.equal(councilAliases('S1', 0, 'code').advisors[0], 'local-fast');
  });
});

test('the top rung chair leaves the machine when allowed, and never for S2', () => {
  withEnv('FOREMAN_LOCAL_ONLY', '0', () => {
    const top = councilAliases('S1', 2, 'code');
    assert.equal(resolveSpec(top.chair).local, false, `S1 top-rung chair stayed local: ${top.chair}`);
    const s2 = councilAliases('S2', 2, 'code');
    assert.ok(resolveSpec(s2.chair).local, `S2 chair left the machine: ${s2.chair}`);
    for (const a of s2.advisors) assert.ok(resolveSpec(a).local);
  });
});

test('local-only: the chair is the 9B or the coder, as the local-only policy specifies — never the 2B', () => {
  withEnv('FOREMAN_LOCAL_ONLY', '1', () => {
    withBench(REAL_ROSTER, () => {
      for (const kind of ['code', 'writing'] as const) {
        for (const rung of [0, 1, 2]) {
          const { chair } = councilAliases('S1', rung, kind);
          assert.ok(['qwen3.5:9b', 'qwen2.5-coder:14b'].includes(model(chair)), `${kind} rung ${rung}: ${chair}`);
        }
      }
    });
  });
});

test('auto mode: a cloud known to be down seats no cloud alias anywhere', () => {
  withEnv('FOREMAN_LOCAL_ONLY', undefined, () => {
    setCloudDown('test: signed out');
    reloadSpecs();
    try {
      for (const rung of [0, 1, 2]) {
        const { advisors, chair } = councilAliases('S1', rung, 'code');
        for (const a of [...advisors, chair]) assert.ok(resolveSpec(a).local, `rung ${rung}: ${a}`);
      }
    } finally {
      setCloudDown(null);
      reloadSpecs();
    }
  });
});

test('mixed mode: below the top rung the chair stays on the machine', () => {
  withEnv('FOREMAN_LOCAL_ONLY', '0', () => {
    for (const rung of [0, 1]) {
      for (const kind of ['code', 'writing'] as const) {
        const { chair } = councilAliases('S1', rung, kind);
        assert.ok(resolveSpec(chair).local, `rung ${rung} ${kind}: chair ${chair} left the machine`);
      }
    }
  });
});

test('a bench that names the coder for "reason" still seats two strong, different prose advisors', () => {
  withEnv('FOREMAN_LOCAL_ONLY', '0', () => {
    withBench({ reason: 'local-code', code: 'local-code', fast: 'local-fast' }, () => {
      for (const rung of [0, 1, 2]) {
        const { advisors } = councilAliases('S1', rung, 'writing');
        assert.deepEqual(new Set(advisors.map(model)), new Set(['qwen2.5-coder:14b', 'qwen3.5:9b']), `rung ${rung}`);
      }
    });
  });
});

async function disagreeingCouncil(env: string, rung: number): Promise<{ verdict: string; kinds: string[]; chairs: string[] }> {
  const { Store } = await import('../src/queue.ts');
  const { Broker } = await import('../src/budget.ts');
  const { runCouncil } = await import('../src/verify/council.ts');
  const { probeTask } = await import('../src/types.ts');
  return withEnv('FOREMAN_LOCAL_ONLY', env, async () => {
    const store = new Store(':memory:');
    const kinds: string[] = [];
    const chairs: string[] = [];
    const broker = new Broker(store, {
      guardResidency: false,
      chatFn: async (o) => {
        const spec = resolveSpec(o.alias);
        // The 9B passes, everything else fails; a chair says pass.
        const isChair = o.messages.some((m) => m.content.includes('REVIEWERS DISAGREED'));
        if (isChair) chairs.push(spec.model);
        const verdict = isChair || spec.model === 'qwen3.5:9b' ? 'pass' : 'fail';
        return { text: JSON.stringify({ verdict, confidence: 0.9, issues: verdict === 'fail' ? ['wrong'] : [] }), tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec };
      },
    });
    const original = broker.call.bind(broker);
    (broker as unknown as { call: unknown }).call = async (req: { kind: string }) => {
      kinds.push(req.kind);
      return original(req as never);
    };
    store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','writing','api','S1','verifying',2,0,0)").run();
    store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();
    try {
      const v = await runCouncil({
        store, broker, task: probeTask({ id: 't1', kind: 'writing' }), runId: 'r1', rung,
        evidence: { body: 'chapter text', bodyLabel: 'chapter', testsPassed: true },
      });
      return { verdict: v.verdict, kinds, chairs };
    } finally {
      store.close();
    }
  });
}

test('local-only: a disagreement still reaches the 9B chair, as the local-only policy binds', async () => {
  const { verdict, kinds, chairs } = await disagreeingCouncil('1', 0);
  assert.ok(kinds.some((k) => k.startsWith('chair@')), `no chair call: ${kinds.join(',')}`);
  assert.deepEqual(chairs, ['qwen3.5:9b']);
  assert.equal(verdict, 'pass');
  assert.equal(kinds.filter((k) => k.startsWith('council@')).length, 2, 'no pointless re-run of the same pair');
});

test('mixed: a chair that argued one side hands the vote up to an independent chair', async () => {
  const { verdict, kinds, chairs } = await disagreeingCouncil('0', 0);
  assert.ok(!kinds.includes('chair@r0'), 'the conflicted rung-0 chair did not decide');
  assert.ok(kinds.includes('chair@r2'), `escalated straight to the rung with an independent chair: ${kinds.join(',')}`);
  assert.deepEqual(chairs, ['claude-opus-5-5']);
  assert.equal(verdict, 'pass');
});

test('a conflicted split is handed to a rung whose own chair cannot be conflicted', async () => {
  const { independentRungAbove } = await import('../src/verify/council.ts');
  withEnv('FOREMAN_LOCAL_ONLY', '0', () => {
    withBench(REAL_ROSTER, () => {
      for (const kind of ['code', 'writing'] as const) {
        for (const from of [0, 1]) {
          const r = independentRungAbove({ sensitivity: 'S1', kind }, from);
          assert.notEqual(r, null, `${kind} from ${from}`);
          const c = councilAliases('S1', r!, kind);
          assert.ok(!c.advisors.map(model).includes(model(c.chair)), `${kind} rung ${r}: chair ${c.chair} is also an advisor`);
        }
      }
    });
  });
  withEnv('FOREMAN_LOCAL_ONLY', '1', () => {
    withBench(REAL_ROSTER, () => {
      assert.equal(independentRungAbove({ sensitivity: 'S1', kind: 'writing' }, 0), null, 'local-only has none: the 9B chairs');
    });
  });
});

test('an ordinary split that lands on a conflicted chair keeps climbing to the independent one', async () => {
  // The reproduced path: rung 0 (2B + coder, 9B chair) splits because the chair
  // call fails; rung 1 (coder + 9B) has the 9B as a conflicted chair. Opus at
  // rung 2 must still be asked — not a park that claims to be "handing up".
  const { Store } = await import('../src/queue.ts');
  const { Broker } = await import('../src/budget.ts');
  const { runCouncil } = await import('../src/verify/council.ts');
  const { probeTask } = await import('../src/types.ts');
  await withEnv('FOREMAN_LOCAL_ONLY', '0', () => withBench(REAL_ROSTER, async () => {
    const store = new Store(':memory:');
    const kinds: string[] = [];
    const chairs: string[] = [];
    const broker = new Broker(store, {
      guardResidency: false,
      chatFn: async (o) => {
        const spec = resolveSpec(o.alias);
        const isChair = o.messages.some((m) => m.content.includes('REVIEWERS DISAGREED'));
        if (isChair) {
          chairs.push(spec.model);
          if (spec.model === 'qwen3.5:9b') throw new Error('chair unavailable');
        }
        const verdict = isChair || spec.model === 'qwen2.5-coder:14b' ? 'pass' : 'fail';
        return { text: JSON.stringify({ verdict, confidence: 0.9, issues: verdict === 'fail' ? ['wrong'] : [] }), tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec };
      },
    });
    const original = broker.call.bind(broker);
    (broker as unknown as { call: unknown }).call = async (req: { kind: string }) => {
      kinds.push(req.kind);
      return original(req as never);
    };
    store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','code','api','S1','verifying',2,0,0)").run();
    store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();
    try {
      const v = await runCouncil({
        store, broker, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1', rung: 0,
        evidence: { body: 'diff', bodyLabel: 'diff', testsPassed: true },
      });
      assert.ok(chairs.includes('claude-opus-5-5'), `opus never asked: chairs=${chairs.join(',')} kinds=${kinds.join(',')}`);
      assert.equal(v.verdict, 'pass');
    } finally {
      store.close();
    }
  }));
});
