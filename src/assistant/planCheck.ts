import { repoBrief } from './repoBrief.ts';
import { extractJson } from '../models.ts';
import type { Playbook } from '../playbooks.ts';
// Type-only: crewPlan.ts imports the runtime functions from this file, so a
// runtime import back would be a cycle. Types are erased (erasableSyntaxOnly),
// so this edge costs nothing at build time.
import type { CrewPlan, CrewTicket } from './crewPlan.ts';
import { ownerCall } from './ownerCall.ts';
import type { Store } from '../queue.ts';
import { tierModel } from '../roles.ts';
import { foremanRoot, PROTECTED_PATHS } from '../security/coreGuard.ts';
import fs from 'node:fs';

export interface PlanFinding {
  /** `note` is a plain statement about the plan: nothing to fix, never blocking, never escalated. */
  level: 'error' | 'warn' | 'note';
  code: string;
  /** The ticket ref this finding is about, when it is about one ticket in particular. */
  ticket?: string;
  message: string;
}

/** A role counts as reviewing work if the playbook says so (senior tier) or its name says so. */
const REVIEW_ISH = /qa|review|proof|copyedit|risk/i;

function isReviewIsh(playbook: Playbook | null, role: string): boolean {
  if (playbook?.roles[role]?.tier === 'senior') return true;
  return REVIEW_ISH.test(role);
}

function normTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Longest dependency chain, counted in tickets. `topoSort` already drops the
 * edge that closes a cycle before a plan reaches here, but `seen` still guards
 * against a residual cycle terminating the walk instead of recursing forever
 * — cheap insurance, since a lint rule must never be the thing that hangs.
 */
function longestChain(tickets: CrewTicket[]): number {
  const byRef = new Map(tickets.map((t) => [t.ref, t]));
  const memo = new Map<string, number>();
  const depth = (ref: string, seen: Set<string>): number => {
    const cached = memo.get(ref);
    if (cached !== undefined) return cached;
    if (seen.has(ref)) return 1;
    const ticket = byRef.get(ref);
    if (!ticket || !ticket.after.length) {
      memo.set(ref, 1);
      return 1;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    const best = Math.max(...ticket.after.map((a) => depth(a, nextSeen)));
    const value = best + 1;
    memo.set(ref, value);
    return value;
  };
  let max = 0;
  for (const t of tickets) max = Math.max(max, depth(t.ref, new Set()));
  return max;
}

/** Connected components of the dep graph, treated as undirected (union-find over `after` edges). */
function componentCount(tickets: CrewTicket[]): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const t of tickets) parent.set(t.ref, t.ref);
  for (const t of tickets) {
    for (const a of t.after) {
      if (!parent.has(a)) continue;
      const ra = find(t.ref);
      const rb = find(a);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  return new Set(tickets.map((t) => find(t.ref))).size;
}

/**
 * How many numbered items an ask lists: lines starting `N.` with N running
 * consecutively from 1. A line whose number is not the next in sequence is
 * skipped, so a stray "2024." line does not inflate the count.
 */
export function askItems(ask: string): string[] {
  const items: string[] = [];
  for (const line of ask.split('\n')) {
    const m = line.trimStart().match(/^(\d+)\.(?=\s|$)\s*(.*)$/);
    if (m?.[1] === String(items.length + 1)) items.push(m[2]!.trim());
  }
  return items;
}

export function askItemCount(ask: string): number {
  return askItems(ask).length;
}

/**
 * The ticket count an ask states in digits ("as 10 tickets", "split into 12 tickets"), or null. The largest when it
 * states several: "one ticket per item" is spelled out and is not a count.
 */
export function askedTicketCount(ask: string): number | null {
  const counts = [...ask.matchAll(/\b(\d{1,3})\s+tickets\b/gi)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts) : null;
}

const STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'into', 'have', 'been', 'when', 'then', 'than', 'they', 'them', 'their',
  'there', 'what', 'which', 'will', 'would', 'should', 'could', 'must', 'also', 'each', 'every', 'only',
  'over', 'such', 'more', 'most', 'some', 'does', 'just', 'your', 'ours', 'about', 'after', 'before',
  'being', 'both', 'make', 'sure', 'same', 'while', 'where', 'these', 'those', 'other',
  // Words every ticket's acceptance uses; sharing one says nothing about which ask item it covers.
  'user', 'test', 'tests', 'file', 'files', 'project', 'shown', 'text', 'never',
  'change', 'code', 'gives', 'give', 'keeps', 'says', 'write', 'main', 'match', 'kind', 'style', 'finds',
  'system',
]);

const distinctiveWords = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w)));

/**
 * Words found in at least 3 of the given word sets and a quarter of them. Run
 * over the tickets' title+acceptance and over the ask items, this finds the
 * plan's own subject words, which say nothing about which item a ticket covers.
 */
function planCommonWords(wordSets: Set<string>[]): Set<string> {
  const common = new Set<string>();
  const counts = new Map<string, number>();
  for (const ws of wordSets) for (const w of ws) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const [w, n] of counts) if (n >= 3 && n * 4 >= wordSets.length) common.add(w);
  return common;
}

/** A phrase that, earlier in the same sentence, says a path is out of bounds (or only an example) rather than to be edited. */
const EXCLUSION = /\b(?:do not (?:touch|edit|modify)|must not (?:edit|modify)|never (?:edit|modify)|excludes?|e\.g\.)/i;
const SENTENCE_END = /(?<!\be\.g)(?<!\bi\.e)[.;!?]\s|\n/g;

/** The PROTECTED_PATHS files a text names outside an exclusion phrase, as written in the text. */
function protectedMentions(text: string): string[] {
  const flat = text.replace(/(^|[^\w./-])\.\//g, '$1');
  const found = new Set<string>();
  for (const entry of PROTECTED_PATHS) {
    // A directory entry is a prefix; a file entry must end where the name ends. Both must start a path
    // (so `board/src/merge.ts` is not `src/merge.ts`).
    const tail = entry.endsWith('/') ? '[\\w./-]*' : '(?![\\w-]|\\.\\w)';
    const re = new RegExp(`(?<![\\w./-])${escapeRe(entry)}${tail}`, 'gi');
    for (const m of flat.matchAll(re)) {
      const before = flat.slice(0, m.index);
      let start = 0;
      for (const e of before.matchAll(SENTENCE_END)) start = e.index! + e[0].length;
      // A directory entry's tail also takes a sentence's closing full stop: 'src/security/x.ts.' names src/security/x.ts.
      if (!EXCLUSION.test(before.slice(start))) found.add(m[0].replace(/\.+$/, ''));
    }
  }
  return [...found];
}

const realOrNull = (p: string): string | null => {
  try { return fs.realpathSync(p); } catch { return null; }
};

/** Under --auto a short plan must not open an epic: promote the warning to a blocking error. */
export function escalateForAuto(findings: PlanFinding[]): void {
  for (const f of findings) if (f.code === 'ask-items-uncovered') f.level = 'error';
}

/**
 * Layer A: deterministic, zero-token lint over a plan's shape. No model call,
 * and no I/O except the self-epic check's two `fs.realpathSync` calls (the
 * plan's repo and `selfRoot`, the Foreman checkout; a test passes its own) —
 * so every rule is unit-testable in isolation and this
 * runs on every plan for free, unlike Layer B (`critiquePlan`) which costs a
 * senior-tier call and is gated behind a trigger policy.
 *
 * `playbook` is nullable: a caller-supplied plan (`parseCrewPlan`) may name a
 * playbook that was not resolved, or none at all. Rules that need the
 * playbook's review chain or checks just sit out rather than guessing.
 */
export function lintPlan(plan: CrewPlan, playbook: Playbook | null, selfRoot: string = foremanRoot()): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const tickets = plan.tickets;

  if (!tickets.length) {
    findings.push({ level: 'error', code: 'empty-plan', message: 'plan has no tickets' });
    return findings;
  }

  const items = askItems(plan.ask);
  if (tickets.length < items.length) {
    // Tickets rarely cite ask numbers, so coverage is by content: an item is
    // covered when a ticket's title+acceptance shares 2 of its distinctive
    // words (1 when the item has 3 or fewer).
    const rawWords = tickets.map((t) => distinctiveWords(`${t.title} ${t.acceptance ?? ''}`));
    const common = new Set([
      ...planCommonWords(rawWords),
      ...planCommonWords(items.map((text) => distinctiveWords(text))),
    ]);
    const ticketWords = rawWords.map((tw) => new Set([...tw].filter((w) => !common.has(w))));
    const missing: string[] = [];
    items.forEach((text, i) => {
      const all = distinctiveWords(text);
      const distinct = [...all].filter((w) => !common.has(w));
      // An item made only of plan-common words falls back to its raw words, matched
      // against raw ticket words; the threshold never exceeds what can be matched.
      const words = distinct.length ? distinct : [...all];
      const pool = distinct.length ? ticketWords : rawWords;
      const need = Math.min(all.size <= 3 ? 1 : 2, words.length);
      // An item with no matchable word at all (e.g. "Fix it.") can never be shown
      // covered, so it is reported rather than passing silently.
      if (!words.length || !pool.some((tw) => words.filter((w) => tw.has(w)).length >= need)) {
        missing.push(`${i + 1} (${text.split(/\s+/).slice(0, 8).join(' ')})`);
      }
    });
    findings.push({
      level: 'warn', code: 'ask-items-uncovered',
      message: `the ask lists ${items.length} numbered items but the plan has ${tickets.length} tickets; ` +
        (missing.length
          ? `${missing.length} item(s) have no ticket whose title or acceptance covers them: ${missing.join('; ')}`
          : 'every item matches some ticket, so items were merged — check none was dropped'),
    });
  }

  const hasReviewers = Boolean(playbook?.reviewers.length);

  for (const t of tickets) {
    const promptLen = t.prompt.trim().length;
    if (promptLen < 60) {
      findings.push({
        level: 'warn', code: 'thin-prompt', ticket: t.ref,
        message: `'${t.title}' has only a ${promptLen}-char prompt — a worker gets no other context, so a thin brief guarantees garbage`,
      });
    }
    if (hasReviewers && !t.acceptance?.trim()) {
      findings.push({
        level: 'warn', code: 'no-acceptance', ticket: t.ref,
        message: `'${t.title}' has no acceptance criteria, but this playbook's reviewers will judge it against something`,
      });
    }
    if (t.points != null && t.points >= 8) {
      findings.push({
        level: 'warn', code: 'points-outlier', ticket: t.ref,
        message: `'${t.title}' is ${t.points} points — should have been split`,
      });
    }
    if (t.kind === 'code' && !t.testCmd && !playbook?.checks.length) {
      findings.push({
        level: 'warn', code: 'missing-testcmd', ticket: t.ref,
        message: `'${t.title}' is a code ticket with no testCmd, and the playbook has no checks — nothing gates its test stage`,
      });
    }
  }

  // A Foreman self-epic: a ticket that must edit a core-guarded file is refused at admission. Warn only.
  const repoReal = plan.repo ? realOrNull(plan.repo) : null;
  if (repoReal && repoReal === realOrNull(selfRoot)) {
    for (const t of tickets) {
      const paths = protectedMentions(`${t.title}\n${t.prompt}\n${t.acceptance ?? ''}`);
      if (!paths.length) continue;
      findings.push({
        level: 'warn', code: 'core-file-refused', ticket: t.ref,
        message: `likely refused at admission: consider hand work — ${t.ref} '${t.title}' names ${paths.join(', ')}`,
      });
    }
  }

  const byTitle = new Map<string, CrewTicket[]>();
  for (const t of tickets) {
    const key = normTitle(t.title);
    const group = byTitle.get(key);
    if (group) group.push(t);
    else byTitle.set(key, [t]);
  }
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    for (const dup of group.slice(1)) {
      findings.push({
        level: 'warn', code: 'dup-title', ticket: dup.ref,
        message: `'${dup.title}' duplicates ${group[0]!.ref}'s title`,
      });
    }
  }

  if (hasReviewers) {
    const dependedOn = new Set(tickets.flatMap((t) => t.after));
    const terminals = tickets.filter((t) => !dependedOn.has(t.ref));
    const reviewIshRefs = new Set(tickets.filter((t) => isReviewIsh(playbook, t.role)).map((t) => t.ref));
    for (const term of terminals) {
      // The final ticket may itself be the reviewing step (proofread last) —
      // that verifies the end state as surely as a dedicated qa ticket would.
      if (reviewIshRefs.has(term.ref)) continue;
      const verified = tickets.some((t) => reviewIshRefs.has(t.ref) && t.after.includes(term.ref));
      if (!verified) {
        findings.push({
          level: 'warn', code: 'unreviewed-terminal', ticket: term.ref,
          message: `'${term.title}' is a terminal ticket with no qa/review ticket depending on it — nothing verifies the end state`,
        });
      }
    }
  }

  if (tickets.length > 2) {
    const n = componentCount(tickets);
    if (n > 1) {
      findings.push({
        level: 'warn', code: 'orphan-island',
        message: `the dependency graph has ${n} disconnected groups — usually a missed dependency, not intentional parallelism`,
      });
    }
  }

  const chain = longestChain(tickets);
  if (chain > 6) {
    findings.push({
      level: 'warn', code: 'deep-chain',
      message: `the longest dependency chain is ${chain} tickets deep — a serial bottleneck`,
    });
  }

  if (tickets.length > 9) {
    // A size the ask itself set is not a planning fault: the Kiln trial's ask said "Plan ONE ticket per numbered
    // item", listed ten, got ten, and was told its decomposition was too fine. Said as a fact instead.
    const asked = items.length >= 2 && tickets.length === items.length
      ? `the ask's ${items.length} numbered items`
      : askedTicketCount(plan.ask) === tickets.length
        ? `the ask asks for ${tickets.length}`
        : null;
    findings.push(asked
      ? { level: 'note', code: 'epic-size', message: `${tickets.length} tickets, as ${asked}` }
      : {
        level: 'warn', code: 'fat-epic',
        message: `${tickets.length} tickets — decomposition is too fine, coordination cost will dominate`,
      });
  }

  return findings;
}

export interface PlanCritique {
  verdict: 'sound' | 'risky';
  notes: string[];
}

/** The most of one review note that is kept; the rest is cut, and the cut is marked. */
export const PLAN_NOTE_MAX_CHARS = 600;
/** The most notes one ticket carries, and the most a review keeps: the critic returns five, a plan from the wire may not. */
export const PLAN_NOTES_MAX = 8;

/** What a note is headed with wherever a worker or a reviewer reads it. */
export const PLAN_NOTE_HEAD =
  "PLAN REVIEW NOTE (from the senior's review of the plan; the brief and acceptance outrank it; say in your report how you handled it)";

/** One note of the review of the plan as it stands, and where it went. */
export interface PlanReviewNote {
  text: string;
  /** Refs of the tickets it names: it is in each one's brief. Empty: it is on the epic only. */
  tickets: string[];
  /** Ticket labels it names that the plan does not have (`t11` of ten). */
  unmatched: string[];
}

export interface PlanReview {
  verdict: 'sound' | 'risky';
  notes: PlanReviewNote[];
}

/**
 * A note as it is kept: one line (model text that could start a line could also forge a section of the prompt it
 * ends up in), no control (NEL is a line break to some readers), zero-width or direction-override characters, at most PLAN_NOTE_MAX_CHARS with the cut said.
 */
export function boundPlanNote(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= PLAN_NOTE_MAX_CHARS) return flat;
  return `${flat.slice(0, PLAN_NOTE_MAX_CHARS)}… [FOREMAN cut this note here; ${flat.length - PLAN_NOTE_MAX_CHARS} more characters were NOT kept]`;
}

/**
 * The notes as the tail of a ticket's stored prompt — the one per-ticket text that reaches both the worker's brief
 * and the reviewers' prompt without a new column. '' when there are none.
 *
 * Each note is a quotation, in curly quotes: scope.ts reads "do not touch <path>" and "write only <path>" in a
 * prompt as rules the diff is held to, and skips quoted text. A senior's remark is advice the brief outranks, so it
 * must not become a rule that fails the worker's diff. Backticks pair across lines there, so they become plain
 * quotes rather than swallow part of the brief above.
 */
export function planNoteBlock(notes: string[] | null | undefined): string {
  const kept = (notes ?? []).map(boundPlanNote).filter(Boolean).slice(0, PLAN_NOTES_MAX);
  if (!kept.length) return '';
  return `\n\n---\n${PLAN_NOTE_HEAD}:\n${kept.map((n) => `- “${n.replace(/[“”]/g, '"').replace(/`/g, "'")}”`).join('\n')}`;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which tickets a note names: by plan label (`t4`, `t4/t5`, `t1-t6` as a range) or by a ticket's whole title.
 * `unmatched` is every `t<N>` label in it that the plan does not have.
 */
function ticketsNamed(note: string, tickets: CrewTicket[]): { refs: string[]; unmatched: string[] } {
  const text = note.toLowerCase().replace(/\s+/g, ' ');
  const labels = new Set<string>();
  for (const m of text.matchAll(/(?<!\w)t(\d{1,3})\s*(?:[-–—]|to|through)\s*t(\d{1,3})(?!\w)/g)) {
    const [from, to] = [Number(m[1]), Number(m[2])];
    for (let n = from; n <= to && n - from < 100; n++) labels.add(`t${n}`);
  }
  for (const m of text.matchAll(/(?<!\w)t\d{1,3}(?!\w)/g)) labels.add(m[0]);
  const refs = tickets.filter((t) => {
    const ref = t.ref.toLowerCase();
    if (labels.has(ref)) return true;
    // A ref of another shape counts when it has a digit: one that is a plain word would match prose.
    if (/\d/.test(ref) && new RegExp(`(?<![\\w-])${escapeRe(ref)}(?![\\w-])`).test(text)) return true;
    const title = normTitle(t.title);
    return title.length >= 12 && text.includes(title);
  }).map((t) => t.ref);
  const known = new Set(tickets.map((t) => t.ref.toLowerCase()));
  return { refs, unmatched: [...labels].filter((l) => !known.has(l)) };
}

/**
 * Keep a review of `plan` on the plan: each note on every ticket it names (`reviewNotes`, which queueCrewPlan puts
 * in the ticket's brief), and all of them, with where each went, as `plan.review`. A note that names no ticket of
 * the plan stays on the plan alone — queued, it is recorded on the epic — and is never dropped. Whatever an earlier
 * review left on this plan is replaced: the notes kept are those of the latest review of the plan as it stands.
 *
 * Before this the review of the FINAL plan was printed and went nowhere: `--revise` fed the first review to the
 * planner, and the second one's points ("t4: pid reuse needs a rule") reached no ticket; t4's worker never saw
 * the point, and it was handed in by hand three runs later.
 */
export function attachReviewNotes(plan: CrewPlan, critique: PlanCritique): PlanReview {
  const review: PlanReview = { verdict: critique.verdict, notes: [] };
  const byTicket = new Map<string, string[]>();
  for (const raw of critique.notes.slice(0, PLAN_NOTES_MAX)) {
    const text = boundPlanNote(raw);
    if (!text) continue;
    // Matched on the whole note, not on what the bound kept of it.
    const named = ticketsNamed(raw, plan.tickets);
    for (const ref of named.refs) byTicket.set(ref, [...(byTicket.get(ref) ?? []), text]);
    review.notes.push({ text, tickets: named.refs, unmatched: named.unmatched });
  }
  for (const t of plan.tickets) {
    const notes = byTicket.get(t.ref);
    if (notes) t.reviewNotes = notes;
    else delete t.reviewNotes;
  }
  plan.review = review;
  return review;
}

const CRITIQUE_CONTRACT = `Reply with JSON only, no prose:
{"verdict":"sound|risky","notes":["..."]}
At most 5 notes. You are a devil's advocate on the PLAN itself, not on code quality: missing steps,
wrong order, wrong roles, unstated assumptions, scope traps. "risky" means a competent lead would send
this back before anyone starts work on it; "sound" means it is fit to run as written.`;

/** Cheap-to-send ticket summary: title/role/deps/acceptance/points, never the full worker prompt. */
function ticketBrief(t: CrewTicket): Record<string, unknown> {
  return { ref: t.ref, title: t.title, role: t.role, after: t.after, acceptance: t.acceptance, points: t.points };
}

export interface CritiquePlanOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  store?: Store;
  taskId?: string | null;
}

/**
 * Layer B: one senior-tier Owner call, playing devil's-advocate on the plan as
 * a whole (not any one ticket). Optional and never blocking — an unreachable
 * or unparseable reply degrades to `null`, exactly like the rest of the crew
 * planning surface (`crewPlan`'s own fallback, `classifyAsk`'s null return).
 * The caller decides whether to invoke this at all (see the trigger policy in
 * `/api/build`); this function itself has no opinion on when it should run.
 *
 * A verdict is also kept ON the plan it was given (attachReviewNotes): the caller queues that same plan object, so
 * the notes of the last review of the plan that is queued travel with it, and a plan that replaces it (a revision)
 * starts with none.
 */
export async function critiquePlan(
  plan: CrewPlan,
  playbook: Playbook,
  opts: CritiquePlanOptions = {},
): Promise<PlanCritique | null> {
  // static-first for prompt-cache hits: the role line, the playbook's pipeline
  // and the reply contract are byte-identical for every plan of this playbook,
  // so they lead; the ask and the tickets are what varies, so they trail.
  const prompt =
    `You are a senior ${playbook.id} lead sanity-checking a plan before anyone starts work on it.\n` +
    `PIPELINE: ${playbook.pipeline || '(none defined)'}\n\n${CRITIQUE_CONTRACT}\n\n` +
    `ASK: ${plan.ask}\n` +
    `TICKETS:\n${JSON.stringify(plan.tickets.map(ticketBrief))}` +
    // The critic judges the plan against the same snapshot the planner saw;
    // without it, it flags committed work as unowned.
    (plan.repo ? `\n\n${repoBrief(plan.repo, plan.ask)}` : '');
  try {
    const { text } = await ownerCall(prompt, {
      signal: opts.signal,
      model: tierModel('senior'),
      maxTurns: 1,
      timeoutMs: opts.timeoutMs,
      store: opts.store,
      kind: 'plan:check',
      taskId: opts.taskId ?? null,
    });
    const parsed = extractJson<{ verdict?: unknown; notes?: unknown }>(text);
    const verdict = parsed?.verdict === 'risky' ? 'risky' : parsed?.verdict === 'sound' ? 'sound' : null;
    if (!verdict) return null;
    const notes = Array.isArray(parsed?.notes)
      ? parsed.notes.filter((n): n is string => typeof n === 'string').slice(0, 5)
      : [];
    const critique: PlanCritique = { verdict, notes };
    attachReviewNotes(plan, critique);
    return critique;
  } catch {
    // Unreachable or unusable: this layer never blocks a build.
    return null;
  }
}
