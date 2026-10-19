import type { Broker } from '../budget.ts';
import { extractJson, pickAlias } from '../models.ts';
import type { Store } from '../queue.ts';
import type { MemoryFact, Run, Task, Verdict } from '../types.ts';

export const EPISODE_PREFIX = 'episode:';
export const PREFERENCE_PREFIX = 'preference:';
/** Crew retrospectives, scoped by playbook id rather than repo (see retro.ts). */
export const RETRO_PREFIX = 'epic:';

export const scopeOf = (task: Pick<Task, 'repo'>): string => task.repo ?? 'global';

/** Prefixes the value of an owner-gate decision; recordDecision writes it, isApprovalNote reads it. */
export const OWNER_GATE_MARKER = 'the owner gate (not the operator) ';

const isEpisode = (f: MemoryFact): boolean => f.key.startsWith(EPISODE_PREFIX);

/**
 * Episodic memory: what actually happened on a run. Written at low confidence
 * because a single run is weak evidence; consolidation later promotes the
 * patterns that repeat into semantic facts.
 */
export function recordEpisode(store: Store, task: Task, run: Run | null, verdict: Verdict | null): void {
  const outcome = verdict?.verdict ?? (run?.status === 'succeeded' ? 'pass' : 'fail');
  const parts = [
    `${task.kind} task "${task.title}" via ${task.runner} → ${outcome}`,
    run?.testsPassed === false ? 'its tests failed' : run?.testsPassed ? 'tests passed' : null,
    task.repairs ? `after ${task.repairs} repair round(s)` : null,
    verdict?.critique ? `council said: ${verdict.critique.slice(0, 300)}` : null,
  ].filter(Boolean);
  store.rememberFact({
    scope: scopeOf(task),
    key: `${EPISODE_PREFIX}${task.id}`,
    value: parts.join('; ').slice(0, 1000),
    confidence: 0.35,
    source: task.id,
  });
}

/**
 * The gate is the strongest preference signal Foreman has: a rejection with a
 * reason is the operator saying "not like that", and it must resurface the
 * next time the same repo is targeted.
 */
export function recordDecision(
  store: Store,
  task: Task,
  approved: boolean,
  note?: string | null,
  // Phase 6: the owner gate decides some tasks. Its calls are a model agreeing
  // with a model, not the operator's taste, so they are marked in the value and
  // written at lower confidence — a preference the human never expressed must
  // not outrank one they did.
  decidedBy: 'human' | 'owner-gate' = 'human',
): void {
  if (approved && !note) return; // a bare approval teaches nothing specific
  const who = decidedBy === 'owner-gate' ? OWNER_GATE_MARKER : '';
  const value = approved
    ? `${who}approved "${task.title}" — ${note}`
    : `${who}rejected "${task.title}"${note ? ` — ${note}` : ''}. Do not repeat this.`;
  const confidence = approved ? 0.6 : 0.75;
  store.rememberFact({
    scope: scopeOf(task),
    key: `${PREFERENCE_PREFIX}${task.id}`,
    value: value.slice(0, 1000),
    confidence: decidedBy === 'owner-gate' ? confidence - 0.2 : confidence,
    source: decidedBy === 'owner-gate' ? `owner-gate:${task.id}` : task.id,
  });
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'it', 'this', 'that',
  'add', 'fix', 'make', 'use', 'run', 'task', 'code', 'file', 'files',
]);

/** Exported so crew precedent ranking scores against the same stopword list. */
export const terms = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? []).filter((t) => !STOP.has(t));

/** Longest approval note a brief carries; they are often long verification reports. */
export const APPROVAL_NOTE_MAX = 300;
/** A fact longer than this must match at least two query terms to be recalled. */
const LONG_FACT_CHARS = 300;
/** A term in more than this share of a scope's facts is scope-ubiquitous and says nothing about relevance. */
const COMMON_TERM_SHARE = 0.2;
/** Below this many facts a document-frequency share is noise, so no term is cut. */
const COMMON_TERM_MIN_FACTS = 10;

/** The `preference:` facts recordDecision writes with approved=true, owner-gate or human. */
export const isApprovalNote = (f: MemoryFact): boolean => {
  if (!f.key.startsWith(PREFERENCE_PREFIX)) return false;
  const v = f.value.startsWith(OWNER_GATE_MARKER) ? f.value.slice(OWNER_GATE_MARKER.length) : f.value;
  return v.startsWith('approved "');
};

/**
 * Relevance-ranked recall. Preferences outrank episodes at equal relevance,
 * because "don't do it that way again" is worth more to a worker than "a run
 * happened once". Keyword scoring now; embeddings are the obvious upgrade.
 */
export function relevantFacts(store: Store, scope: string, query: string, limit = 8): MemoryFact[] {
  // recallFacts folds 'global' into every scope; a brief only gets its own scope's facts, so a
  // task with a repo never sees 'global' ones and only a repo-less task (scope 'global') does.
  const facts = store.recallFacts(scope, 400).filter((f) => f.scope === scope);
  const wanted = new Set(terms(query));
  const hays = facts.map((fact) => new Set(terms(`${fact.key} ${fact.value}`)));
  const common = new Set<string>();
  if (facts.length >= COMMON_TERM_MIN_FACTS) {
    const df = new Map<string, number>();
    for (const hay of hays) for (const t of hay) df.set(t, (df.get(t) ?? 0) + 1);
    for (const [t, n] of df) if (n > facts.length * COMMON_TERM_SHARE) common.add(t);
  }
  const scored = facts.flatMap((fact, i) => {
    const hay = hays[i]!;
    let overlap = 0;
    for (const term of wanted) if (hay.has(term) && !common.has(term)) overlap++;
    if (overlap < (fact.value.length > LONG_FACT_CHARS ? 2 : 1)) return [];
    const approval = isApprovalNote(fact);
    const kindBonus = fact.key.startsWith(PREFERENCE_PREFIX) && !approval ? 1.5 : isEpisode(fact) ? -0.5 : 0.5;
    return [{ fact, score: overlap * 2 + kindBonus + fact.confidence }];
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt)
    .slice(0, limit)
    .map(({ fact }) =>
      isApprovalNote(fact) && fact.value.length > APPROVAL_NOTE_MAX
        ? { ...fact, value: fact.value.slice(0, APPROVAL_NOTE_MAX) }
        : fact);
}

export interface ConsolidationResult {
  scope: string;
  episodesRead: number;
  critiquesRead: number;
  rejectionsRead: number;
  factsWritten: number;
  retired: number;
  facts: string[];
  degraded: boolean;
  reason: string;
}

export const CONSOLIDATE_SYSTEM = `You distil a workspace's past tickets into durable guidance for the next worker.
The input lists RUN OUTCOMES, REVIEW FAILURES (critiques of failed work) and OPERATOR REJECTIONS AND DEMANDS.
Every line starts with its ticket id in brackets, e.g. [t_ab12].
Reply with JSON only: {"facts":[{"key":"short-stable-key","value":"imperative guidance","confidence":0.0-1.0,"tickets":["t_ab12","t_cd34"]}]}
Rules:
- At most 5 facts. Each is a recurring failure cause or a convention seen in at least 2 different tickets.
- Write each value as imperative guidance a worker can follow, e.g. "Map every acceptance item to a test that fails without the change." Never narrate what a ticket did.
- "tickets" lists the ticket ids that show the pattern, copied exactly from the input. At least 2 distinct ids; never an id that is not in the input.
- Skip anything seen in only one ticket. Return {"facts":[]} if nothing repeats.`;

/** A fact must cite this many distinct input tickets to count as a pattern. */
const MIN_FACT_TICKETS = 2;
/**
 * Output ceiling for the consolidation call. Facts are citation-based: up to 5
 * facts, each with a `tickets` array of ids, routinely overran the old 700. A
 * local reasoning model also spends part of the budget thinking before it emits
 * the JSON. A reply cut off at the ceiling is not a verdict — the call throws
 * and consolidation degrades, writing and retiring nothing.
 */
export const CONSOLIDATE_MAX_TOKENS = 2000;
/** Facts that must survive validation before the episodes they came from are retired. */
const MIN_FACTS_TO_RETIRE = 2;
const LINE_MAX = 300;
/** Per-section character budgets, so a long episode log cannot crowd out the critiques. */
const SECTION_MAX = { episodes: 5_000, critiques: 4_000, operator: 3_000 };

const idOf = (key: string, prefix: string): string => key.slice(prefix.length);
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);

/** Sentences that state a defect or a fix, as opposed to a reviewer's preamble. */
const FINDING_RE = new RegExp(
  [
    'not tested', 'no test', 'untested', 'unevidenced', 'missing', 'is not', 'does not', 'did not', 'never', 'fails',
    'wrong', 'outside', 'out of scope', 'refuse', 'fix:', 'repair:', 'must', 'should',
  ].join('|'),
  'i',
);

/**
 * A critique line built from the finding, not the head: critiques open with
 * preamble and put the defect and its "Fix:" sentence later. Drops the
 * "<reviewer> says FAIL:" prefix, keeps defect/fix sentences in order up to
 * LINE_MAX, and falls back to the head when no sentence matches.
 */
function critiqueText(critique: string): string {
  const body = critique.replace(/^\s*[^:\n]{0,80}\bsays\s+FAIL\s*:\s*/i, '');
  const sentences = body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const kept: string[] = [];
  let used = 0;
  for (const s of sentences) {
    if (!FINDING_RE.test(s)) continue;
    if (kept.length && used + s.length + 1 > LINE_MAX) break;
    kept.push(s);
    used += s.length + 1;
  }
  return flat(kept.length ? kept.join(' ') : body);
}

/** A prompt line and the ticket id it cites. */
interface Entry { id: string; line: string }

/** The section text plus the ids of the lines that fit the budget (the model saw only those). */
function section(title: string, entries: Entry[], max: number): { text: string; ids: string[] } {
  if (!entries.length) return { text: '', ids: [] };
  const kept: Entry[] = [];
  let used = 0;
  for (const e of entries) {
    if (used + e.line.length + 1 > max) break;
    kept.push(e);
    used += e.line.length + 1;
  }
  return { text: `${title}:\n${kept.map((e) => e.line).join('\n')}`, ids: kept.map((e) => e.id) };
}

/**
 * Episodic → semantic. Runs weekly (or on demand): reads one scope's episodes,
 * fail critiques and operator rejections/demands, asks for the patterns that
 * recur across tickets, keeps only facts that cite at least two real tickets,
 * and retires the episodes it read once at least two facts survive.
 */
export async function consolidate(
  store: Store,
  broker: Broker,
  scope: string,
  opts: { minEpisodes?: number; signal?: AbortSignal } = {},
): Promise<ConsolidationResult> {
  const facts = store.recallFacts(scope, 400);
  const episodes = facts.filter(isEpisode);
  const critiques = store.failCritiques(scope, 200);
  const rejections = facts.filter((f) => f.scope === scope && f.key.startsWith(PREFERENCE_PREFIX) && !isApprovalNote(f));
  const demands = store.operatorDemandsFor(scope, 200);
  const rejectionsRead = rejections.length + demands.length;
  const minEpisodes = opts.minEpisodes ?? 3;
  const base: ConsolidationResult = {
    scope, episodesRead: episodes.length, critiquesRead: critiques.length, rejectionsRead,
    factsWritten: 0, retired: 0, facts: [], degraded: false, reason: '',
  };
  const inputs = episodes.length + critiques.length + rejectionsRead;
  if (inputs < minEpisodes) {
    return { ...base, reason: `only ${inputs} input(s) (episodes, critiques, rejections); need ${minEpisodes}` };
  }

  const episodeLines: Entry[] = episodes.map((e) => {
    const id = idOf(e.key, EPISODE_PREFIX);
    return { id, line: `- [${id}] ${flat(e.value)}` };
  });
  const critiqueLines: Entry[] = critiques.map((c) => ({ id: c.taskId, line: `- [${c.taskId}] ${critiqueText(c.critique)}` }));
  const operatorLines: Entry[] = [
    ...rejections.map((r) => {
      const id = idOf(r.key, PREFERENCE_PREFIX);
      return { id, line: `- [${id}] ${flat(r.value)}` };
    }),
    ...demands.map((d) => ({ id: d.taskId, line: `- [${d.taskId}] demand: ${flat(d.demands)}` })),
  ];
  const sections = [
    section('RUN OUTCOMES', episodeLines, SECTION_MAX.episodes),
    section('REVIEW FAILURES', critiqueLines, SECTION_MAX.critiques),
    section('OPERATOR REJECTIONS AND DEMANDS', operatorLines, SECTION_MAX.operator),
  ];
  // Only ids on lines the model was actually shown may be cited.
  const known = new Set<string>(sections.flatMap((x) => x.ids));

  let alias: string;
  try {
    alias = pickAlias(['local-reason', 'local-general', 'local-fast'], 'S2');
  } catch (err) {
    return { ...base, degraded: true, reason: `no local model for consolidation: ${(err as Error).message}` };
  }

  let text: string;
  try {
    const res = await broker.call({
      taskId: null, runId: null, kind: 'memory', alias,
      messages: [
        { role: 'system', content: CONSOLIDATE_SYSTEM },
        {
          role: 'user',
          content: [
            `WORKSPACE: ${scope}`,
            ...sections.map((x) => x.text),
          ].filter(Boolean).join('\n\n'),
        },
      ],
      // Consolidation reads the run log, which may quote private work: local only.
      sensitivity: 'S2',
      maxTokens: CONSOLIDATE_MAX_TOKENS,
      json: true,
      signal: opts.signal,
    });
    text = res.text;
  } catch (err) {
    return { ...base, degraded: true, reason: `consolidation model call failed: ${(err as Error).message.slice(0, 200)}` };
  }

  const parsed = extractJson<{ facts?: Record<string, unknown>[] }>(text);
  if (!parsed?.facts?.length) {
    return { ...base, degraded: true, reason: 'model returned no usable facts; episodes kept' };
  }

  const written: string[] = [];
  for (const raw of parsed.facts.slice(0, 5)) {
    const key = String(raw['key'] ?? '').trim().slice(0, 80);
    const value = String(raw['value'] ?? '').trim().slice(0, 600);
    if (!key || !value) continue;
    if (key.startsWith(EPISODE_PREFIX)) continue; // consolidation must not write more episodes
    const cited = Array.isArray(raw['tickets']) ? raw['tickets'].map((t) => String(t).trim()) : [];
    const tickets = [...new Set(cited)];
    if (tickets.length < MIN_FACT_TICKETS || tickets.some((t) => !known.has(t))) continue;
    const confidence = Number(raw['confidence']);
    store.rememberFact({
      scope,
      key,
      value,
      confidence: Number.isFinite(confidence) ? Math.min(0.9, Math.max(0.3, confidence)) : 0.6,
      source: tickets.join(','),
    });
    written.push(`${key}: ${value}`);
  }
  if (!written.length) return { ...base, degraded: true, reason: 'no fact survived validation; episodes kept' };
  if (written.length < MIN_FACTS_TO_RETIRE) {
    return {
      ...base, factsWritten: written.length, facts: written,
      reason: `only ${written.length} fact(s) survived validation; need ${MIN_FACTS_TO_RETIRE} to retire episodes — episodes kept`,
    };
  }

  // Only retire what was actually read, so episodes arriving mid-run survive.
  for (const episode of episodes) store.forgetFact(episode.id);

  return { ...base, factsWritten: written.length, retired: episodes.length, facts: written, reason: 'consolidated' };
}
