import { Broker } from './budget.ts';
import { contextTokensFor, localOnly, maxOutputTokensFor } from './localOnly.ts';
import { config } from './config.ts';
import { extractJson, resolveSpec, specs, timeoutForCall } from './models.ts';
import { adoptedPersonas, personaReachable } from './align/personaHealth.ts';
import { agreementReport, shadowEnabled } from './agreement.ts';
import { tierModel } from './roles.ts';
import type { Store } from './queue.ts';

/**
 * The local-only readiness drill.
 *
 * Long-form book drafting is the workload that found most of Foreman's real bugs, but it is
 * one shape of work — long prose, one ticket at a time, a human gate at the
 * end — and it is slow enough that a failure costs hours to see. This is the
 * complementary suite: a set of deliberately narrow probes, each aimed at one
 * failure mode that only shows up once the cloud is gone, each scored by CODE
 * rather than by another model.
 *
 * The design rule, inherited from `bench.ts` and from what actually worked in
 * earlier deterministic flagging tools: **a probe must have a right answer a program can
 * check.** "Does the model write well?" is not a probe. "Did it emit more than
 * 1,024 tokens" and "did it repeat the word planted 12,000 characters back"
 * are, and they are exactly the questions the local-only policy's blocking gaps turn on.
 *
 * Probes are grouped by what they would cost you to discover the slow way:
 *
 *   - **capability** — can this machine's models do the job at all? These are
 *     the ones to run BEFORE the subscription lapses, because a failure here
 *     means the plan changes, not the code.
 *   - **plumbing** — does Foreman route, cap and refuse correctly under the
 *     flag? Fast, deterministic, no model needed for most of them.
 *
 * Every probe reports evidence, not just a verdict, because a red probe is
 * only useful if it says what it saw.
 */

export type ProbeGroup = 'capability' | 'plumbing';

export interface ProbeResult {
  id: string;
  group: ProbeGroup;
  /** What failing this probe would actually cost the operator. */
  matters: string;
  ok: boolean;
  /** What was observed — the number or string the verdict rests on. */
  evidence: string;
  /** Null when the probe could not be run at all (model down, no persona). */
  skipped: string | null;
  ms: number;
}

export interface DrillReport {
  localOnly: boolean;
  ranAt: number;
  results: ProbeResult[];
  passed: number;
  failed: number;
  skipped: number;
}

interface ProbeCtx {
  store: Store;
  broker: Broker;
  signal?: AbortSignal;
}

interface Probe {
  id: string;
  group: ProbeGroup;
  matters: string;
  run: (ctx: ProbeCtx) => Promise<{ ok: boolean; evidence: string } | { skipped: string }>;
}

/** A word no training corpus pairs with the surrounding text, so recall is real. */
const NEEDLE = 'GRIMSBY-47-LANTERN';

const PROBES: Probe[] = [
  // ---------------------------------------------------------- capability
  {
    id: 'output-ceiling',
    group: 'capability',
    matters:
      'The worst failure mode in local-only mode, because it is silent: under a 1024-token ' +
      'ceiling a chapter comes back stopped mid-scene and every later stage treats that as ' +
      'the work. This proves the ceiling is raised on the wire, not just in config — and with ' +
      'it, that a long generation survives undici\u2019s 300s header timeout, which killed every ' +
      'non-streaming call past roughly 2,500 tokens.',
    async run({ broker }) {
      const alias = tierModel('senior', 'writing');
      const configured = maxOutputTokensFor('writing', 'author');
      // Deliberately NOT the full configured ceiling. At ~8 tok/s an 8192-token
      // probe is 17 minutes, and a drill nobody is willing to run finds
      // nothing. 3072 is the smallest number that still proves the point: three
      // times the old 1024 default, and well past the ~2,500-token mark where
      // undici's header timeout used to kill a non-streaming call.
      const want = Math.min(configured, 3072);
      // A COUNTING task, not a writing one — and this is the whole design of
      // the probe. Asked for "a scene of at least 2000 words", a model writes
      // until the scene feels finished and stops, measured here at 1,120
      // tokens. That is the model exercising judgment, not the transport
      // truncating, and a probe that cannot tell those apart reports a defect
      // where there is none. Counting has a length the INSTRUCTION fixes, so
      // a short reply can only mean the pipe cut it off.
      const res = await broker.call({
        noDownshift: true,
        taskId: null, runId: null, kind: 'bench', alias,
        sensitivity: 'S1',
        maxTokens: want,
        numCtx: contextTokensFor('writing', 'author'),
        messages: [{
          role: 'user',
          content:
            'Output the integers from 1 to 1200, one per line, nothing else. ' +
            'Do not summarise, do not use ranges or ellipses, do not stop early.',
        }],
      });
      // 1800 clears both the old 1024 ceiling and the ~1800-token mark the old
      // fixed 180s model timeout capped local output at.
      const ok = res.tokensOut > 1800;
      // How far it actually counted, as a second, independent read on whether
      // the output was cut off — token counts come from the server, this comes
      // from the bytes we assembled.
      const last = [...res.text.matchAll(/^\s*(\d{1,4})\s*$/gm)].map((m) => Number(m[1])).pop() ?? 0;
      return {
        ok,
        evidence: `${res.tokensOut} output tokens in ${Math.round(res.latencyMs / 1000)}s, counted to ${last}/1200 ` +
          `(asked for ${want}; the old ceiling was 1024, and the old fixed 180s timeout capped local output near 1800). ` +
          `Configured drafting ceiling is ${configured}.`,
      };
    },
  },
  {
    id: 'context-window',
    group: 'capability',
    matters:
      'Also silent: over Ollama’s ~4k default the FRONT of the prompt is dropped, so a drafting ' +
      'call writes without the outline and style sheet it was handed and reports success. The ' +
      'needle sits at the very front, which is exactly the part that gets dropped.',
    async run({ broker }) {
      const alias = tierModel('worker');
      // The filler has to exceed Ollama's DEFAULT window, or the probe passes
      // while the thing it tests is broken — which is what it did: 220
      // repetitions is ~3,245 tokens, comfortably inside the 4,096 default, so
      // the needle survived with no num_ctx set at all. A probe that passes on
      // a broken system is worse than no probe, and this one was cited as
      // evidence the context plumbing worked.
      //
      // 700 repetitions is ~10,300 tokens: past 4k with room to spare, and
      // still inside the 16k this asks for.
      const filler = 'The river ran on past the mill, and the mill kept turning. '.repeat(700);
      const res = await broker.call({
        noDownshift: true,
        taskId: null, runId: null, kind: 'bench', alias,
        sensitivity: 'S1',
        maxTokens: 64,
        numCtx: contextTokensFor('writing', 'author'),
        messages: [{
          role: 'user',
          content:
            `Remember this codeword exactly: ${NEEDLE}\n\n${filler}\n\n` +
            'What was the codeword? Reply with the codeword and nothing else.',
        }],
      });
      const ok = res.text.includes(NEEDLE);
      return {
        ok,
        evidence: ok
          ? `recalled the codeword across ~${Math.round(filler.length / 1000)}k chars (~${Math.round(filler.length / 4000)}k tokens, past the 4k default)`
          : `replied ${JSON.stringify(res.text.slice(0, 120))}`,
      };
    },
  },
  {
    id: 'schema-adherence',
    group: 'capability',
    matters:
      'The whole degradation contract rests on this. Earlier measurement showed that a 9B asked to ' +
      '"say what is wrong" writes an appreciation essay, and that a JSON schema alone does not ' +
      'constrain Ollama — the shape has to be in the prompt too. If this probe is red, ' +
      'schema-bound review does not work on this machine and the review seat must be a human.',
    async run({ broker }) {
      const alias = tierModel('owner');
      const schema = {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          issues: { type: 'array', items: { type: 'string' } },
        },
        required: ['verdict', 'issues'],
      };
      const res = await broker.call({
        noDownshift: true,
        taskId: null, runId: null, kind: 'bench', alias,
        sensitivity: 'S1',
        maxTokens: 300,
        json: schema,
        messages: [{
          role: 'user',
          content:
            'A function named `add(a, b)` returns `a - b`. Judge it.\n\n' +
            'Reply with ONLY this JSON shape:\n' +
            '{"verdict": "pass" | "fail", "issues": ["..."]}',
        }],
      });
      const parsed = extractJson<{ verdict?: unknown; issues?: unknown }>(res.text);
      const shapeOk = parsed !== null
        && (parsed.verdict === 'pass' || parsed.verdict === 'fail')
        && Array.isArray(parsed.issues);
      // Both halves matter and they are different failures: a reply that is not
      // the shape is unusable, and a reply that IS the shape but says a broken
      // function passes is worse, because it looks like a verdict.
      const judgedRight = shapeOk && parsed!.verdict === 'fail';
      return {
        ok: judgedRight,
        evidence: !shapeOk
          ? `off-shape reply: ${JSON.stringify(res.text.slice(0, 140))}`
          : judgedRight
            ? 'correct shape, and correctly failed a function that subtracts when it should add'
            : 'correct shape, but passed a function that subtracts when it should add',
      };
    },
  },
  {
    id: 'reviewer-disagreement',
    group: 'capability',
    matters:
      'The council only adds value if its two seats can actually disagree — two models that ' +
      'always answer identically are one model billed twice, and the chair never fires. This ' +
      'checks both local review seats independently reach the RIGHT answer on a planted bug.',
    async run({ broker }) {
      const aliases = [...new Set([tierModel('owner'), tierModel('senior', 'code')])];
      if (aliases.length < 2) return { skipped: 'only one distinct review model is configured' };
      const verdicts: string[] = [];
      for (const alias of aliases) {
        const res = await broker.call({
        noDownshift: true,
          taskId: null, runId: null, kind: 'bench', alias,
          sensitivity: 'S1', maxTokens: 200,
          json: { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'] },
          messages: [{
            role: 'user',
            content:
              'This diff changes `for (let i = 0; i <= xs.length; i++)` — note the `<=`.\n' +
              'Does it have a bug? Reply ONLY: {"verdict": "pass" | "fail"}',
          }],
        });
        verdicts.push(String(extractJson<{ verdict?: string }>(res.text)?.verdict ?? 'unparseable'));
      }
      const ok = verdicts.every((v) => v === 'fail');
      return {
        ok,
        evidence: aliases.map((a, i) => `${a}=${verdicts[i]}`).join('  ') +
          (ok ? '  (both caught the off-by-one)' : '  (an off-by-one that a reviewer calls a pass is what the chair exists for — but with no stronger rung, a miss here is a miss)'),
      };
    },
  },

  // ------------------------------------------------------------ plumbing
  {
    id: 'no-cloud-aliases',
    group: 'plumbing',
    matters:
      'Under the flag no cloud alias should be resolvable at all. A resolvable alias is one ' +
      'config edit away from live, and the point of the flag is that the machine cannot spend.',
    async run() {
      const cloud = [...specs().values()].filter((s) => !s.local);
      if (!localOnly()) return { skipped: 'FOREMAN_LOCAL_ONLY is not set' };
      return {
        ok: cloud.length === 0,
        evidence: cloud.length ? `still resolvable: ${cloud.map((s) => s.alias).join(', ')}` : 'no non-local alias resolves',
      };
    },
  },
  {
    id: 'tiers-resolve-local',
    group: 'plumbing',
    matters:
      'Every tier must name a model that exists and runs here. A tier pointing at a dead alias ' +
      'fails every ticket of that tier — and does it at launch, after a worktree has been cut.',
    async run() {
      const bad: string[] = [];
      for (const tier of ['owner', 'senior', 'worker'] as const) {
        const alias = tierModel(tier);
        try {
          if (!resolveSpec(alias).local) bad.push(`${tier}→${alias} is not local`);
        } catch {
          bad.push(`${tier}→${alias} does not resolve`);
        }
      }
      return {
        ok: bad.length === 0,
        evidence: bad.length ? bad.join('; ') : `owner=${tierModel('owner')} senior=${tierModel('senior')} worker=${tierModel('worker')}`,
      };
    },
  },
  {
    id: 'personas-served',
    group: 'plumbing',
    matters:
      'An adopted persona is already routed live work by modelForTask. If its server is not up, ' +
      'every ticket for that role refuses — correctly, but the operator finds out one ticket at ' +
      'a time. This is the one check that turns that into a single line.',
    async run() {
      const personas = adoptedPersonas();
      if (!personas.length) return { skipped: 'no persona has been adopted yet' };
      const down: string[] = [];
      for (const p of personas) if (!(await personaReachable(p))) down.push(p.id);
      return {
        ok: down.length === 0,
        evidence: down.length
          ? `not serving: ${down.join(', ')} — run \`foreman persona serve <id>\``
          : `${personas.length} adopted persona(s), all answering`,
      };
    },
  },
  {
    id: 'timeout-coherence',
    group: 'plumbing',
    matters:
      'Two ceilings bound a drafting run and they bound different things. The per-call timeout ' +
      'is an IDLE one \u2014 it only has to outlast the longest plausible silence, which is the wait ' +
      'for the FIRST chunk (model load plus evaluation of a 16k-token prompt on a cold 9B), not ' +
      'the whole generation. The task timeout is the one that has to cover the generation end to ' +
      'end. Confuse the two and either an ordinary long draft is killed mid-scene, or a genuinely ' +
      'wedged call hangs for the length of the task.',
    async run() {
      const maxTokens = maxOutputTokensFor('writing', 'author');
      const idleTimeout = timeoutForCall({ maxTokens, local: true });
      // ~8 tok/s measured on this machine, wall clock including model load.
      const generationMs = (maxTokens / 8) * 1000;
      // A cold 9B loading 8.5 GB and evaluating a full prompt before its first
      // token. Measured at well under a minute here; 3 minutes is the margin.
      const worstFirstChunkMs = 180_000;
      const problems: string[] = [];
      if (idleTimeout < worstFirstChunkMs) {
        problems.push(
          `per-call idle timeout ${Math.round(idleTimeout / 1000)}s < the ~${worstFirstChunkMs / 1000}s a cold ` +
          'model can take to produce its first chunk',
        );
      }
      // A drafting run is a full generation plus the turns around it. Two is
      // the floor for "the run can finish and still be repaired once".
      if (config.taskTimeoutMs < generationMs * 2) {
        problems.push(
          `FOREMAN_TASK_TIMEOUT_MS ${Math.round(config.taskTimeoutMs / 60_000)}m leaves no room for a ` +
          `~${Math.round(generationMs / 60_000)}m draft plus its repair round \u2014 raise it`,
        );
      }
      return {
        ok: problems.length === 0,
        evidence: problems.length
          ? problems.join('; ')
          : `${maxTokens} tok \u2248 ${Math.round(generationMs / 60_000)}m generation, bounded by the ` +
            `${Math.round(config.taskTimeoutMs / 60_000)}m task timeout; per-call idle allowance ` +
            `${Math.round(idleTimeout / 60_000)}m covers a cold first chunk`,
      };
    },
  },
  {
    id: 'gate-retirable',
    group: 'plumbing',
    matters:
      'The question the whole shadow ledger exists to answer: is the local reviewer good enough ' +
      'that the cloud one can be switched off? Until this is green, keep a reviewer in the loop \u2014 ' +
      'a cloud one while there is still a subscription, the operator after that. It is a probe ' +
      'rather than a paragraph so that "good enough" is a threshold defined in advance, not a ' +
      'judgement made while looking at the number.',
    async run({ store }) {
      if (!shadowEnabled()) {
        return { skipped: 'FOREMAN_SHADOW_LOCAL is not set \u2014 nothing is being recorded to judge from' };
      }
      const rows = agreementReport(store).filter((r) => r.role !== 'ALL');
      if (!rows.length) return { skipped: 'no shadow verdicts recorded yet' };
      const notReady = rows.filter((r) => !r.ready);
      // The trend is the part worth reporting even in the failure case: it is
      // the difference between "not yet" and "not ever".
      const trendOf = (r: (typeof rows)[number]): string =>
        r.trend == null ? '' : ` ${r.trend >= 0 ? '+' : ''}${(r.trend * 100).toFixed(0)}%`;
      return {
        ok: notReady.length === 0,
        evidence: notReady.length
          ? `${rows.length - notReady.length}/${rows.length} roles ready; still short: ` +
            notReady.map((r) => `${r.playbook ?? '?'}.${r.role ?? '?'} (${r.samples}n ${(r.agreementRate * 100).toFixed(0)}%${trendOf(r)}` +
              `${r.falsePasses ? `, ${r.falsePasses} false-pass` : ''})`).join(', ')
          : `every role meets the criterion: ${rows.map((r) => `${r.role} ${r.samples}n ${(r.agreementRate * 100).toFixed(0)}%`).join(', ')}`,
      };
    },
  },
  {
    id: 'model-plane-reachable',
    group: 'plumbing',
    matters:
      'The flat failure: ollama is not running, or the model named in the roster was never ' +
      'pulled. Everything else in this drill is downstream of it.',
    async run({ broker }) {
      const alias = tierModel('worker');
      const res = await broker.call({
        noDownshift: true,
        taskId: null, runId: null, kind: 'bench', alias, sensitivity: 'S1', maxTokens: 4,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      });
      return { ok: res.text.trim().length > 0, evidence: `${alias} answered in ${res.latencyMs}ms` };
    },
  },
];

/** Run the drill. Sequential by design: two local models at once thrash VRAM. */
export async function runDrill(
  ctx: ProbeCtx & { only?: ProbeGroup; onProgress?: (line: string) => void },
): Promise<DrillReport> {
  const results: ProbeResult[] = [];
  for (const probe of PROBES) {
    if (ctx.only && probe.group !== ctx.only) continue;
    ctx.onProgress?.(`${probe.id}…`);
    const started = Date.now();
    try {
      const out = await probe.run(ctx);
      results.push('skipped' in out
        ? { id: probe.id, group: probe.group, matters: probe.matters, ok: false, evidence: '', skipped: out.skipped, ms: Date.now() - started }
        : { id: probe.id, group: probe.group, matters: probe.matters, ok: out.ok, evidence: out.evidence, skipped: null, ms: Date.now() - started });
    } catch (err) {
      // A probe that throws is a red probe, not a crashed drill: the operator
      // needs the other nine results more than they need this stack trace.
      results.push({
        id: probe.id, group: probe.group, matters: probe.matters,
        ok: false, evidence: `probe threw: ${(err as Error).message.slice(0, 200)}`,
        skipped: null, ms: Date.now() - started,
      });
    }
  }
  return {
    localOnly: localOnly(),
    ranAt: Date.now(),
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
  };
}

export const probeIds = (): string[] => PROBES.map((p) => p.id);
