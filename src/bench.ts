import fs from 'node:fs';
import path from 'node:path';
import type { Broker } from './budget.ts';
import { config } from './config.ts';
import { extractJson, specs, type ModelSpec } from './models.ts';

export type ProbeCategory = 'reasoning' | 'code' | 'fidelity';

export interface Probe {
  id: string;
  category: ProbeCategory;
  prompt: string;
  json?: boolean | Record<string, unknown>;
  maxTokens: number;
  /** Deterministic scoring: 1 = correct, 0 = wrong. No model judges another. */
  score(text: string): number;
}

const norm = (t: string): string => t.trim().toLowerCase().replace(/[.*_`"']/g, '');

/**
 * These probes ask for a bare answer ("one word", "the number alone"), so the
 * whole reply must BE that answer. Substring matching would score "no idea" as
 * a correct "no" — a hedge is not an answer, and measuring it as one would
 * flatter exactly the models Foreman must not promote.
 */
const isExactly = (t: string, want: string): boolean =>
  norm(t).replace(/^(answer|a)\s*[:\-]\s*/, '').replace(/[!?,]+$/, '').trim() === want;

/**
 * Twelve fixed probes, scored by code rather than by another model. They are
 * small on purpose: this measures whether a model can follow an instruction and
 * hold a short chain of reasoning, which is what Foreman actually asks of it.
 */
export const PROBES: Probe[] = [
  {
    id: 'syllogism', category: 'reasoning', maxTokens: 120,
    prompt: 'All A are B. Some B are C. Does it follow that some A are C? Answer with exactly one word: yes or no.',
    score: (t) => (isExactly(t, 'no') ? 1 : 0),
  },
  {
    id: 'arithmetic', category: 'reasoning', maxTokens: 160,
    prompt: 'A shelf holds 3 boxes. Each box holds 4 packets. Each packet holds 6 pens. How many pens in total? Reply with the number alone.',
    score: (t) => (isExactly(t, '72') ? 1 : 0),
  },
  {
    id: 'ordering', category: 'reasoning', maxTokens: 160,
    prompt: 'Ana finished before Ben. Ben finished before Cara. Cara finished before Dan. Who finished last? Reply with the name alone.',
    score: (t) => (isExactly(t, 'dan') ? 1 : 0),
  },
  {
    id: 'negation', category: 'reasoning', maxTokens: 160,
    prompt: 'A function returns 0 when its input is not an array. Does calling it with null throw an error? Answer yes or no, one word.',
    score: (t) => (isExactly(t, 'no') ? 1 : 0),
  },
  {
    id: 'off-by-one', category: 'code', maxTokens: 220, json: true,
    prompt:
      'Review this diff. Reply with JSON only: {"verdict":"pass"|"fail","why":"short"}.\n' +
      '```\n-for (let i = 0; i < items.length; i++)\n+for (let i = 0; i <= items.length; i++)\n```',
    score: (t) => {
      const v = extractJson<{ verdict?: string }>(t);
      return v?.verdict === 'fail' ? 1 : 0;
    },
  },
  {
    id: 'correct-diff', category: 'code', maxTokens: 220, json: true,
    prompt:
      'Review this diff, which does exactly what was asked ("guard against a non-array input"). ' +
      'Reply with JSON only: {"verdict":"pass"|"fail","why":"short"}.\n' +
      '```\n function sum(nums) {\n+  if (!Array.isArray(nums)) return 0;\n   let total = 0;\n```',
    score: (t) => {
      const v = extractJson<{ verdict?: string }>(t);
      return v?.verdict === 'pass' ? 1 : 0;
    },
  },
  {
    id: 'swallowed-error', category: 'code', maxTokens: 220, json: true,
    prompt:
      'Does this code swallow an error? Reply with JSON only: {"answer":"yes"|"no"}.\n' +
      '```\ntry { risky(); } catch (e) {}\n```',
    score: (t) => {
      const v = extractJson<{ answer?: string }>(t);
      return String(v?.answer ?? '').toLowerCase() === 'yes' ? 1 : 0;
    },
  },
  {
    id: 'scope-creep', category: 'code', maxTokens: 260, json: true,
    prompt:
      'The task was "fix the typo in the log message". The diff fixes the typo AND rewrites an unrelated function. ' +
      'Reply with JSON only: {"verdict":"pass"|"fail","why":"short"}.',
    score: (t) => {
      const v = extractJson<{ verdict?: string }>(t);
      return v?.verdict === 'fail' ? 1 : 0;
    },
  },
  {
    id: 'exact-word', category: 'fidelity', maxTokens: 60,
    prompt: 'Reply with exactly the word BANANA and nothing else. No punctuation, no explanation.',
    score: (t) => (norm(t) === 'banana' ? 1 : 0),
  },
  {
    id: 'json-only', category: 'fidelity', maxTokens: 80, json: true,
    prompt: 'Reply with JSON only: {"n":7}. No prose.',
    score: (t) => (extractJson<{ n?: number }>(t)?.n === 7 ? 1 : 0),
  },
  {
    // Format AND content: a pure length check would score "no idea" as a pass,
    // which flatters exactly the hedging models this bench exists to catch.
    id: 'list-format', category: 'fidelity', maxTokens: 120,
    prompt:
      'Name the three primary colours in the RYB model, comma-separated, lowercase, nothing else. ' +
      'Example format: alpha, beta, gamma',
    score: (t) => {
      const items = norm(t).split(',').map((w) => w.trim()).filter(Boolean);
      const wanted = new Set(['red', 'yellow', 'blue']);
      return items.length === 3 && items.every((i) => wanted.has(i)) && new Set(items).size === 3 ? 1 : 0;
    },
  },
  {
    id: 'refusal-of-invention', category: 'fidelity', maxTokens: 120,
    prompt:
      'What is the value of the FOREMAN_ZZQX_LIMIT setting? If you do not know, reply with exactly: UNKNOWN',
    score: (t) => (isExactly(t, 'unknown') ? 1 : 0),
  },
];

export interface ModelBench {
  alias: string;
  model: string;
  provider: string;
  local: boolean;
  ok: boolean;
  error: string | null;
  /** First call, which includes any load from disk. */
  coldStartMs: number;
  tokensPerSec: number;
  score: number;
  byCategory: Record<ProbeCategory, number>;
  probes: Array<{ id: string; category: ProbeCategory; score: number; ms: number }>;
  measuredAt: string;
}

export interface BenchReport {
  models: ModelBench[];
  /** role → alias, chosen from the measurements. */
  roster: Record<string, string>;
  measuredAt: string;
}

export function benchPath(): string {
  return path.join(config.home, 'bench.json');
}

export function readBench(): BenchReport | null {
  try {
    return JSON.parse(fs.readFileSync(benchPath(), 'utf8')) as BenchReport;
  } catch {
    return null;
  }
}

const CATEGORIES: ProbeCategory[] = ['reasoning', 'code', 'fidelity'];

/**
 * Score every candidate model on the fixed probe set. Sequential by design:
 * two models benchmarked at once fight over VRAM and both look slow.
 */
export async function benchModels(
  broker: Broker,
  opts: { aliases?: string[]; signal?: AbortSignal; onProgress?: (line: string) => void } = {},
): Promise<BenchReport> {
  const available = [...specs().values()];
  const chosen = opts.aliases?.length
    ? available.filter((s) => opts.aliases!.includes(s.alias))
    // Cloud models cost money for no routing gain; step-down-only models must
    // never be benched into the roster, where they would sit as full-strength.
    : available.filter((s) => s.local && !s.stepDownOnly);

  const models: ModelBench[] = [];
  for (const spec of chosen) {
    models.push(await benchOne(broker, spec, opts));
    opts.onProgress?.(`${spec.alias}: ${models[models.length - 1]!.score.toFixed(2)}`);
  }

  const report: BenchReport = { models, roster: chooseRoster(models), measuredAt: new Date().toISOString() };
  fs.mkdirSync(config.home, { recursive: true });
  fs.writeFileSync(benchPath(), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function benchOne(broker: Broker, spec: ModelSpec, opts: { signal?: AbortSignal }): Promise<ModelBench> {
  const probes: ModelBench['probes'] = [];
  let coldStartMs = 0;
  let totalTokens = 0;
  let totalMs = 0;
  let error: string | null = null;

  for (const [i, probe] of PROBES.entries()) {
    if (error) break; // a model that cannot answer at all is not worth 12 calls
    const started = Date.now();
    try {
      const res = await broker.call({
        noDownshift: true,
        taskId: null, runId: null, kind: 'bench', alias: spec.alias,
        messages: [{ role: 'user', content: probe.prompt }],
        sensitivity: spec.local ? 'S2' : 'S1',
        maxTokens: probe.maxTokens,
        json: probe.json,
        signal: opts.signal,
      });
      const ms = Date.now() - started;
      if (i === 0) coldStartMs = ms;
      else {
        totalTokens += res.tokensOut;
        totalMs += ms;
      }
      probes.push({ id: probe.id, category: probe.category, score: probe.score(res.text), ms });
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
  }

  const byCategory = Object.fromEntries(
    CATEGORIES.map((c) => {
      const hits = probes.filter((p) => p.category === c);
      return [c, hits.length ? hits.reduce((n, p) => n + p.score, 0) / hits.length : 0];
    }),
  ) as Record<ProbeCategory, number>;

  return {
    alias: spec.alias, model: spec.model, provider: spec.provider, local: spec.local,
    ok: !error && probes.length === PROBES.length,
    error,
    coldStartMs,
    tokensPerSec: totalMs > 0 ? Number(((totalTokens / totalMs) * 1000).toFixed(2)) : 0,
    score: probes.length ? Number((probes.reduce((n, p) => n + p.score, 0) / probes.length).toFixed(3)) : 0,
    byCategory,
    probes,
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Role assignment from measurements, not from fashion. `fast` weighs speed
 * because it drafts and routes; `reason` and `code` weigh only correctness.
 */
export function chooseRoster(all: ModelBench[]): Record<string, string> {
  // A step-down-only model may have been benched by name (`--alias`); it still
  // never takes a roster seat.
  const models = all.filter((m) => !specs().get(m.alias)?.stepDownOnly);
  const usable = models.filter((m) => m.ok && m.score > 0);
  const roster: Record<string, string> = {};
  // Ties go to the faster model: two models that answer everything correctly
  // are not equally useful if one takes twice as long.
  const best = (rank: (m: ModelBench) => number): string | undefined =>
    [...usable].sort((a, b) => rank(b) - rank(a) || b.tokensPerSec - a.tokensPerSec)[0]?.alias;

  const reason = best((m) => m.byCategory.reasoning * 2 + m.byCategory.fidelity);
  const code = best((m) => m.byCategory.code * 2 + m.byCategory.reasoning);
  // A fast model still has to follow instructions, or its drafts are noise.
  const fast = best((m) => (m.byCategory.fidelity >= 0.5 ? m.tokensPerSec : 0));

  if (reason) roster['reason'] = reason;
  if (code) roster['code'] = code;
  if (fast) roster['fast'] = fast;
  return roster;
}

/**
 * The alias to use for a role, preferring the benched winner and falling back
 * to the conventional name. An explicit alias in models.json always wins,
 * because the operator's configuration outranks a measurement.
 */
export function rosterAlias(role: 'reason' | 'code' | 'fast', fallback: string[] = []): string[] {
  const benched = readBench()?.roster?.[role];
  const conventional = `local-${role === 'reason' ? 'reason' : role}`;
  return [...(benched ? [benched] : []), conventional, ...fallback];
}
