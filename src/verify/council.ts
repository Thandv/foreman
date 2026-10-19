import { createHash } from 'node:crypto';
import { Broker, steppedDownError } from '../budget.ts';
import { readBench } from '../bench.ts';
import { localOnly } from '../localOnly.ts';
import { triageDiff } from './triage.ts';
import { compactDiff } from '../context.ts';
import { config } from '../config.ts';
import { extractJson, pickAlias, seedFor, specs, type ChatMessage } from '../models.ts';
import type { Store } from '../queue.ts';
import type { AdvisorOpinion, CouncilVerdict, Task, Verdict } from '../types.ts';

export interface Evidence {
  /** The primary thing under review: a diff, a draft, a research answer. */
  body: string;
  /** What the body is, in one word, for the prompt. */
  bodyLabel: string;
  testsPassed: boolean | null;
  testOutput?: string;
  logTail?: string;
}

const MAX_BODY = 12_000;
/**
 * The largest context window a council call will ask for, and therefore the
 * largest evidence it may carry. One number, so the two cannot drift: an
 * evidence cap above the window is a prompt whose front gets silently dropped.
 */
const COUNCIL_CTX_CEILING = (() => {
  const env = Number(process.env['FOREMAN_COUNCIL_NUM_CTX']);
  return Number.isFinite(env) && env > 0 ? Math.trunc(env) : 16384;
})();

/**
 * Bump when the rubrics or advisor system prompt change: it is part of the
 * council cache key, so a change invalidates every stale cached opinion.
 * v2: verdicts moved to a capped, structured {"issues":[...]} shape and the
 * prompt was reordered for KV-prefix reuse — both invalidate old replies.
 */
export const RUBRIC_VERSION = 2;

/** Cache key for one advisor's opinion: (model, rubric version, exact prompt). */
/** Decoding settings the council pins, so a verdict is reproducible. */
export const COUNCIL_TEMPERATURE = 0;

function opinionKey(
  model: string,
  messages: ChatMessage[],
  decoding: { temperature: number; seed: number; numCtx: number; maxTokens: number },
): string {
  const content = messages.map((m) => `${m.role}\u0000${m.content}`).join('\u0001');
  // temperature and seed are part of the identity of an opinion: the same
  // prompt decoded differently is a different answer, and conflating them
  // would let the cache serve a verdict produced under other settings.
  //
  // So are the WINDOW and the output ceiling, and they were missing. A verdict
  // reached with no num_ctx set was reached with the system message and the
  // rubric silently dropped off the front — the model judged a chapter it had
  // never been told how to judge. Raising num_ctx fixes new calls and does
  // nothing about the cache, which would keep serving those blind verdicts
  // forever under a key that says they were decoded at temperature 0.
  return createHash('sha256')
    .update(
      `${model}\u0000${RUBRIC_VERSION}\u0000t${decoding.temperature}\u0000s${decoding.seed}\u0000${content}`,
    )
    .digest('hex');
}

/** Quality is defined before generation, per kind, not after seeing the output. */
const RUBRICS: Record<Task['kind'], string> = {
  code: [
    'Does the change actually do what the task asked?',
    'Correctness: off-by-one, null/undefined paths, error handling, resource leaks, races.',
    'Does it break any caller or contract visible in the diff?',
    'Security: injection, path traversal, secrets in logs, unsafe deserialization.',
    'Scope: unrelated drive-by edits are a fail. Missing work that was never requested is NOT.',
  ].join('\n- '),
  // Deliberately ONE question, where the others ask four.
  //
  // Measured: asked for four claim kinds at once a local reviewer returns a
  // thin sample of each and misses the error a targeted prompt finds instantly.
  // On prose that degrades further — four open-ended aesthetic questions is an
  // invitation to write an essay, which is exactly what twenty-two chapter
  // reviews did. Fulfilment of the brief is the one thing a reviewer can be
  // wrong about in a way that matters; voice and clichés are what the prose
  // gate and the tic counter measure deterministically, for free.
  writing: [
    'ONLY judge this: does the text fulfil the brief above, in the requested form and length, ' +
    'with no invented facts? Ignore style, voice and taste entirely — other tools measure those.',
  ].join('\n- '),
  research: [
    'Is every factual claim traceable to a named source in the answer?',
    'Are there unsupported leaps, or confident statements where the evidence is thin?',
    'Does it answer the question asked, rather than a nearby easier one?',
    'Are counter-arguments or contrary evidence acknowledged?',
  ].join('\n- '),
  tool: [
    'Does the tool do exactly what its manifest description and input schema promise?',
    'Does it validate its input, and fail loudly rather than silently producing wrong output?',
    'Does it read stdin as JSON and write a single JSON object to stdout, and nothing else?',
    'Security: does it touch anything outside its working directory, the network, or the environment?',
    'Do its own tests actually exercise the behaviour, rather than asserting it was written?',
  ].join('\n- '),
  general: [
    'Does the output satisfy the task as written?',
    'Is anything asserted that the evidence does not support?',
    'Are there obvious errors, omissions, or unfinished work?',
  ].join('\n- '),
};

const ADVISOR_SYSTEM = [
  'You are a reviewer on a verification council. Your job is to find what is WRONG with THIS change.',
  'Finding nothing is a suspicious result — say so explicitly if the work genuinely looks clean.',
  'Judge only whether the request below was fulfilled correctly and safely.',
  'Do NOT fail the work for: anything the task did not ask for, pre-existing problems outside the change,',
  'stylistic preferences, missing features that were never requested, or warnings from unrelated tooling.',
  'A change that does exactly what was asked, correctly, is a PASS even if you would have written it differently.',
  // A real, repeated misread: shown a compacted diff, the reviewer treated
  // Foreman\'s own reading cap as a length limit the task had imposed and
  // failed the work for "exceeding the 24,000-byte cap". Twelve of twenty-two
  // re-reviews failed on artefacts of this kind rather than on the work.
  'Anything in square brackets beginning with FOREMAN is this system\'s own note about how the evidence',
  'was prepared for you. It is NOT part of the task, NOT a constraint the worker was given, and NOT',
  'something the worker did. Never fail work for a length, a cap or a truncation named in such a note.',
  'Reply with JSON only, no prose outside the object: ' +
    '{"verdict":"pass"|"fail","confidence":0.0-1.0,"issues":["<= 6 items, each <= 20 words, concrete and actionable"]}.',
  'issues may be empty on a pass; on a fail, name the specific things that are wrong.',
].join(' ');

/**
 * The verdict shape, as a JSON Schema, so the runtime constrains decoding
 * instead of the prompt merely requesting a shape. Asked only for "JSON", a
 * local 8-14B model happily returns a well-formed object of its own design —
 * an observed reply was `{"title":"Review of the provided text","author":"AI
 * Assistant"}`, which parses, means nothing, and counts as an unreachable
 * advisor. Every advisor and chair call is decoded against this.
 */
export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    confidence: { type: 'number' },
    issues: { type: 'array', maxItems: 6, items: { type: 'string' } },
  },
  required: ['verdict', 'confidence', 'issues'],
  additionalProperties: false,
};

const CHAIR_SYSTEM =
  'You chair a verification council whose reviewers disagreed. Weigh their arguments against the evidence, ' +
  'not against each other\'s tone. Reply with JSON only, no prose outside the object: ' +
  '{"verdict":"pass"|"fail","confidence":0.0-1.0,"issues":["<= 6 items, each <= 20 words, explaining the deciding factor"]}.';

/**
 * Static text first, per-task content last: on ollama consecutive calls that
 * share a prompt prefix reuse its KV cache instead of re-computing attention
 * over it. The rubric is byte-identical across every task of the same kind,
 * so it belongs immediately after the (also static) system message; the
 * diff, title, request and logs are unique per task and must trail it.
 */
/**
 * Prose is reviewed whole or it is not reviewed.
 *
 * `crewReview.ts` has known this since it was written; the council never got
 * the same fix, and compacted a chapter at the 24 KB CODE cap. A typical novel
 * chapter is ~23 KB of text, so its diff crosses the cap by a hair, gets cut
 * mid-word, and the reviewer then reports what it sees: "the text cuts off
 * mid-sentence ('which needs a cha'), failing the requirement to write a
 * complete chapter." The chapter was complete. The cut was ours.
 *
 * config.ts already carries the reasoning verbatim — "the code cap cuts a
 * developmental editor off two-thirds of the way through the draft it was
 * asked to judge, and the letter it writes then reports beats as missing that
 * are simply past the cut." That applies to a council advisor exactly as it
 * applies to a crew reviewer.
 */
function capsFor(task: Task): { diff: number; body: number } {
  const prose = task.kind === 'writing';
  const cap = prose ? config.proseDiffCapBytes : config.diffCapBytes;
  // ...but never more than the window we are going to ask for. The prose cap
  // is 160 KB, roughly 40,000 tokens, while councilNumCtx clamps at 16k — so
  // a long chapter still overflowed and Ollama still dropped the FRONT, which
  // is where the rubric lives. The trailing "reply with JSON" instruction
  // survives, so the reply is schema-valid: a well-formed verdict about a
  // brief the model never saw. Cutting it ourselves, visibly, is the whole
  // difference between a short review and a confident wrong one.
  const windowBytes = COUNCIL_CTX_CEILING * 4 - 4_000;
  return { diff: Math.min(cap, windowBytes), body: Math.min(prose ? cap : MAX_BODY, windowBytes) };
}

export function buildPrompt(task: Task, evidence: Evidence): string {
  // A diff is compacted deterministically (stat summary + the largest hunks);
  // prose is tail-truncated. Either way the council prompt is bounded by code,
  // never by paying a model to read a 500 KB dump.
  const caps = capsFor(task);
  const body = evidence.bodyLabel === 'diff'
    ? compactDiff(evidence.body, caps.diff)
    : evidence.body.length > caps.body
      ? `${evidence.body.slice(0, caps.body)}\n… [FOREMAN cut this here for review: ${evidence.body.length - caps.body} more chars follow in the real output, which is complete]`
      : evidence.body;
  const parts = [
    // --- static prefix (identical for every task of this kind) -----------
    `REVIEW CRITERIA:\n- ${RUBRICS[task.kind]}`,
    // --- variable, per-task content (must stay last) ----------------------
    `TASK: ${task.title}`,
    `REQUEST:\n${task.prompt}`,
  ];
  if (evidence.testsPassed !== null) {
    parts.push(`TEST RESULT: ${evidence.testsPassed ? 'passed' : 'FAILED'}\n${(evidence.testOutput ?? '').slice(0, 2000)}`);
  }
  if (evidence.logTail) parts.push(`WORKER LOG (tail):\n${evidence.logTail.slice(0, 2000)}`);
  parts.push(`${evidence.bodyLabel.toUpperCase()} UNDER REVIEW:\n${body || '(the worker produced nothing)'}`);
  // The shape, restated AFTER the evidence, and this is not belt-and-braces.
  //
  // Twenty-two chapter reviews in this ledger came back as
  //   "Based on the text provided, here is a structured summary and analysis…"
  // — an unparseable reply, so no advisor could be reached, so `split`, so a
  // human was asked to decide something nobody had reviewed. The instruction
  // to answer in JSON was in the system message, at the FRONT, twenty-five
  // thousand words of chapter ago. Whatever the window does to the front of a
  // prompt, the last thing a reviewer reads is the thing it obeys.
  parts.push(
    'Reply with ONLY this JSON object and no prose before or after it:\n' +
    '{"verdict":"pass"|"fail","confidence":0.0-1.0,"issues":["..."]}\n' +
    'Do not summarise the text above. Do not analyse it as literature. Judge it against the ' +
    'REVIEW CRITERIA and answer in the shape above.',
  );
  return parts.join('\n\n');
}

/**
 * The context window one council call needs, and the reason it must be set.
 *
 * Ollama defaults to roughly 4k tokens and SILENTLY DISCARDS the front of
 * anything longer. A prose review carries up to 160 KB of chapter — about
 * 40,000 tokens — so the system message, the rubric and the request were all
 * dropped before the model ever saw them, leaving it holding the tail of a
 * novel with no instructions. It did the only sensible thing with that and
 * summarised it. Every one of the twenty-two splits is that.
 *
 * Sized from the prompt, clamped to what this machine can actually hold: a
 * 40k-token KV cache on a 9B is not a review, it is a swap storm.
 */
export function councilNumCtx(prompt: string): number {
  const ceiling = COUNCIL_CTX_CEILING;
  const needed = Math.ceil(prompt.length / 4) + config.councilMaxOutputTokens + 256;
  return Math.min(ceiling, Math.max(4096, needed));
}

/**
 * Verdicts are a capped, structured shape — {"verdict","confidence","issues":[...]}
 * — rather than free-form prose: it bounds output tokens and makes disagreement
 * mechanically comparable. Fail-closed: anything that does not parse into a
 * valid verdict returns null, and the caller treats that as not-a-pass.
 */
/** The rubric asks for at most six; nothing downstream should have to trust that. */
export const MAX_ISSUES_PER_OPINION = 6;

/**
 * Whether any reviewer actually read the work.
 *
 * An opinion carrying an `error` is a reviewer that could not be reached or
 * could not be parsed — it is not a judgement, and a verdict made only of those
 * is not a review. This exists because a ticket whose every advisor timed out
 * parked at the human gate labelled "council split — needs your call", which
 * reads as *reviewers looked and disagreed* when in fact nothing looked at it.
 * Three chapters shipped to the gate that way.
 */
export function wasReviewed(verdict: { council: AdvisorOpinion[] } | null): boolean {
  if (!verdict) return false;
  return verdict.council.some((opinion) => !opinion.error);
}

export function parseOpinion(text: string): { verdict: 'pass' | 'fail'; confidence: number; critique: string } | null {
  const parsed = extractJson<{ verdict?: string; confidence?: number; issues?: unknown; critique?: unknown; reason?: unknown }>(text);
  if (!parsed) return null;
  const verdict = String(parsed.verdict ?? '').toLowerCase();
  if (verdict !== 'pass' && verdict !== 'fail') return null;
  const confidence = Number(parsed.confidence);
  // `issues` is the asked-for shape, but a model that answers with `critique`
  // or `reason` is still telling us what is wrong — and dropping that would
  // hand the repair round a fail with no reason attached, which is the one
  // thing the repair round exists to carry.
  const raw = Array.isArray(parsed.issues)
    ? parsed.issues
    : [parsed.issues, parsed.critique, parsed.reason].find((v) => typeof v === 'string' && v.trim())
      ? [(parsed.issues ?? parsed.critique ?? parsed.reason) as string]
      : [];
  // Deduped, then capped at the six the rubric asks for. A small local model
  // under a schema will happily fill the array with one grievance restated
  // twenty times; that is one issue, and a repair round given it twenty times
  // reads the same complaint as twenty separate defects.
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const entry of raw) {
    const issue = String(entry).trim();
    if (!issue) continue;
    const key = issue.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
    if (issues.length === MAX_ISSUES_PER_OPINION) break;
  }
  return {
    verdict,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    critique: issues.join('; ').slice(0, 4000),
  };
}

export const MAX_RUNG = 2;

/**
 * Which rung of the ladder a task starts on. High priority and a task that has
 * already been round the repair loop both buy a better council, because both
 * mean a wrong verdict is expensive.
 */
export function rungFor(task: Pick<Task, 'priority' | 'repairs'>): number {
  let rung = 0;
  if (task.priority >= Number(process.env['FOREMAN_HIGH_PRIORITY'] ?? 5)) rung++;
  if (task.repairs > 0) rung++;
  return Math.min(MAX_RUNG, rung);
}

/**
 * Two genuinely different advisors plus the strongest available chair, chosen for the rung.
 * Rung 0 is the cheap-first pair; each rung up swaps in stronger models, and
 * the top rung may leave the machine — unless the task is S2, which never does.
 */
/**
 * Models that may never review, chair or judge under local-only. Keyed on the
 * concrete model name rather than the alias, because an operator's models.json
 * can point any alias at anything.
 */
const BANNED_REVIEW_MODELS = new Set(['llama3.1:8b']);

export function councilAliases(
  sensitivity: Task['sensitivity'],
  rung = 0,
  kind?: Task['kind'],
): { advisors: string[]; chair: string; rung: number } {
  const available = [...specs().values()]
    .filter((s) => sensitivity !== 'S2' || s.local)
    // The local-only policy: llama3.1:8b is pinned out of every advisor, chair and judge
    // seat under local-only. It benched 0.25 on reasoning and, in the one live
    // council run on record, misread the diff twice. With cloud models gone
    // there is no stronger rung above it to catch that, so it does not sit.
    .map((s) => s.alias);
  // Seats never go to a banned model while anything else exists — in every
  // mode, not just local-only (below). The registry keeps it as a last resort.
  // Step-down-only models (the cheap coder) reach a council only through the
  // broker, marked, so the verdict is provisional — never seated directly.
  const seatable = available.filter((a) =>
    !BANNED_REVIEW_MODELS.has(specs().get(a)?.model ?? '') && !specs().get(a)?.stepDownOnly);
  const pool = localOnly() || seatable.length ? seatable : available;

  const benched = readBench()?.roster ?? {};
  // Cheap-first, then measured-best, then off-machine. Once a bench exists the
  // rungs follow the measurements rather than the conventional alias names —
  // a model that reviews badly should not sit on rung 0 just because of its name.
  const fast = benched['fast'] ?? 'local-fast';
  const reason = benched['reason'] ?? 'local-reason';
  // Two advisors are only two opinions if they are two MODELS. When two models
  // tie on the bench the roster names the faster one for both seats — on this
  // machine the 9B won reason AND code — and `[reason, code]` collapsed to one
  // alias, so the seat went to whatever came next: the 2B on a manuscript, or
  // llama. The code seat falls back to the conventional coder when that happens.
  const benchedCode = benched['code'] ?? 'local-code';
  const code = benchedCode === reason ? 'local-code' : benchedCode;
  // Prose never gets the `fast` seat. Rung 0 leads with the cheapest capable
  // model, which is right for a diff and wrong for a chapter: a 2B handed
  // 6,000 tokens of manuscript produced nothing at all inside the 180s idle
  // timeout, and one absent advisor is what turns a review into a split. Size
  // is not a preference here, it is whether an answer arrives.
  //
  // `local-general` (llama3.1:8b) sits on no rung: it benched 0.25 on reasoning
  // and misread a diff twice in the one live council on record. It stays in
  // the registry as a last resort when nothing better is reachable.
  const prose = kind === 'writing';
  const ladder: string[][] = localOnly() || prose
    ? [[reason, code], [code, reason], [reason, code]]
    : [[fast, code], [code, reason], [reason, code]];
  const effective = Math.min(Math.max(0, rung), ladder.length - 1);
  // The conventional names close the list, so a bench that names one model
  // for two seats still leaves a second strong model to fall back to before
  // anything weaker; local models come before remote ones for the same reason.
  const preferred = [...new Set([...ladder[effective]!, ...ladder.flat(), 'local-reason', 'local-code'])];
  const isLocal = (a: string): boolean => specs().get(a)?.local ?? false;
  const ordered = [
    ...preferred.filter((a) => pool.includes(a)),
    ...pool.filter((a) => !preferred.includes(a) && isLocal(a)),
    ...pool.filter((a) => !preferred.includes(a) && !isLocal(a)),
  ];
  const fastModel = specs().get(fast)?.model ?? fast;
  const isFast = (a: string): boolean => (specs().get(a)?.model ?? a) === fastModel;
  // Seat two DIFFERENT models when two exist: aliases can share weights (a
  // models.json entry, a bench roster), and two seats on one model is one
  // opinion counted twice.
  const advisors: string[] = [];
  const seatedModels = new Set<string>();
  for (const alias of ordered) {
    if (advisors.length === 2) break;
    if (prose && isFast(alias) && ordered.some((a) => !isFast(a) && !advisors.includes(a))) continue;
    const model = specs().get(alias)?.model ?? alias;
    if (seatedModels.has(model)) continue;
    advisors.push(alias);
    seatedModels.add(model);
  }
  for (const alias of ordered) {
    if (advisors.length >= 2) break;
    if (!advisors.includes(alias)) advisors.push(alias);
  }
  if (advisors.length === 1) advisors.push(advisors[0]!); // degraded: same model twice

  // The chair is the one seat that DECIDES: it runs only when the advisors
  // disagree, and its verdict is final. It used to be "the next alias in the
  // list", which on this roster was always the 2B or llama — the two weakest
  // reasoners deciding every disagreement the two strongest could not settle.
  //
  // Now it is the strongest reasoner available. Off the machine only at the
  // top rung, where the ladder has always been allowed to leave it (opus there;
  // S2 and local-only never, because `available` already excludes it). If the
  // strongest local model is already an advisor, it is still named here —
  // runCouncil refuses to let a model that argued one side decide, and the
  // split escalates or parks for the operator (local-only policy).
  const cloudChairs = effective >= 2 ? ['gateway-chair', 'opus', 'sonnet'] : [];
  const chairPreference = [...cloudChairs, reason, code, 'local-reason', 'local-code'];
  const candidates = chairPreference.filter((a) => pool.includes(a));
  const chair = candidates.find((a) => !advisors.includes(a))
    ?? candidates[0]
    ?? ordered.find((a) => !advisors.includes(a))
    ?? pickAlias(['local-reason'], sensitivity);
  return { advisors, chair, rung: effective };
}

export interface CouncilOptions {
  store: Store;
  broker: Broker;
  task: Task;
  runId: string;
  evidence: Evidence;
  signal?: AbortSignal;
  onNote?: (line: string) => void;
  /** Ladder rung; defaults to what the task's priority and repairs imply. */
  rung?: number;
  /**
   * A shadow review (scheduler.ts:recordShadowVerdict) is non-binding: it must
   * not write a verdict row, which would overwrite the run's verdict and — if
   * it ran stepped down — block the gate and trigger a re-check of a ticket
   * the authoritative reviewer already decided.
   */
  shadow?: boolean;
  /**
   * Checked immediately before the verdict is written; false means the work
   * moved on while the review ran (approved, rejected, re-run) and the verdict
   * is discarded. Synchronous with the write, so nothing can land in between.
   */
  stillCurrent?: () => boolean;
}

/**
 * Fan out to independent advisors; only pay for the chair when they disagree.
 * Fail-closed: a council that cannot form an opinion returns `split`, never a
 * pass, and the caller must treat `split` as "a human looks at this".
 */
export async function runCouncil(opts: CouncilOptions): Promise<Verdict> {
  // Opt-in fast tier: a docs/whitespace/config-only diff can be reviewed once
  // instead of by the full council. A `pass` ends it; anything else falls
  // through to the full council. One seat by design, opt-in, and only for those
  // diffs — not a lost seat: a lone SURVIVING pass, where a seat was asked and
  // gave nothing usable, is a split (councilRound).
  const triage = triageDiff(opts.evidence.bodyLabel === 'diff' ? opts.evidence.body : '');
  if (triage.tier === 'fast') {
    opts.onNote?.(`fast-verify: ${triage.reason} — one review instead of the full council`);
    const quick = await councilRound({ ...opts, onNote: opts.onNote }, 0, { fast: true });
    if (quick.verdict === 'pass') return quick;
    opts.onNote?.('fast-verify did not pass — falling back to the full council');
  }

  let from = opts.rung ?? rungFor(task_(opts));
  let verdict = await councilRound(opts, from);

  // A split is exactly the case where a better council is worth paying for.
  // An ordinary split climbs once, as it always has. A split that was HANDED
  // UP by a conflicted chair keeps climbing until a chair that argued neither
  // side decides — otherwise "handing up" would be a promise the next rung's
  // own conflicted chair could break. Bounded: `from` strictly increases and
  // stops at MAX_RUNG.
  for (let climbs = 0; verdict.verdict === 'split' && from < MAX_RUNG; climbs++) {
    const parked = verdict;
    let next: number;
    if (verdict.chairSummary?.startsWith(LOST_SEAT)) {
      // A lost-seat split climbs only to DIFFERENT advisors — the 2B answering
      // off-contract at rung 0 is the common case, and rung 1 seats the coder
      // and the 9B. Not to the same advisors: a rung that differs only by a
      // chair this split never consults would ask the same models the same
      // question. Not when memory lost the seat (provisional): bigger models
      // under the same pressure stall again; the re-check sweep re-asks once
      // the council fits.
      if (verdict.provisional) {
        opts.onNote?.('a seat was lost to memory — parked for the full-council re-check rather than climbing');
        break;
      }
      next = from + 1;
      while (next <= MAX_RUNG && sameAdvisors(task_(opts), from, next)) next++;
      if (next > MAX_RUNG) {
        opts.onNote?.('a seat answered nothing usable and no higher rung seats different advisors — parking for a human');
        break;
      }
      opts.onNote?.(`a seat answered nothing usable — asking rung ${next}'s advisors`);
    } else {
      const conflicted = verdict.chairSummary?.startsWith(CONFLICTED_CHAIR) ?? false;
      if (climbs > 0 && !conflicted) break;
      // On a two-model roster the next rung is often the same pair with the
      // seats swapped — two more cold loads on a 17 GB machine to learn nothing.
      next = (conflicted ? independentRungAbove(task_(opts), from) : null) ?? from + 1;
      while (next < MAX_RUNG && sameCouncil(task_(opts), from, next)) next++;
      if (sameCouncil(task_(opts), from, next)) {
        opts.onNote?.('council split — no higher rung seats a different council; parking for a human');
        break;
      }
      opts.onNote?.(`council split — escalating to rung ${next}`);
    }
    verdict = await councilRound(opts, next);
    from = next;
    // A climb that heard from fewer advisors than the round it replaced is
    // worse evidence — at worst nobody at all, which would park the work as
    // UNREVIEWED after a reviewer had read it, and a rung-1 lost seat would
    // bury a rung-0 FAIL. Keep the earlier word, as the run's newest verdict
    // row again, so the gate, the board and the re-check sweep all read it.
    // Except over a FAIL: a lone FAIL stands wherever it is heard (councilRound),
    // and failing closed sends the work to repair rather than back to a split.
    if (verdict.verdict !== 'fail' && usableCount(verdict) < usableCount(parked)) {
      opts.onNote?.('the higher rung heard from fewer advisors — keeping the earlier verdict');
      verdict = reinstate(opts, parked);
      break;
    }
  }
  return verdict;
}

const usableCount = (v: Verdict): number => v.council.filter((o) => !o.error).length;

/** Write an earlier round's verdict again so it is the run's newest row. */
function reinstate(opts: CouncilOptions, v: Verdict): Verdict {
  if (opts.signal?.aborted) throw new Error('council aborted before it reached a verdict');
  if (opts.shadow) return v;
  if (opts.stillCurrent && !opts.stillCurrent()) {
    throw new Error('the task moved on while it was being reviewed; this verdict was discarded');
  }
  return opts.store.addVerdict({
    runId: v.runId, taskId: v.taskId, verdict: v.verdict, disagreement: v.disagreement, council: v.council,
    chairSummary: v.chairSummary, critique: v.critique, costUsd: 0, provisional: v.provisional,
  });
}

const task_ = (opts: CouncilOptions): Task => opts.task;

const modelOf = (alias: string): string => specs().get(alias)?.model ?? alias;

/** Marks a split that was handed up rather than decided; the escalation reads it back. */
const CONFLICTED_CHAIR = 'no independent chair at this rung';

/** Marks a split made because a seat answered nothing usable and the rest passed. */
const LOST_SEAT = 'a seat answered nothing usable';

export { chairRuled } from '../types.ts';

/** The chair is one of the models that just disagreed. */
function chairConflicted(usable: AdvisorOpinion[], chair: string): boolean {
  const model = specs().get(chair)?.model;
  // A chair that no longer resolves (the registry was reloaded mid-council) is
  // not a conflicted chair — the call below fails and that is a split.
  return model !== undefined && usable.some((o) => o.model === model);
}

/**
 * The rung a conflicted split should be handed to: the first one above that
 * seats a different council AND whose chair is not one of its own advisors —
 * so the chair there cannot be conflicted in turn. Null when none exists.
 * Both the decision to hand a split up and the escalation itself use this, so
 * a round never says "escalating" and then lands on another conflicted chair.
 */
export function independentRungAbove(task: Pick<Task, 'sensitivity' | 'kind'>, rung: number): number | null {
  for (let r = rung + 1; r <= MAX_RUNG; r++) {
    if (sameCouncil(task, rung, r)) continue;
    const c = councilAliases(task.sensitivity, r, task.kind);
    const chairModel = modelOf(c.chair);
    if (!c.advisors.some((a) => modelOf(a) === chairModel)) return r;
  }
  return null;
}

function independentChairAbove(task: Task, rung: number, usable: AdvisorOpinion[]): boolean {
  const r = independentRungAbove(task, rung);
  if (r === null) return false;
  const chairModel = modelOf(councilAliases(task.sensitivity, r, task.kind).chair);
  return !usable.some((o) => o.model === chairModel);
}

/** Two rungs whose ADVISORS are the same models (seats and chair aside) ask the same question. */
function sameAdvisors(task: Pick<Task, 'sensitivity' | 'kind'>, a: number, b: number): boolean {
  const key = (r: number): string => councilAliases(task.sensitivity, r, task.kind).advisors.map(modelOf).sort().join('+');
  return key(a) === key(b);
}

/** Two rungs that would seat the same models in the same roles are one rung. */
function sameCouncil(task: Pick<Task, 'sensitivity' | 'kind'>, a: number, b: number): boolean {
  const x = councilAliases(task.sensitivity, a, task.kind);
  const y = councilAliases(task.sensitivity, b, task.kind);
  const key = (c: typeof x): string => `${c.advisors.map(modelOf).sort().join('+')}|${modelOf(c.chair)}`;
  return key(x) === key(y);
}

async function councilRound(
  opts: CouncilOptions,
  rungIn: number,
  mode: { fast?: boolean } = {},
): Promise<Verdict> {
  const { store, broker, task, runId, evidence } = opts;
  const full = councilAliases(task.sensitivity, rungIn, task.kind);
  // The fast tier is one reviewer, and the cheapest capable one.
  const advisors = mode.fast ? full.advisors.slice(0, 1) : full.advisors;
  const { chair, rung } = full;
  // The ledger should say which tier paid for a review, not just which rung.
  const lane = mode.fast ? 'fast' : `r${rung}`;
  const prompt = buildPrompt(task, evidence);
  const numCtx = councilNumCtx(prompt);
  const messages: ChatMessage[] = [
    { role: 'system', content: ADVISOR_SYSTEM },
    { role: 'user', content: prompt },
  ];

  // Every seat that ran on a stepped-down model; any at all makes the verdict provisional.
  const downshifts: string[] = [];
  const opinions: AdvisorOpinion[] = await Promise.all(
    advisors.map(async (alias, i): Promise<AdvisorOpinion> => {
      const spec = specs().get(alias)!;
      // A nudge apart so two runs of the same model are not one opinion twice.
      const advisorMessages: ChatMessage[] = i === 0
        ? messages
        : [messages[0]!, { role: 'user', content: `${prompt}\n\nReview independently; be sceptical.` }];

      // Memoisation: an identical (model, rubric, prompt) was already judged.
      // Reuse it and book a $0 receipt so the ledger stays honest about the win.
      const seed = seedFor(advisorMessages.map((m) => m.content).join('\u0001'));
      const cacheKey = opinionKey(spec.model, advisorMessages, {
        temperature: COUNCIL_TEMPERATURE, seed, numCtx, maxTokens: config.councilMaxOutputTokens,
      });
      const cached = store.getCachedOpinion(cacheKey);
      if (cached) {
        store.addReceipt({
          taskId: task.id, runId, kind: `council@${lane}:cache`,
          provider: spec.provider, model: spec.model, local: spec.local, costUsd: 0, reservedUsd: 0,
        });
        opts.onNote?.(`${alias}: ${cached.verdict} (${cached.confidence.toFixed(2)}) [cached, $0] ${cached.critique.slice(0, 120)}`);
        return {
          model: spec.model, provider: spec.provider, local: spec.local,
          verdict: cached.verdict, confidence: cached.confidence, critique: cached.critique,
          costUsd: 0, latencyMs: 0,
        };
      }

      try {
        const res = await broker.call({
          taskId: task.id,
          runId,
          kind: `council@${lane}`,
          alias,
          messages: advisorMessages,
          temperature: COUNCIL_TEMPERATURE,
          seed,
          sensitivity: task.sensitivity,
          taskBudgetUsd: task.budgetUsd,
          maxTokens: config.councilMaxOutputTokens,
          numCtx,
          json: VERDICT_SCHEMA,
          signal: opts.signal,
        });
        const parsed = parseOpinion(res.text);
        // The model that ANSWERED, which is not the one asked for when the
        // broker stepped down for memory. Recording the intended model here
        // would cache a 2B's opinion under the 14B's key — and the full-model
        // re-check that provisional work exists for would replay it from cache.
        const ran = res.spec;
        if (res.downshiftedFrom) {
          downshifts.push(`${alias}→${ran.alias}`);
          opts.onNote?.(`${alias} did not fit in memory; ran on ${ran.alias} (${ran.model}) — this review is provisional`);
        } else if (parsed) {
          store.putCachedOpinion(cacheKey, spec.model, parsed);
        }
        if (!parsed) {
          return {
            model: ran.model, provider: ran.provider, local: ran.local,
            verdict: 'fail', confidence: 0, critique: '', costUsd: res.costUsd, latencyMs: res.latencyMs,
            error: `unparseable reply: ${res.text.slice(0, 200)}`,
          };
        }
        opts.onNote?.(`${ran.alias}: ${parsed.verdict} (${parsed.confidence.toFixed(2)}) ${parsed.critique.slice(0, 160)}`);
        return {
          model: ran.model, provider: ran.provider, local: ran.local,
          verdict: parsed.verdict, confidence: parsed.confidence, critique: parsed.critique,
          costUsd: res.costUsd, latencyMs: res.latencyMs,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A seat lost to memory — it stepped down and still failed, or it
        // stalled — is a review the full council did not get to give. The
        // verdict that results is provisional and gets re-checked, instead of
        // standing as "single advisor reachable".
        if (steppedDownError(err) || /sent nothing for/.test(message)) downshifts.push(`${alias} (lost to memory)`);
        opts.onNote?.(`${alias}: unavailable — ${message.slice(0, 160)}`);
        return {
          model: spec.model, provider: spec.provider, local: spec.local,
          verdict: 'fail', confidence: 0, critique: '', costUsd: 0, latencyMs: 0, error: message.slice(0, 500),
        };
      }
    }),
  );

  const usable = opinions.filter((o) => !o.error);
  let verdict: CouncilVerdict;
  let disagreement = false;
  let chairSummary: string | null = null;
  let critique: string | null = null;
  let costUsd = opinions.reduce((n, o) => n + o.costUsd, 0);

  if (usable.length === 0) {
    verdict = 'split';
    critique = `no advisor could be reached: ${opinions.map((o) => o.error).filter(Boolean).join('; ')}`;
  } else if (usable.length < advisors.length && usable.every((o) => o.verdict === 'pass')) {
    // A seat that answered nothing usable — an unparseable or truncated reply,
    // an error — is a review this council did not give. Letting the survivor's
    // PASS stand as the council's is renormalising over whoever happened to
    // answer, which on this roster hands the decision to one model, often the
    // 2B. Fail closed like any council that cannot form an opinion: a split.
    // runCouncil climbs it to DIFFERENT advisors where a rung has them, never
    // under memory pressure, and otherwise it parks for a person (local-only policy).
    // Not provisional for its own sake: provisional means "memory lost a seat —
    // re-check once the full council fits", and a parse failure is not a memory
    // problem (a seat lost to memory is still marked provisional above); the
    // operator's Re-review is the path for it. A lone FAIL still stands below —
    // failing closed is the safe direction. Not a `disagreement`: nobody ruled,
    // so the training set must not read this note as a chair's rationale
    // (align/dataset.ts).
    verdict = 'split';
    critique = usable.map((o) => o.critique).filter(Boolean).join('\n\n') || null;
    const lost = opinions.filter((o) => o.error).map((o) => `${o.model}: ${o.error!.slice(0, 120)}`).join('; ');
    chairSummary = `${LOST_SEAT} (${lost}) — a lone PASS is not a council decision`;
  } else if (usable.length === 1 || usable.every((o) => o.verdict === usable[0]!.verdict)) {
    verdict = usable[0]!.verdict;
    critique = usable.map((o) => o.critique).filter(Boolean).join('\n\n') || null;
    if (usable.length === 1) chairSummary = 'single advisor reachable; verdict is not a consensus';
  } else if (chairConflicted(usable, chair) && independentChairAbove(task, rung, usable)) {
    // This chair already argued one side, and a higher rung has one that did
    // not: hand the disagreement up rather than let one vote count twice.
    // Where no independent chair exists anywhere on the ladder — local-only,
    // S2 — the conflicted chair still decides, because the local-only policy
    // keeps the chair on qwen3.5:9b and lists disagreement→chair among the
    // things local-only must not change.
    disagreement = true;
    verdict = 'split';
    chairSummary = `${CONFLICTED_CHAIR}: ${chair} already argued one side — handing up to an independent chair`;
    critique = usable
      .map((o) => `Reviewer using ${o.model} says ${o.verdict.toUpperCase()}: ${o.critique}`)
      .join('\n\n');
  } else {
    disagreement = true;
    const debate = usable
      .map((o) => `Reviewer using ${o.model} says ${o.verdict.toUpperCase()} (confidence ${o.confidence.toFixed(2)}): ${o.critique}`)
      .join('\n\n');
    try {
      const res = await broker.call({
        taskId: task.id,
        runId,
        kind: `chair@${lane}`,
        alias: chair,
        messages: [
          { role: 'system', content: CHAIR_SYSTEM },
          { role: 'user', content: `${prompt}\n\nREVIEWERS DISAGREED:\n${debate}` },
        ],
        temperature: COUNCIL_TEMPERATURE,
        seed: seedFor(`chair\u0001${prompt}\u0001${debate}`),
        sensitivity: task.sensitivity,
        taskBudgetUsd: task.budgetUsd,
        maxTokens: config.councilMaxOutputTokens,
        // The chair reads the whole prompt again PLUS the debate, so it needs
        // at least as much window as the advisors had.
        numCtx: councilNumCtx(`${prompt}\n${debate}`),
        json: VERDICT_SCHEMA,
        signal: opts.signal,
      });
      costUsd += res.costUsd;
      if (res.downshiftedFrom) {
        downshifts.push(`chair ${chair}→${res.spec.alias}`);
        opts.onNote?.(`chair ${chair} did not fit in memory; ran on ${res.spec.alias} — this verdict is provisional`);
      }
      const parsed = parseOpinion(res.text);
      if (parsed && res.downshiftedFrom && usable.some((o) => o.model === res.spec.model)) {
        // Stepped down onto a model that already argued one side: one vote
        // counted twice is not a decision, whatever the intended chair was.
        verdict = 'split';
        chairSummary = `${CONFLICTED_CHAIR}: the chair stepped down to ${res.spec.alias}, which already argued one side`;
        critique = debate;
      } else if (parsed) {
        verdict = parsed.verdict;
        // Even a ruling with nothing to add is a ruling (chairRuled reads this).
        chairSummary = parsed.critique || `chair ruled ${parsed.verdict}`;
        // A bare FAIL still leaves the repair round something to work from; a
        // bare PASS has nothing to repair, and the losing argument is not its critique.
        critique = parsed.critique || (parsed.verdict === 'fail' ? debate : '');
        opts.onNote?.(`chair (${chair}): ${parsed.verdict} — ${parsed.critique.slice(0, 200)}`);
      } else {
        verdict = 'split';
        chairSummary = `chair reply unparseable: ${res.text.slice(0, 200)}`;
        critique = debate;
      }
    } catch (err) {
      verdict = 'split';
      chairSummary = `chair unavailable: ${(err as Error).message.slice(0, 300)}`;
      critique = debate;
      if (steppedDownError(err) || /sent nothing for/.test((err as Error).message)) downshifts.push(`chair ${chair} (lost to memory)`);
    }
  }

  // An aborted review (shutdown, cancel, an approval landing mid-re-check) is
  // no review: every seat reads as unreachable, and writing that down would
  // record a split nobody reached — and, for a re-check, quietly drop the task
  // from the provisional queue it was in.
  if (opts.signal?.aborted) throw new Error('council aborted before it reached a verdict');
  if (downshifts.length) opts.onNote?.(`provisional verdict (${downshifts.join(', ')}): re-checked with the full council once it fits`);
  const row = {
    runId, taskId: task.id, verdict, disagreement, council: opinions, chairSummary, critique, costUsd,
    provisional: downshifts.length > 0,
  };
  if (opts.stillCurrent && !opts.stillCurrent()) {
    throw new Error('the task moved on while it was being reviewed; this verdict was discarded');
  }
  if (opts.shadow) {
    return {
      ...row, id: 'shadow', chairModel: null, source: 'council', chairSummary: chairSummary ?? null,
      critique: critique ?? null, createdAt: Date.now(),
    };
  }
  return store.addVerdict(row);
}
