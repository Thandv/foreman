import { trackedListing } from '../assistant/repoBrief.ts';
import { literalNote, ungroundedLiterals } from './literals.ts';
import { abortCause } from '../abort.ts';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { epicDepth, firstWorkerRole, MAX_EPIC_DEPTH } from '../assistant/crewPlan.ts';
// FILED_PREFIX: the prefix every review-filed ticket's prompt carries — how they are told apart from planned ones.
import { chainIsAcyclic, FILED_PREFIX, planFollowUpChain } from './followUpChain.ts';
import { OWNER_PROVIDER, ownerCall } from '../assistant/ownerCall.ts';
import { config } from '../config.ts';
import { boundBrief, compactDiff, diffStats } from '../context.ts';
import { boundReport } from './report.ts';
import { citedSourceBlock } from './citedSource.ts';
import { checkTicketSkills, HIDDEN_CHAR, skillBlock, skillsRunRecord } from '../skills.ts';
import { extractJson } from '../models.ts';
import { getPlaybook, type Playbook, type PlaybookReviewer } from '../playbooks.ts';
import type { CrewReportRow, Store } from '../queue.ts';
import { tierModel } from '../roles.ts';
import type { AcceptanceEntry, AdvisorOpinion, CouncilVerdict, RunEvent, Task, Verdict } from '../types.ts';
import { numberedItems } from '../acceptanceMap.ts';

/** A follow-up work item a reviewer wants filed, not a reason to fail the work. */
export interface CrewIssue {
  title: string;
  prompt: string;
  severity: 'blocker' | 'normal';
  /** The playbook role the reviewer wants on it; remapped at filing time. */
  role: string | null;
  /** Which review style raised it, for the provenance header. */
  style: PlaybookReviewer['style'];
}

/** One reviewer's turn in the chain. `error` means unavailable, NOT a fail. */
export interface CrewReviewOutcome {
  role: string;
  style: PlaybookReviewer['style'];
  model: string;
  verdict: 'pass' | 'fail';
  critique: string;
  issues: CrewIssue[];
  costUsd: number;
  cached: boolean;
  error?: string;
  /** The reviewer's status per judged acceptance item; absent when the ticket has none. */
  acceptance?: AcceptanceEntry[];
}

export interface CrewVerdict {
  /** 'split' is a pass the chain may not give: an acceptance item no reviewer could verify (see heldItems). */
  verdict: CouncilVerdict;
  critique: string;
  reviews: CrewReviewOutcome[];
  issues: CrewIssue[];
  /** Ids of the child tickets actually filed from `issues`. */
  filed: string[];
  chair: { role: string; model: string; verdict: 'pass' | 'fail'; rationale: string } | null;
  costUsd: number;
  /** The verdicts row this chain wrote. The scheduler gates on this. */
  record: Verdict;
}

export interface CrewReviewOptions {
  task: Task;
  runId: string;
  store: Store;
  /** The work under review: the jail diff, or the worker's summary when there is no repo. */
  diff: string;
  /** This run's local council verdict, when one ran — drives the skip rule and the disagreement escalation. */
  council?: Verdict | null;
  /** The jail branch carrying the reviewed work, so filed issues can be cut from it. */
  branch?: string | null;
  /** What the test stage did before this review — the reviewer is told, so it never asks for a run it cannot see. */
  tests?: { ran: boolean; passed: boolean; cmd: string | null } | null;
  /**
   * The jail the work was done in. The reviewer is shown what that tree
   * already tracks: on the Kiln UI ticket it failed the work for not adding a
   * vendored file the diff referenced, when the file was already committed on
   * the base the jail was cut from.
   */
  treeDir?: string | null;
  /**
   * The worker's own final message. Shown to reviewers as claims, not
   * evidence, so a worker can dispute a demand that cannot be met as written.
   */
  workerReport?: string | null;
  /** Where the whole report is stored (verify/report.ts), named in the prompt when the report had to be cut. */
  reportPath?: string | null;
  /** What Foreman's own checks add under the report. Never cut with it: the report is bounded first. */
  foremanNote?: string | null;
  signal?: AbortSignal;
  onNote?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * Bump when a style template or the reply contract changes: it is part of the
 * cache key, so a change invalidates every stale cached review.
 */
export const CREW_REVIEW_VERSION = 4;

/** Runaway-spawning cap from the plan: five issues per verdict, never more. */
export const MAX_ISSUES = 5;
/**
 * Per-reviewer cap, applied before the per-verdict one. Without it one chatty
 * reviewer fills every slot with normals and a later reviewer's blocker is
 * silently sliced off the end — a suppression channel, not just noise.
 */
export const MAX_ISSUES_PER_REVIEWER = 3;

/**
 * Total review-filed tickets one epic may accumulate, across every review of
 * every ticket in it.
 *
 * MAX_ISSUES bounds one verdict and MAX_EPIC_DEPTH bounds the nesting, but
 * nothing bounded the product: the first real book run had six tickets each
 * file five, and their children file more — 33 descendants in three hours, 20
 * failed and 18 parked, all chasing one file a reviewer had imagined. Past
 * this ceiling a reviewer's issues are noted on the timeline, not queued.
 */
export const MAX_ISSUES_PER_EPIC = 8;
/** A reviewer answers once; it is not an agent loop. */
const REVIEW_MAX_TURNS = 8;
/** Under 'escalate', a diff this small that the council passed unanimously skips the chain. */
export const SMALL_DIFF_LINES = 200;
const MAX_CRITIQUE = 6_000;

export type CrewReviewMode = 'always' | 'escalate';

/** Read lazily, never captured at module load, so tests can flip it per case. */
export function crewReviewMode(): CrewReviewMode {
  return process.env['FOREMAN_CREW_REVIEW'] === 'always' ? 'always' : 'escalate';
}

/**
 * True when the crew chain should run BEFORE the local council, and the council
 * should not run at all if the chain produces a verdict.
 *
 * Under 'always' the chain runs whatever the council says, and the chain's
 * verdict is the one that lands — so the council is pure added latency, and the
 * expensive kind: it is serialized on the local model slots while the hosted
 * reviewers are not. Under the default 'escalate' this is false and nothing
 * moves: there the council is the cheap gate that decides whether the chain
 * runs at all (see the skip rule in crewReview).
 *
 * The caller still needs the council as the fallback for a chain that returns
 * null (unavailable), so this only reorders the two — it never removes one.
 */
export function crewLeadsVerify(task: Pick<Task, 'playbook'>): boolean {
  if (crewReviewMode() !== 'always') return false;
  const pb = task.playbook ? getPlaybook(task.playbook) : null;
  return Boolean(pb?.reviewers.length);
}

/**
 * Right-sizing thresholds. Deliberately far apart and deliberately gated on a
 * sample size: a role is only worth re-tiering when the evidence is one-sided,
 * and three tickets is not evidence.
 */
export const UPGRADE_PASS_RATE = 0.6;
export const UPGRADE_MIN_TICKETS = 5;
export const DOWNGRADE_PASS_RATE = 0.95;
export const DOWNGRADE_MIN_TICKETS = 10;

/**
 * Read the crew report and say — only say — where a role's tier looks wrong.
 *
 * A worker that keeps failing its first review is buying a repair round every
 * time, which usually costs more than the senior model would have; a senior
 * that never fails one is paying for headroom nobody used. Both are advisory:
 * the tier lives in the playbook file, the playbook file is the operator's, and
 * nothing here ever edits it.
 */
export function crewAdvisories(rows: CrewReportRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.firstPassRate === null) continue;
    const tier = (row.playbook ? getPlaybook(row.playbook) : null)?.roles[row.role]?.tier;
    const pct = `${Math.round(row.firstPassRate * 100)}%`;
    if (tier === 'worker' && row.firstReviewed >= UPGRADE_MIN_TICKETS && row.firstPassRate < UPGRADE_PASS_RATE) {
      lines.push(
        `consider senior tier for ${row.role} in ${row.playbook} (edit the playbook role tier) — ` +
          `${pct} first-review pass over ${row.firstReviewed} ticket(s), ${row.avgRepairs.toFixed(1)} repair(s) each`,
      );
    }
    if (tier === 'senior' && row.firstReviewed >= DOWNGRADE_MIN_TICKETS && row.firstPassRate >= DOWNGRADE_PASS_RATE) {
      lines.push(
        `consider worker tier for ${row.role} in ${row.playbook} (edit the playbook role tier) — ` +
          `${pct} first-review pass over ${row.firstReviewed} ticket(s) at $${row.avgCostUsd.toFixed(4)}/ticket`,
      );
    }
  }
  return lines;
}

/**
 * Checks only a person can run belong to the human gate, not the worker. The
 * worker is a headless session with no browser, app window or eyes; on the
 * Kiln polish epic a ticket whose code the reviewer called correct failed
 * twice because the review demanded a report of live browser checks — which
 * the operator then ran, and which passed.
 */
export const OPERATOR_CHECKS =
  'A check only a person can run — live in a browser or app, visual, by hand, or any acceptance item marked ' +
  '"(operator)" — is run by the operator at the human gate after this review. The worker is headless and cannot ' +
  'run or report it: never FAIL work for not running, reporting or evidencing such a check, and never demand it in ' +
  'a repair. Judge the code and tests that the check would exercise instead.';

const SHARED_CONTRACT = [
  'Reply with JSON only, no prose outside the object:',
  '{"verdict":"pass"|"fail","critique":"...","issues":[{"title":"...","prompt":"...","severity":"blocker"|"normal","role":"..."}]}',
  '- critique is what the author must act on, in your own voice. On a fail it must be specific enough to revise against.',
  `- issues are follow-up work items worth their own ticket — at most ${MAX_ISSUES}, each with a self-contained prompt.`,
  '- never file an issue about a file, section or artifact you were not shown or could not open. If something you',
  '  expected is missing, say so in the critique; a ticket to chase it sends the next worker hunting for nothing.',
  '- severity "blocker" means this cannot ship as-is; anything smaller is "normal".',
  '- role is the crew role that should pick the issue up. issues may be empty.',
  `- ${OPERATOR_CHECKS}`,
  '- Demand behaviour, not exact source text. If a demand needs a test to find a literal string in the source,',
  '  quote that string as it actually appears in the diff or the tree; never invent the text the code should contain.',
].join('\n');

/**
 * What each reviewer is FOR. Static per style and placed first in the prompt,
 * so the hosted prompt cache hits across every ticket a crew reviews.
 */
const STYLES: Record<PlaybookReviewer['style'], string> = {
  'code-review': [
    'You are an engineer reviewing a change you did not write. Judge the diff against the ticket and its',
    'acceptance criteria, and nothing else.',
    'Look for: correctness (off-by-one, null paths, error handling, resource leaks, races); security (injection,',
    'path traversal, secrets in logs, unsafe deserialization); broken callers or contracts visible in the diff;',
    'edge cases the change does not handle; whether the tests actually exercise the new behaviour rather than',
    'asserting it exists.',
    'Do NOT fail the work for missing features nobody asked for, pre-existing problems outside the diff, or style',
    'you would have written differently. Unrelated drive-by edits ARE a fail.',
  ].join(' '),
  'editorial-letter': [
    'You are a developmental editor writing an editorial letter about the draft in this diff.',
    'Critique the WORK, structurally: does the piece hold together, does it earn its length, is the argument or',
    'the story actually built, does the pacing serve the reader, is the voice consistent and alive?',
    'Your critique is prose the author revises against, not a checklist — say what is not working and why, name',
    'the strongest and weakest passages, and give the author a direction rather than a rewrite.',
    'Preserve the author\'s voice: raise queries, never impose silent meaning changes.',
    'Fail only when the draft needs a structural revision round, not for line-level nits.',
  ].join(' '),
  'devils-advocate': [
    'You are the assigned devil\'s advocate. Your job is to argue AGAINST this work — that is not a mood, it is',
    'the assignment. Build the strongest honest case that it is wrong, unsupported, or should not ship.',
    'Include a PRE-MORTEM in your critique: assume this shipped and failed badly — write the three most likely',
    'reasons why, in order of likelihood.',
    'Verdict rule: "pass" ONLY if your own case against the work fails on the evidence in front of you. If the',
    'case against it survives your own scrutiny, the verdict is "fail" and the critique is that case.',
  ].join(' '),
  'peer-review': [
    'You are a peer reviewer. Judge method soundness, whether every claim is matched by the evidence offered for',
    'it, and whether the work answers the question it set rather than a nearby easier one.',
    'Spot-check citations: a source that does not exist, does not say what it is cited for, or cannot be checked',
    'from what is written is a fail. Overclaiming — a confident claim on thin evidence, a causal claim from',
    'correlational work, a missing limitations section — is a fail.',
    'Acknowledge where the work is strong; a review that finds nothing at all is a suspicious review, so say so',
    'explicitly if the work genuinely holds up.',
  ].join(' '),
};

/**
 * The numbered acceptance items a reviewer must give a status for. Not the
 * operator's (a person checks those at the gate), and not an item that only
 * says the gate passes once Foreman's own gate run has passed. Read from the
 * same bounded text the prompt shows, so no item is asked for unseen.
 */
export function judgedItems(task: Pick<Task, 'acceptance'>, tests: CrewReviewOptions['tests'] = null): number[] {
  return numberedItems(boundBrief(task.acceptance ?? '', config.acceptanceBytes))
    .filter((i) => i.exempt !== 'operator' && !(i.exempt === 'gate' && tests?.ran && tests.passed))
    .map((i) => i.n);
}

/**
 * The reply field that carries the reviewer's status per acceptance item.
 *
 * In all five early tickets of the Kiln trial the reviewer wrote its own miss
 * down under "Not checked" or UNVERIFIED and passed anyway ("met as far as
 * shown, spot-checks not run"). Prose cannot be held to anything, so the
 * status is a field, and the parser decides what a pass may carry.
 */
function acceptanceContract(items: number[]): string {
  if (!items.length) return '';
  return [
    `ACCEPTANCE STATUS — required. Add a field "acceptance" to your JSON reply with one entry for each of these numbered acceptance items: ${items.join(', ')}.`,
    '"acceptance":[{"item":1,"status":"met"|"partial"|"missing"|"not-verifiable","note":"..."}]',
    '- met: you checked the item against what you were shown (the diff, the files listed, any source attached, the test gate) and it holds.',
    '- partial / missing: the work does not do it, or not all of it. The note says what is owed.',
    '- not-verifiable: you could not check it, because something you needed was not shown to you — source outside the diff, a part of',
    '  the worker\'s report that was cut, a file you could not open. The note names what you needed. "Met as far as shown" is not-verifiable.',
    '- Anything you list as not checked or unverified that an item depends on makes that item not-verifiable or missing, never met.',
    'Foreman reads this field, not your prose. A "pass" with a partial or missing item is recorded as FAIL. A "pass" with a',
    'not-verifiable item, or with an item given no status, is held for a person rather than sent back: the worker cannot fix what you',
    'were not shown, so do not FAIL the work for that alone.',
  ].join('\n');
}

const STATUS_WORDS: Array<[RegExp, AcceptanceEntry['status']]> = [
  [/^(not[- _]?verifiable|unverifiable|unverified|not[- _]?shown|cannot[- _]?(tell|verify)|could[- _]?not[- _]?(check|verify))$/, 'not-verifiable'],
  [/^(partial|partly|partially[- _]?met)$/, 'partial'],
  [/^(missing|not[- _]?met|unmet|fail|failed)$/, 'missing'],
  [/^(met|pass|passed)$/, 'met'],
];

/**
 * Words after "met" that take it back: the reviewer is saying what it did not check. ("Met as far as shown" has no
 * separator after the word and is not read as a status at all.)
 */
const HEDGE =
  /\b(?:as far as|on its face|not (?:checked|run|shown|verified|confirmed|tested|spot-checked|opened|read)|un(?:verified|checked|tested)|(?:could not|cannot|couldn't|can't|did not|didn't|unable to) (?:check|verify|confirm|open|see|read|run|tell)|spot-checks? not)\b/i;

/**
 * One status as a reviewer wrote it. The four words (and their plain synonyms) alone, or the word and then its
 * evidence: every per-item line the Kiln trial's reviewer wrote was "met (the new test asserts…)", and a status
 * field filled that way must not read as "no status" and park every ticket. The word has to stand alone before a
 * bracket or a mark — "met for the two listings", "met as far as shown", "met on its face" are not a status — and a
 * "met" whose own evidence says what was not checked is not-verifiable.
 */
function readStatus(raw: unknown): { status: AcceptanceEntry['status']; rest: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const word = (w: string): AcceptanceEntry['status'] | undefined => STATUS_WORDS.find(([re]) => re.test(w.trim().toLowerCase()))?.[1];
  const alone = word(text.replace(/[.!]+$/, ''));
  if (alone) return { status: alone, rest: '' };
  const cut = /^([A-Za-z][A-Za-z _-]{1,24}?)\s*(?:\((.*?)\)?[.\s]*$|[.:;,]\s+(.*)$|\s+[—–-]\s+(.*)$)/s.exec(text);
  const status = cut ? word(cut[1]!) : undefined;
  if (!cut || !status) return { status: 'unreported', rest: '' };
  const rest = (cut[2] ?? cut[3] ?? cut[4] ?? '').trim();
  return { status: status === 'met' && HEDGE.test(rest) ? 'not-verifiable' : status, rest };
}

/** "3", 3, "item 3", "#3", "3." — the number of an acceptance item, or NaN. */
const itemNumber = (raw: unknown): number =>
  typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(/^(?:item|no\.?|#)\s*/i, '').replace(/[.):]+$/, '') || NaN);

/**
 * A reply's `acceptance` field as one entry per judged item, in item order.
 * An item with no entry, or with a status that is none of the four words, is
 * `unreported`: the reply did not say the item was checked, and nothing here
 * guesses that it was. The list may also come keyed by item
 * (`{"1":"met","2":{"status":"partial","note":"…"}}`): the same statuses in
 * another shape, not a reply without them.
 */
export function readAcceptance(raw: unknown, items: number[]): AcceptanceEntry[] {
  const said = new Map<number, AcceptanceEntry>();
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>).map(([key, value]) =>
          value && typeof value === 'object' && !Array.isArray(value) ? { item: key, ...(value as Record<string, unknown>) } : { item: key, status: value })
      : [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const item = itemNumber(row['item'] ?? row['n'] ?? row['id']);
    if (!Number.isInteger(item) || said.has(item)) continue;
    const { status, rest } = readStatus(row['status']);
    const given = typeof row['note'] === 'string' ? row['note'].trim() : '';
    said.set(item, { item, status, note: (given || rest).slice(0, 400) });
  }
  return items.map((item) => said.get(item) ?? { item, status: 'unreported', note: '' });
}

const itemList = (entries: AcceptanceEntry[]): string =>
  entries.map((e) => `- item ${e.item} (${e.status === 'unreported' ? 'no status given' : e.status})${e.note ? `: ${e.note}` : ''}`).join('\n');

/**
 * What a reviewer's own status list does to its verdict: a pass with an item
 * it calls partial or missing is a FAIL, said in a line the repair round
 * reads. (An item it could not verify does not fail the work — see heldItems.)
 */
function enforceAcceptance(
  reply: { verdict: 'pass' | 'fail'; critique: string },
  acceptance: AcceptanceEntry[],
): { verdict: 'pass' | 'fail'; critique: string; downgraded: boolean } {
  const owed = acceptance.filter((e) => e.status === 'partial' || e.status === 'missing');
  if (reply.verdict !== 'pass' || !owed.length) return { ...reply, downgraded: false };
  const check =
    `FOREMAN CHECK (deterministic): this review said PASS, but its own acceptance status has ` +
    `${owed.map((e) => `item ${e.item} ${e.status}`).join(', ')}. A pass cannot carry an item that is not met, so it is recorded as FAIL:\n` +
    itemList(owed);
  return { verdict: 'fail', critique: reply.critique ? `${reply.critique}\n\n${check}` : check, downgraded: true };
}

/**
 * The acceptance items a verdict's crew reviewers could not verify, or gave
 * no status for, each once. Read from the recorded opinions, never from the
 * critique text: this is what the chain refuses to pass and what the owner
 * gate holds for a person (gate.ts). Empty for a council verdict and for a
 * crew verdict written before the field existed.
 */
export function heldItems(verdict: Pick<Verdict, 'council'> | null | undefined): AcceptanceEntry[] {
  const seen = new Map<number, AcceptanceEntry>();
  for (const opinion of verdict?.council ?? []) {
    if (opinion.error || !Array.isArray(opinion.acceptance)) continue;
    for (const e of opinion.acceptance) {
      if ((e.status === 'not-verifiable' || e.status === 'unreported') && !seen.has(e.item)) seen.set(e.item, e);
    }
  }
  return [...seen.values()].sort((a, b) => a.item - b.item);
}

/**
 * The acceptance items a verdict's crew reviewers called partial or missing, each once. On a FAIL these are the
 * repair round's business. On anything else a chair has passed work whose own reviewer says an item is not met —
 * the chair read less of the source than the reviewer did — and that is a person's to decide (heldReason).
 */
export function owedItems(verdict: Pick<Verdict, 'council'> | null | undefined): AcceptanceEntry[] {
  const seen = new Map<number, AcceptanceEntry>();
  for (const opinion of verdict?.council ?? []) {
    if (opinion.error || !Array.isArray(opinion.acceptance)) continue;
    for (const e of opinion.acceptance) {
      if ((e.status === 'partial' || e.status === 'missing') && !seen.has(e.item)) seen.set(e.item, e);
    }
  }
  return [...seen.values()].sort((a, b) => a.item - b.item);
}

/**
 * The one-line reason a person, not a model, signs such work off; null when every item was verified. It says which
 * it was: "could not verify" is the reviewer's own word about the work it was shown, "gave no status" is a reply
 * that did not fill the field in — a person reading the note must be able to tell a reviewer that was not shown the
 * source from one that answered in the wrong shape — and "says … is not met" is a status list a chair passed over.
 * (That last one only on a verdict that is not a FAIL: a failed review's missing item goes to the repair round.)
 */
export function heldReason(verdict: (Pick<Verdict, 'council'> & { verdict?: CouncilVerdict }) | null | undefined): string | null {
  const held = heldItems(verdict);
  const owed = verdict?.verdict && verdict.verdict !== 'fail' ? owedItems(verdict) : [];
  if (!held.length && !owed.length) return null;
  const list = (entries: AcceptanceEntry[]): string => `acceptance item${entries.length > 1 ? 's' : ''} ${entries.map((e) => e.item).join(', ')}`;
  const unverified = held.filter((e) => e.status === 'not-verifiable');
  const unreported = held.filter((e) => e.status !== 'not-verifiable');
  const first = (unverified.find((e) => e.note) ?? owed.find((e) => e.note))?.note;
  const parts = [
    owed.length ? `says ${list(owed)} ${owed.length > 1 ? 'are' : 'is'} not met${!unverified.length && first ? ` (${first.slice(0, 160)})` : ''}, and a chair passed the work` : '',
    unverified.length ? `could not verify ${list(unverified)}${first ? ` (${first.slice(0, 160)})` : ''}` : '',
    unreported.length ? `gave no status for ${list(unreported)}` : '',
  ].filter(Boolean);
  return `the reviewer ${parts.join(' and ')} — a person decides`;
}

const CHAIR_CONTRACT =
  'Reply with JSON only, no prose outside the object: {"verdict":"pass"|"fail","rationale":"..."}';

/**
 * Deterministic, code-side bound on everything that reaches a reviewer prompt.
 *
 * The cap is style-aware. A code reviewer reads hunks and 12 KB of them is a
 * generous read; a developmental editor is asked to judge whether a draft holds
 * together, and one chapter is a single ~25 KB file of added text. Handing that
 * reviewer the first 12 KB does not produce a shorter letter — it produces a
 * confident letter about beats that were simply past the cut, which then fails
 * the chapter and spawns repair tickets for work the author already did. Prose
 * is reviewed whole or the review is not worth having.
 *
 * When the cap does bite, `truncated` is returned so the prompt can say so
 * FIRST rather than trail a note the reviewer reads after it has decided.
 */
export function boundBody(
  body: string,
  style?: PlaybookReviewer['style'],
): { body: string; truncated: boolean } {
  const prose = style === 'editorial-letter';
  // Every reviewer here is the hosted CLI, so code is bounded by its own
  // ceiling too, not by the local council's 12 KB (see crewCodeDiffCapBytes).
  const cap = prose ? config.proseDiffCapBytes : config.crewCodeDiffCapBytes;
  const maxBody = prose ? config.proseDiffCapBytes : config.crewCodeDiffCapBytes;
  const compacted = body.includes('diff --git') ? compactDiff(body, cap) : body;
  if (compacted.length <= maxBody) {
    // compactDiff drops hunks of its own once the diff is over the cap, and it
    // says so in the text it returns; that is still a partial read.
    return { body: compacted, truncated: compacted !== body };
  }
  return {
    body: `${compacted.slice(0, maxBody)}\n… [truncated, ${compacted.length - maxBody} more chars]`,
    truncated: true,
  };
}

/**
 * Placed at the very top of a prompt whose body did not fit. A reviewer that
 * learns it is reading an excerpt only after the excerpt has nothing left to
 * say has already formed the verdict it is about to justify.
 */
const PARTIAL_READ_NOTICE = [
  'INCOMPLETE MATERIAL: what follows is an EXCERPT of the work, not the whole of it — it was too large',
  'for this prompt and has been cut. Judge only what you can actually read here. Do NOT fail the work,',
  'and do not raise an issue, on the grounds that something is missing, unfinished, unresolved or',
  'uncovered: material past the cut is material you cannot see, not material the author left out.',
  'Say plainly in your critique which parts you could not read.',
].join(' ');

/** The per-run material a review prompt carries beyond the ticket, the diff and the report. */
export interface ReviewPromptExtras {
  reportPath?: string | null;
  foremanNote?: string | null;
  /** The source a changed document cites (verify/citedSource.ts); '' for a diff that changes no prose. */
  cited?: string;
}

/** How much of a reviewer's role prompt its review carries. */
const REVIEWER_ROLE_BYTES = 4_000;

/**
 * The reviewer's own '## role:' prompt from its playbook. Without it a playbook's
 * review standards never reached a review: the prompt carried only the style
 * brief, so whatever a playbook said its senior or architect checks when
 * reviewing was read by nobody. Static per role, so it sits with the style and
 * the prompt cache still hits. The reviewer runs with no tools; the header says
 * so, so a role prompt written for a reviewer that can run things is read as
 * "reason it through from what is shown". A role's "Report back" is written for
 * a worker's prose report and grades findings critical/important/minor; the
 * reply here is JSON whose issue severity is only blocker or normal (anything
 * else is read as normal), so the header says the contract decides the shape
 * and that a critical finding is a blocker. '' when the role has no prompt.
 */
export function reviewerRoleBlock(pb: Playbook, role: string): string {
  const text = (pb.rolePrompts[role] ?? '').trim();
  if (!text) return '';
  return (
    `YOUR ROLE (${role}, from the ${pb.id} playbook). You are reviewing, so its reviewing guidance applies. ` +
    'You have no tools in this review: judge from what this prompt shows you, and say what you could not check. ' +
    'Where it says how to report, the reply contract below decides the shape: findings, their severity and what you ' +
    'could not check go in the critique, and an issue is severity "blocker" (a critical finding) or "normal".\n' +
    boundBrief(text, REVIEWER_ROLE_BYTES, 'reviewer-role')
  );
}

/**
 * static-first for prompt-cache hits: style brief, contract and the playbook's
 * definition of done lead; per-ticket content (title, brief, acceptance, diff)
 * trails — the same KV-prefix ordering the council prompt uses.
 * The reviewer sees the ticket and the diff. Never the whole repo.
 */
export function buildReviewPrompt(
  pb: Playbook,
  reviewer: PlaybookReviewer,
  task: Task,
  body: string,
  truncated = false,
  tests: CrewReviewOptions['tests'] = null,
  tracked = '',
  report: string | null = null,
  extra: ReviewPromptExtras = {},
): string {
  const dod = pb.constraints.length
    ? `DEFINITION OF DONE — hard rules for every ticket in this crew:\n- ${pb.constraints.join('\n- ')}`
    : '';
  return [
    truncated ? PARTIAL_READ_NOTICE : '',
    `REVIEW STYLE (${reviewer.style}):\n${STYLES[reviewer.style]}`,
    reviewerRoleBlock(pb, reviewer.role),
    // The reviewer role's skills, full text: the chain is the hosted CLI. They
    // sit before the contract so the reply format and the definition of done
    // still come after them and still bind; '' when skills are off. A reviewer
    // that names its skills gets exactly those (none, if none can be served);
    // one that does not gets its role's usual ones.
    skillBlock(pb, reviewer.role, 'full', reviewer.skills, true),
    SHARED_CONTRACT,
    dod,
    `TICKET: ${task.title}`,
    `BRIEF:\n${task.prompt}`,
    `ACCEPTANCE CRITERIA:\n${boundBrief(task.acceptance ?? '(none stated — judge against the brief)', config.acceptanceBytes)}`,
    acceptanceContract(judgedItems(task, tests)),
    operatorLine(task),
    repairLine(task),
    testGateLine(tests),
    tracked ? `${tracked}\n(A file listed here exists in the tree the work was done in, whether or not the diff touches it.)` : '',
    extra.cited ?? '',
    reportLine(report, extra),
    `WORK UNDER REVIEW (diff):\n${body || '(the worker produced nothing)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * A repair round is judged against what it was sent back to fix. Without this
 * the reviewer sees only the original brief, and a repair that fixed one of
 * two demanded defects passes: on the first Kiln epic the pty helper got its
 * deadlock fixed, skipped the SIGPIPE reset and the regression test it was
 * told to add, and the next review passed it without knowing either was owed.
 */
function repairLine(task: Pick<Task, 'repairNotes'>): string {
  const notes = task.repairNotes?.trim();
  if (!notes) return '';
  return (
    'THIS IS A REPAIR ROUND. The work was sent back with the demands below. Check each one against ' +
    'the diff; any demand that is neither met nor explicitly argued away in the work is a FAIL.\n' +
    notes.slice(0, 6_000)
  );
}

/**
 * The chair's prompt. static-first for prompt-cache hits: the chair's standing
 * brief and reply contract lead, this round's evidence trails. The operator's
 * demands sit beside the acceptance they extend, so a chair judging "against
 * the acceptance criteria" judges against them too.
 */
export function buildChairPrompt(o: {
  crew: string;
  reason: string;
  councilVerdict: string | null | undefined;
  councilCritique: string | null;
  verdict: string;
  critiques: string[];
  task: Pick<Task, 'title' | 'operatorDemands'>;
  acceptance: string;
  change: string;
}): string {
  const operator = operatorLine(o.task);
  return [
    `You chair the ${o.crew} crew. Two reviews of the same work disagree, or the work keeps failing review.`,
    'Weigh the arguments against the evidence, not against each other. Your verdict is final.',
    OPERATOR_CHECKS,
    CHAIR_CONTRACT,
    `WHY YOU WERE CALLED: ${o.reason}`,
    `LOCAL COUNCIL VERDICT: ${o.councilVerdict ?? '(none)'}\n${(o.councilCritique ?? '(no critique)').slice(0, 2_000)}`,
    `CREW REVIEW VERDICT: ${o.verdict}\n${o.critiques.join('\n\n').slice(0, 4_000) || '(no critique)'}`,
    `TICKET: ${o.task.title}\nACCEPTANCE: ${o.acceptance || '(none stated)'}`,
    operator
      ? `${operator}\nA reviewer demand that restates one of these is the operator's demand, not the reviewer's: ` +
        'you may not pass the work while one is unmet, whatever the original acceptance says.'
      : '',
    `CHANGE UNDER REVIEW: ${o.change}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * How a line Foreman itself writes into a review prompt starts: its checks, its note under the report, its cut
 * marker, the headings of its blocks, a file heading of the cited-source block. Leading markdown is looked through.
 * The phrases no report starts a line with by accident are matched in any case; the short words (FOREMAN, TICKET:)
 * only as Foreman writes them, so "Foreman's gate passed" at the start of a line is left alone.
 */
// The lead is taken off first, in one pass, and each pattern is tested on what follows it. (As one expression —
// lead, then `-{2,}\s*\S+ \(lines` — a line of N dashes cost N cubed steps: 4 000 dashes held the daemon for 13
// seconds, 20 000 for half an hour, and the line is the worker's to write.)
const LEAD = /^[\s>*_#~|\x60\[\]-]*/;
const FOREMAN_PHRASE = new RegExp(
  String.raw`^(?:foreman (?:check|cut)\b|added by foreman\b|source the document cites|acceptance (?:status|criteria)\b|work under review|worker's report\b|` +
    String.raw`not shown, over this block|cited but not read|definition of done|operator demands|this is a repair round|files already tracked|review style\b|your role \()`,
  'i',
);
const FOREMAN_WORD = /^(?:FOREMAN\b|TEST GATE\b|TICKET:|BRIEF:)/;
/** A file heading of the cited-source block, after its dashes: `--- src/server.ts (lines 1-3 of 3) ---`. */
const CITED_HEADING = /^(?:\S+ )?\(lines? \d/i;
/** Does a line, as read, start like one of Foreman's own? */
function startsLikeForeman(plain: string): boolean {
  const lead = LEAD.exec(plain)![0];
  const rest = plain.slice(lead.length);
  return FOREMAN_PHRASE.test(rest) || FOREMAN_WORD.test(rest) || (lead.includes('--') && CITED_HEADING.test(rest));
}
const WORKER_TEXT = "[worker's text] ";

/**
 * A worker's report with every line that starts like one of Foreman's own marked as the worker's. The report is free
 * text and sits in the prompt above the note Foreman adds under it: without this a report could carry its own
 * "--- added by Foreman, not the worker ---" and a FOREMAN CHECK of its choosing, or a SOURCE THE DOCUMENT CITES
 * block quoting source that is not in the tree. An ordinary report has no such line and is returned as it is. (This
 * catches the look-alike a reader would take for the real thing — through the hidden characters the skills loader
 * refuses (skills.ts HIDDEN_CHAR), Cyrillic and Greek letters that print as Latin ones, other dashes, and line breaks
 * other than LF — but it is not a parser: a script with its own look-alikes is not folded, and the reviewer is still
 * told above the report that all of it is the worker's claims.)
 */
/**
 * Letters of other scripts that print as the Latin capitals and small letters Foreman's own headings are written in
 * (Cyrillic, Greek). Folded only in the copy a line is TESTED on, never in the text the reviewer is shown.
 */
const LOOKALIKE: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ѕ: 'S', Ј: 'J', Ԁ: 'D', Ԝ: 'W',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ѕ: 's', ј: 'j', ԁ: 'd', ԝ: 'w', һ: 'h', к: 'k', м: 'm', т: 't', н: 'h',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', ο: 'o', ν: 'v', ι: 'i', κ: 'k',
};
const LOOKALIKES = new RegExp(`[${Object.keys(LOOKALIKE).join('')}]`, 'g');
const HIDDEN_CHARS = new RegExp(HIDDEN_CHAR.source, 'gu');
/** Every character a reader, or a model, takes for the start of a new line. */
const LINE_BREAK = /(\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029])/;

/** A line as it reads, for the test only: compatibility forms folded, hidden characters gone, look-alikes and dashes as ASCII. */
const asRead = (line: string): string =>
  line.normalize('NFKC').replace(HIDDEN_CHARS, '').replace(LOOKALIKES, (ch) => LOOKALIKE[ch]!).replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');

export function quoteWorkerText(report: string): string {
  // Split on every kind of line break and keep each as it was: a lone CR, a form feed or U+2028 starts a line for
  // whoever reads the prompt, and must not hide the start of one from this check.
  return report
    .split(LINE_BREAK)
    .map((part, i) => {
      if (i % 2) return part;
      return startsLikeForeman(asRead(part)) ? `${WORKER_TEXT}${part}` : part;
    })
    .join('');
}

/**
 * The worker's final message, framed so the reviewer weighs it rather than
 * trusts it. Whole under `config.reviewReportBytes`; over it the middle is cut
 * on line breaks and the cut says how much and where the rest is. Foreman's
 * own note goes under the report after that bound, so no cut can reach it,
 * and no line of the report itself can pass for one of Foreman's.
 */
export function reportLine(report: string | null, extra: Pick<ReviewPromptExtras, 'reportPath' | 'foremanNote'> = {}): string {
  const worker = boundReport(quoteWorkerText(report?.trim() ?? ''), extra.reportPath ?? null);
  const note = extra.foremanNote?.trim();
  const text = (note ? `${worker}\n\n--- added by Foreman, not the worker ---\n${note}` : worker).trim();
  if (!text) return '';
  return (
    "WORKER'S REPORT (the worker's own final message: claims, not evidence. Where it disputes a repair demand with a " +
    'reason you can confirm in the diff or the tree, that demand counts as argued away; where you cannot confirm it, ' +
    'it does not):\n' + text
  );
}

/**
 * What a human demanded when rejecting an earlier attempt, stated as acceptance.
 * Repair notes carry only the latest round's critique, so without this the
 * operator's findings reach a later round as a reviewer's opinion — and on the
 * Kiln phase-3 UI ticket the chair overruled three of them as out of scope.
 */
export function operatorLine(task: Pick<Task, 'operatorDemands'>): string {
  const demands = task.operatorDemands?.trim();
  if (!demands) return '';
  return (
    'OPERATOR DEMANDS — a human rejected an earlier attempt at the gate with the findings below. ' +
    'They are part of this ticket\'s acceptance criteria, exactly as binding as the list above, and ' +
    'only the operator can waive one: each must be met in the diff (or shown already met in the tree), ' +
    'or the verdict is FAIL. Never rule one out of scope.\n' +
    demands.slice(-6_000)
  );
}

/**
 * The test stage's outcome, stated as fact. Without it a reviewer that sees
 * only the diff spends its letter asking for a gate run Foreman already did:
 * on the first Kiln epic Opus passed a ticket while writing "I cannot confirm
 * npm run verify passes" about a suite that had run green minutes earlier.
 */
function testGateLine(tests: CrewReviewOptions['tests']): string {
  if (!tests) return '';
  if (!tests.ran || !tests.cmd) {
    return 'TEST GATE: no test command ran for this work — judge correctness from the diff alone.';
  }
  return tests.passed
    ? `TEST GATE: Foreman ran \`${tests.cmd}\` on exactly this work and it PASSED (exit 0). ` +
      'Do not ask for its output; judge whether the tests are the right tests.'
    : `TEST GATE: Foreman ran \`${tests.cmd}\` on exactly this work and it FAILED.`;
}

/**
 * (version, model, the exact prompt that was sent) — the whole of what was
 * asked. Hashing the built prompt rather than its parts is what keeps ticket
 * identity in the key: the prompt embeds the title, the brief and the
 * definition of done, so two tickets with byte-identical diffs can no longer
 * replay each other's verdicts.
 */
function reviewKey(model: string, reviewer: PlaybookReviewer, prompt: string): string {
  // The role, the style and the skill list are named beside the prompt: two reviewers on one tier and one diff
  // (architect and senior) must never replay each other's verdict, whatever their prompts happen to share.
  const skills = reviewer.skills === undefined ? 'default' : JSON.stringify(reviewer.skills);
  return createHash('sha256')
    .update(
      [CREW_REVIEW_VERSION, model, reviewer.role, reviewer.style, skills, prompt].join('\u0000'),
    )
    .digest('hex');
}

function normalizeIssues(raw: unknown, style: PlaybookReviewer['style']): CrewIssue[] {
  if (!Array.isArray(raw)) return [];
  const issues: CrewIssue[] = [];
  for (const entry of raw) {
    // The reviewer's own share of the verdict's five, taken before the global
    // slice so no reviewer can spend another reviewer's slots.
    if (issues.length >= MAX_ISSUES_PER_REVIEWER) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const title = String(row['title'] ?? '').trim();
    const prompt = String(row['prompt'] ?? '').trim();
    // An issue with no brief is not a ticket anybody could work; drop it
    // rather than file a child task whose prompt is its own title.
    if (!title || !prompt) continue;
    const role = typeof row['role'] === 'string' && row['role'].trim() ? row['role'].trim() : null;
    issues.push({
      title: title.slice(0, 120),
      prompt: prompt.slice(0, 8_000),
      severity: String(row['severity'] ?? '').toLowerCase() === 'blocker' ? 'blocker' : 'normal',
      role,
      style,
    });
  }
  return issues;
}

/**
 * Fail-closed on shape, not on content: a reply that does not carry a pass/fail
 * verdict is treated as no reply at all (the reviewer is unavailable), never as
 * a fail — an unreachable or babbling reviewer must not reject working code.
 */
export function parseReview(
  text: string,
  style: PlaybookReviewer['style'],
): { verdict: 'pass' | 'fail'; critique: string; issues: CrewIssue[]; acceptance: unknown } | null {
  const parsed = extractJson<{ verdict?: unknown; critique?: unknown; issues?: unknown; acceptance?: unknown }>(text);
  if (!parsed) return null;
  const verdict = String(parsed.verdict ?? '').toLowerCase();
  if (verdict !== 'pass' && verdict !== 'fail') return null;
  const critique = typeof parsed.critique === 'string' ? parsed.critique.trim().slice(0, MAX_CRITIQUE) : '';
  // The status list as the reviewer wrote it; readAcceptance decides what it says about each judged item.
  return { verdict, critique, issues: normalizeIssues(parsed.issues, style), acceptance: parsed.acceptance };
}

function parseChair(text: string): { verdict: 'pass' | 'fail'; rationale: string } | null {
  const parsed = extractJson<{ verdict?: unknown; rationale?: unknown }>(text);
  if (!parsed) return null;
  const verdict = String(parsed.verdict ?? '').toLowerCase();
  if (verdict !== 'pass' && verdict !== 'fail') return null;
  return {
    verdict,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim().slice(0, MAX_CRITIQUE) : '',
  };
}

/** Cheap shape of the change for the chair: file counts, not the whole diff. */
function summarizeDiff(body: string): string {
  const stats = diffStats(body);
  if (!stats.length) return `${body.split('\n').length} line(s) of output`;
  const total = stats.reduce((n, s) => n + s.added + s.removed, 0);
  const files = stats
    .slice(0, 12)
    .map((s) => `${s.path} (+${s.added}/-${s.removed})`)
    .join(', ');
  return `${stats.length} file(s), ${total} changed line(s): ${files}${stats.length > 12 ? ', …' : ''}`;
}

/** True when the local council passed and every advisor that spoke agreed. */
function unanimousCouncilPass(council: Verdict | null | undefined): boolean {
  if (!council || council.verdict !== 'pass') return false;
  return council.council.length > 0 && council.council.every((o) => !o.error && o.verdict === 'pass');
}

/** A crew review reads as an advisor opinion on the board and in the trace. */
function asOpinion(outcome: CrewReviewOutcome): AdvisorOpinion {
  return {
    model: outcome.model,
    provider: OWNER_PROVIDER,
    local: false,
    verdict: outcome.verdict,
    // A reviewer that answered stands behind its verdict; one that could not be
    // reached carries no weight at all.
    confidence: outcome.error ? 0 : 1,
    critique: outcome.critique,
    costUsd: outcome.costUsd,
    // Crew reviews don't time a single round-trip the way council advisors do
    // (a review can involve retries, caching, chair calls); 0 would read as a
    // real (and misleadingly fast) latency, so this is left unset instead —
    // the board renders role + style for a crew entry rather than a latency figure.
    latencyMs: 0,
    role: outcome.role,
    style: outcome.style,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.acceptance?.length ? { acceptance: outcome.acceptance } : {}),
  };
}

/** Titles compare as work, not as text: case and spacing are not identity. */
function issueKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'is', 'are', 'be', 'too',
  'it', 'its', 'this', 'that', 'when', 'while',
]);

/**
 * A title split into exact tokens — numbers and anything path- or
 * identifier-shaped (with . / ( _ or a digit: "Chapter 12", "parse()",
 * "settings.ts") — and content words (lowercase, stopwords gone).
 */
function titleParts(title: string): { exact: Set<string>; words: Set<string> } {
  const exact = new Set<string>();
  const words = new Set<string>();
  for (const raw of title.toLowerCase().split(/\s+/)) {
    const tok = raw.replace(/^[^\w(./]+|[^\w)]+$/g, '');
    if (!tok) continue;
    if (/[./(_\d]/.test(tok)) {
      exact.add(tok);
      continue;
    }
    for (const w of tok.split(/[^a-z0-9]+/)) if (w && !TITLE_STOPWORDS.has(w)) words.add(w);
  }
  return { exact, words };
}

/** Token Jaccard over content words at or above this makes two follow-up titles the same defect. */
export const DUPLICATE_TITLE_SIMILARITY = 0.75;
/** Content words each title needs before similarity means anything: short titles differ by one word. */
const MIN_TITLE_WORDS = 4;

export function titlesSimilar(a: string, b: string): boolean {
  const x = titleParts(a);
  const y = titleParts(b);
  // A different chapter, file or function is a different defect, however alike the words.
  if (x.exact.size !== y.exact.size || [...x.exact].some((t) => !y.exact.has(t))) return false;
  if (x.words.size < MIN_TITLE_WORDS || y.words.size < MIN_TITLE_WORDS) return false;
  let both = 0;
  for (const w of x.words) if (y.words.has(w)) both++;
  return both / (x.words.size + y.words.size - both) >= DUPLICATE_TITLE_SIMILARITY;
}

/** One repo, however its path was written ("./kiln" and "/abs/kiln" are the same checkout). */
function sameRepo(a: string | null, b: string | null): boolean {
  return (a ? path.resolve(a) : null) === (b ? path.resolve(b) : null);
}

/** Statuses a follow-up is no longer a live duplicate in. */
const CLOSED_FOR_DEDUPE = new Set(['done', 'failed', 'rejected', 'canceled']);

/**
 * Open follow-ups under `task`'s epic — every descendant of the chain's root,
 * never the ancestors themselves (an issue resembling the epic's title is not
 * the epic) nor the task — that a new follow-up could duplicate. Two review
 * rounds filed "…release the settings-save hold early" and "…release the
 * settings hold too early" for one defect, in different places under one epic.
 */
function openFollowUpsAlongChain(store: Store, task: Task): Task[] {
  const chain = new Set<string>([task.id]);
  let root: Task = task;
  while (root.parentId && !chain.has(root.parentId) && chain.size <= MAX_EPIC_DEPTH + 1) {
    const parent = store.getTask(root.parentId);
    if (!parent) break;
    chain.add(parent.id);
    root = parent;
  }
  const out: Task[] = [];
  const queue = [root.id];
  const seen = new Set<string>(queue);
  for (let depth = 0; queue.length && depth <= MAX_EPIC_DEPTH + 1; depth++) {
    for (const id of queue.splice(0)) {
      for (const child of store.childrenOf(id)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        queue.push(child.id);
        // Same repo only: a like-named ticket in another repo is other work.
        if (!chain.has(child.id) && !CLOSED_FOR_DEDUPE.has(child.status) && child.archivedAt == null && sameRepo(child.repo, task.repo)) out.push(child);
      }
    }
  }
  return out;
}


/**
 * Review-filed tickets anywhere under this task's epic root. Planned tickets
 * do not count: the ceiling is on work reviewers invent, not work the plan
 * asked for.
 */
function reviewFiledInEpic(store: Store, taskId: string): number {
  // Climb to the nearest epic — not the top of the tree. An epic built under
  // another ticket has its own budget; sharing one across every nested epic
  // would let an old, finished one starve a new one.
  let root = taskId;
  const climbed = new Set<string>();
  for (let t = store.getTask(root); t && !t.isEpic && t.parentId && !climbed.has(t.parentId); t = store.getTask(root)) {
    climbed.add(root);
    root = t.parentId;
  }
  let count = 0;
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length) {
    for (const child of store.childrenOf(queue.shift()!)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (child.prompt.startsWith(FILED_PREFIX)) count++;
      queue.push(child.id);
    }
  }
  return count;
}

/** Heading of the warning event a dropped review issue is recorded under. */
export const DROPPED_ISSUE_PREFIX = 'DROPPED REVIEW ISSUE';

/**
 * A review issue the caps refused to file is still the reviewer's finding.
 * Recording it whole (title, severity, body) as a warning event keeps it on the
 * board, in `foreman show` and in the gate summary, so the operator can file it
 * by hand — a count in a log note lost a real fail-open finding on 2026-10-09.
 */
function recordDropped(store: Store, task: Task, issue: CrewIssue, why: string, runId?: string | null): void {
  // Once per title per review: two reviewers raising one issue (or a cached
  // and a fresh copy of it) is one finding. A later round records it again,
  // which is what formatDroppedIssues counts.
  const key = issueKey(issue.title);
  const already = store.warningsWithPrefix(task.id, DROPPED_ISSUE_PREFIX)
    .some((e) => e.runId === (runId ?? null) && issueKey(droppedIssueTitle(e.message.split('\n')[0]!)) === key);
  if (already) return;
  store.record({
    taskId: task.id,
    runId: runId ?? null,
    type: 'warning',
    stage: 'verify',
    message: `${DROPPED_ISSUE_PREFIX} [${issue.severity}] ${issue.title} (${why})\n${issue.prompt}`,
  });
}

/**
 * The task's dropped-issue warnings since it last parked or was decided —
 * every round of the current attempt, so a fail-at-depth round's issues still
 * reach the gate of the pass that follows it. The boundary is the last park
 * or decision before the latest run started.
 */
export function droppedSinceLastPark(store: Store, taskId: string): RunEvent[] {
  const drops = store.warningsWithPrefix(taskId, DROPPED_ISSUE_PREFIX);
  const latest = store.latestRun(taskId);
  if (!latest || !drops.length) return drops;
  const row = store.db.prepare(
    `SELECT MAX(id) AS id FROM events WHERE task_id = ? AND type = 'status'
       AND (message LIKE 'awaiting-approval%' OR message LIKE 'done%' OR message LIKE 'rejected%')
       AND id < (SELECT COALESCE(MIN(id), 0) FROM events WHERE run_id = ?)`,
  ).get(taskId, latest.id) as Record<string, unknown> | undefined;
  const boundary = Number(row?.['id'] ?? 0);
  return drops.filter((e) => e.id > boundary);
}

/** Drops a person must decide on: the epic's depth limit or its cap — not a duplicate of a ticket already open. */
export function isCapDrop(e: RunEvent): boolean {
  return / parents deep, max |epic already carries/.test(e.message.split('\n')[0]!);
}

/** The dropped-issue warnings among a task's events, oldest first. */
export function droppedIssueEvents(events: RunEvent[]): RunEvent[] {
  return events.filter((e) => e.type === 'warning' && e.message.startsWith(DROPPED_ISSUE_PREFIX));
}

/**
 * `events` plus every dropped-issue warning the task ever recorded. The tail
 * window of `eventsForTask` drops them once a retry logs enough, which is
 * exactly when the operator needs them; ordered by id, no duplicates.
 */
export function withDroppedIssues(store: Store, taskId: string, events: RunEvent[]): RunEvent[] {
  const seen = new Set(events.map((e) => e.id));
  const missing = store.warningsWithPrefix(taskId, DROPPED_ISSUE_PREFIX).filter((e) => !seen.has(e.id));
  return missing.length ? [...missing, ...events].sort((a, b) => a.id - b.id) : events;
}

/**
 * Dropped-issue events for a prompt: one per title (a retry re-files the same
 * finding) and each body cut to `maxBody`, so a prompt does not grow with retries.
 */
function droppedIssueTitle(head: string): string {
  return head.slice(DROPPED_ISSUE_PREFIX.length + 1).replace(/^\[[^\]]*\] /, '').replace(/ \([^()]*\)$/, '');
}

export function boundDroppedIssues(events: RunEvent[], maxBody: number): RunEvent[] {
  // Latest entry per title wins, in first-seen order, so this agrees with
  // formatDroppedIssues on severity and body.
  const byTitle = new Map<string, RunEvent>();
  for (const e of droppedIssueEvents(events)) {
    const nl = e.message.indexOf('\n');
    const head = nl < 0 ? e.message : e.message.slice(0, nl);
    byTitle.set(issueKey(droppedIssueTitle(head)), nl < 0 ? e : { ...e, message: head + e.message.slice(nl, nl + 1 + maxBody) });
  }
  return [...byTitle.values()];
}

/**
 * The dropped issues as an operator-facing block; '' when there are none. One
 * entry per title (a retry re-drops the same finding): the latest body, and
 * how many times it was dropped.
 */
export function formatDroppedIssues(events: RunEvent[]): string {
  const byTitle = new Map<string, { event: RunEvent; count: number }>();
  for (const e of droppedIssueEvents(events)) {
    const nl = e.message.indexOf('\n');
    const title = issueKey(droppedIssueTitle(nl < 0 ? e.message : e.message.slice(0, nl)));
    byTitle.set(title, { event: e, count: (byTitle.get(title)?.count ?? 0) + 1 });
  }
  if (!byTitle.size) return '';
  return [
    `Review issues NOT filed (${byTitle.size}) — file by hand with 'foreman add':`,
    ...[...byTitle.values()].map(({ event, count }) => {
      const text = event.message.slice(DROPPED_ISSUE_PREFIX.length + 1);
      const nl = text.indexOf('\n');
      const entry = count > 1
        ? (nl < 0 ? text : text.slice(0, nl)) + ` [dropped ${count} times]` + (nl < 0 ? '' : text.slice(nl))
        : text;
      return `- ${entry.replace(/\n/g, '\n    ')}`;
    }),
  ].join('\n');
}

/** Tag on a follow-up only the operator can do; the board lists it in 'Yours to do' (assignee human). */
export const OPERATOR_TAG = '(operator)';

const OS_NAMES: Record<string, NodeJS.Platform> = { linux: 'linux', windows: 'win32', macos: 'darwin', 'mac os': 'darwin', darwin: 'darwin' };
// A request to do something somewhere: the verb opens a clause ("Recapture …", "…; re-run …", "Please verify …").
// "crashes on Linux", "taken on macOS", "make it work on Windows" open with no such verb and stay with a worker.
const ASK_VERB = String.raw`(?:re-?run|run|re-?capture|capture|re-?take|reproduce|repro|re-?test|test|verify|confirm|check|try|measure|benchmark|profile|install|smoke-test)`;
const CLAUSE_START = String.raw`(?:^|[.;:!?]\s+|\n\s*(?:[-*]\s+|\d+[.)]\s+)?|\b(?:and|then|please|also)\s+)`;
// The place: an OS (not "Windows-style paths"), another machine, or hardware no worker has.
const OS_PLACE = String.raw`(linux|windows|macos|mac os|darwin)\b(?!\s*[-/]?\s*(?:style|specific|path|paths|separator|separators|line|lines)\b)`;
const OTHER_PLACE = String.raw`((?:another|different|other|separate)\s+(?:machine|host|computer|workstation|operating system|os)|(?:intel|x86(?:[-_]64)?|x64)\s+mac|apple silicon(?:\s+mac)?|(?:physical|real)\s+(?:iphone|ipad|device|phone)|iphone|ipad|android(?:\s+(?:device|phone))?)\b`;
const PLACE = String.raw`(?:on|under|in|using)\s+(?:a\s+|an\s+|the\s+)?(?:real\s+|native\s+|physical\s+|clean\s+|fresh\s+)?(?:${OS_PLACE}|${OTHER_PLACE})`;
// Verb, then at most eight words in the same clause, then the place: "Re-run the suite on Linux", "test on an Intel Mac".
const ASK_THERE = new RegExp(String.raw`${CLAUSE_START}${ASK_VERB}\b(?:\s+[^\s.;:!?,]+){0,8}?\s+${PLACE}`, 'gi');
// "needs a Linux box", "requires access to a Windows machine".
const NEEDS_HOST = new RegExp(String.raw`\b(?:needs?|requires?)\s+(?:access\s+to\s+)?(?:a|an)\s+(?:real\s+|physical\s+)?(linux|windows|macos|mac os|darwin)\s+(?:machine|host|box|computer|vm|runner)\b`, 'gi');
// Hardware this host does not have whatever its OS: another machine, a phone, a Mac of another architecture.
const ARCH_MACS: Record<string, NodeJS.Architecture> = { intel: 'x64', x86: 'x64', x86_64: 'x64', 'x86-64': 'x64', x64: 'x64', 'apple silicon': 'arm64' };

/**
 * Why no worker on this host can do `text`, or null when one can. Pure. A follow-up is host-impossible when a
 * clause ASKS for work somewhere else — a request verb (run, re-run, recapture, reproduce, test, verify, …) and,
 * in the same clause, "on"/"under" an OS other than `platform`, another machine/host/OS, a phone, or a Mac of
 * another architecture ("recapture on Linux", "test on an Intel Mac") — or says it needs a box of another OS.
 * A description is not an ask: "crashes on Linux", "taken on macOS", "make it work on Windows" stay with a worker.
 */
export function hostImpossibleReason(text: string, platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): string | null {
  for (const m of text.matchAll(ASK_THERE)) {
    const os = m[1]?.toLowerCase();
    if (os) {
      if (OS_NAMES[os] !== platform) return `it asks for work on ${os}, and this host is ${platform}`;
      continue;
    }
    const place = m[2]!.toLowerCase().replace(/\s+/g, ' ');
    const mac = /^(intel|x86[-_]64|x86|x64|apple silicon)/.exec(place);
    if (mac && platform === 'darwin' && ARCH_MACS[mac[1]!] === arch) continue;
    return `it asks for work on ${place}`;
  }
  for (const m of text.matchAll(NEEDS_HOST)) {
    const os = m[1]!.toLowerCase();
    if (OS_NAMES[os] !== platform) return `it asks for work on ${os}, and this host is ${platform}`;
  }
  return null;
}

/**
 * The parent's skills for a follow-up of `role`: exactly the parent's list when that role may carry it, else
 * the part it may carry (the rest is named in `dropped`). A parent with none gives none. A skill the role may
 * not carry must not cost the follow-up — the store refuses a ticket whole on any refused name.
 */
function inheritedSkills(task: Task, playbook: string, role: string): { skills: string[] | null; dropped: string[] } {
  if (!task.skills?.length) return { skills: null, dropped: [] };
  const check = checkTicketSkills({ playbook, role }, task.skills);
  return { skills: check.names.length ? check.names : null, dropped: check.refused.map((r) => `${r.name} (${r.reason})`) };
}

/**
 * File a reviewer's issues as child tickets of the reviewed task. Capped at
 * MAX_ISSUES and depth-guarded with the same counter `crewPlan` uses, because
 * a review that spawns work that spawns reviews is how a queue runs away.
 * Deduped against the children this task already has: a repair round re-reviews
 * the same work, and the same follow-up must not be filed twice.
 */
function fileIssues(
  store: Store,
  task: Task,
  pb: Playbook,
  issues: CrewIssue[],
  opts: { branch?: string | null; runId?: string | null } = {},
  onNote?: (line: string) => void,
): string[] {
  if (!issues.length) return [];
  const seen = new Set(store.childrenOf(task.id).map((c) => issueKey(c.title.replace(`${OPERATOR_TAG} `, ''))));
  const depth = epicDepth(store, task.id);
  if (depth >= MAX_EPIC_DEPTH) {
    onNote?.(
      `not filing ${issues.length} review issue(s): ${task.id} is already ${depth} parents deep (max ${MAX_EPIC_DEPTH})`,
    );
    for (const issue of issues) recordDropped(store, task, issue, `${depth} parents deep, max ${MAX_EPIC_DEPTH}`, opts.runId);
    return [];
  }
  let budget = MAX_ISSUES_PER_EPIC - reviewFiledInEpic(store, task.id);
  const filed: string[] = [];
  const open = openFollowUpsAlongChain(store, task);
  // Blockers first: when the ceiling bites, what it drops should be the nits.
  const ordered = [...issues].sort((a, b) => Number(b.severity === 'blocker') - Number(a.severity === 'blocker'));
  for (const issue of ordered) {
    if (budget <= 0) {
      onNote?.(
        `not filing review issue '${issue.title}': this epic already carries ${MAX_ISSUES_PER_EPIC} ` +
        'review-filed tickets — raise it with the operator instead',
      );
      recordDropped(store, task, issue, `epic already carries ${MAX_ISSUES_PER_EPIC} review-filed tickets`, opts.runId);
      continue;
    }
    const key = issueKey(issue.title);
    if (seen.has(key)) {
      onNote?.(`skipping review issue already filed under ${task.id}: ${issue.title}`);
      continue;
    }
    const twin = open.find((t) => titlesSimilar(t.title, issue.title));
    if (twin) {
      onNote?.(`skipping review issue '${issue.title}': duplicate of ${twin.id} (${twin.title})`);
      // Recorded whole, like any unfiled issue, so the park note and the gate
      // summary name it — a wrong match must be visible to the operator.
      recordDropped(store, task, issue, `duplicate of ${twin.id}`, opts.runId);
      continue;
    }
    seen.add(key);
    // An invented role has no tier and no role prompt, so it would run as a
    // nameless worker; remap it exactly as a planned ticket's role is remapped.
    const role = issue.role && pb.roles[issue.role] ? issue.role : firstWorkerRole(pb);
    // Work no worker on this host can do goes to the operator (assignee human: never dispatched to a runner).
    const hostReason = hostImpossibleReason(`${issue.title}\n${issue.prompt}`);
    const inherited = inheritedSkills(task, pb.id, role);
    try {
      // When it may start (verify/followUpChain.ts): behind the open follow-ups already filed on this ticket, and
      // behind any open ticket in the repo that names a file its brief names — an order, which a ticket that ends
      // canceled or failed leaves without taking this one down (Store.reconcileBlocked). Edges to tickets that already
      // exist cannot close a cycle; were the check ever to say otherwise, the follow-up keeps only its wait for the parent.
      const plan = planFollowUpChain(store, task, `${issue.title}\n${issue.prompt}`);
      const safe = chainIsAcyclic(store, [task.id, ...plan.links.map((l) => l.id)]);
      const links = safe ? plan.links : [];
      const child = store.addTask({
        title: hostReason ? `${OPERATOR_TAG} ${issue.title}` : issue.title,
        assignee: hostReason ? 'human' : null,
        prompt: `${FILED_PREFIX}${issue.style} review of ${task.id}: ${task.title}\n\n${issue.prompt}`,
        kind: task.kind,
        runner: task.runner,
        repo: task.repo,
        // The issue is ABOUT the reviewed work, which has not merged yet, so
        // the follow-up waits for that work to LAND and is then cut from main,
        // where it now is. Two earlier answers both failed on Kiln phase 4a:
        // cutting from the reviewed run's branch found it empty (the work is
        // uncommitted in the jail until approval), and once the follow-up
        // waited, that branch could name a run the ticket later replaced (a
        // rejection, a retry) — a dead branch ten commits behind main. If the
        // reviewed work is rejected for good, the follow-up is moot and dies
        // with it.
        baseRef: null,
        deps: [task.id, ...links.map((l) => l.id)],
        // A ticket held for a person keeps its follow-ups held for a person: nine follow-ups of human-gated
        // tickets were born with no gate of their own and so took the house default. Only the hold is inherited —
        // a parent opted in to the owner gate does not opt in the work a reviewer invented.
        gate: task.gate === 'human' ? 'human' : null,
        role,
        playbook: pb.id,
        parentId: task.id,
        sensitivity: task.sensitivity,
        budgetUsd: task.budgetUsd,
        // The parent's gate, not whatever detectTestCmd guesses: a reviewer-
        // filed follow-up with none ran `npm test` and skipped the typecheck.
        testCmd: task.testCmd ?? null,
        // The parent's list; none stays none (null), never the role default or a different override.
        skills: inherited.skills,
      });
      if (inherited.dropped.length) {
        store.record({
          taskId: child.id,
          type: 'warning',
          message: `skills of ${task.id} not carried, ${pb.id}.${role} may not carry them: ${inherited.dropped.join('; ')}`.slice(0, 500),
        });
      }
      if (hostReason) store.record({ taskId: child.id, type: 'status', message: `filed for the operator: ${hostReason}` });
      // The plan, on the follow-up's own timeline, so "why has this not started" has an answer there.
      store.record({ taskId: child.id, type: 'status', message: `waits for ${task.id}: it was filed on that ticket's work and is cut from main once it lands` });
      for (const link of links) store.record({ taskId: child.id, type: 'status', message: `waits for ${link.id}: ${link.why}` });
      if (!safe) store.record({ taskId: child.id, type: 'warning', message: 'the dependency graph could not be shown free of a cycle; this follow-up waits only for the ticket it was filed on' });
      for (const note of plan.notes.slice(0, 5)) store.record({ taskId: child.id, type: 'status', message: `chain: ${note}`.slice(0, 500) });
      filed.push(child.id);
      open.push(child);
      budget--;
      onNote?.(`filed ${issue.severity} issue as ${child.id} (${role}): ${issue.title}`);
    } catch (err) {
      // A rejected child ticket is a lost follow-up, never a failed review.
      onNote?.(`could not file review issue '${issue.title}': ${(err as Error).message.slice(0, 200)}`);
    }
  }
  return filed;
}

/** The chair's reservation out of the chain's budget: one share per reviewer plus its own, never under a second. */
export function crewChairShareMs(timeoutMs: number, reviewers: number): number {
  return Math.max(1_000, Math.floor(timeoutMs / (reviewers + 1)));
}

const PARTIAL_PASS = 'gave no usable answer and the rest passed';

/**
 * The run was stopped — canceled, or the daemon shutting down — rather than
 * merely out of time. An abort that names no cause counts as a cancel: only a
 * deadline is known to leave the review standing.
 */
function halted(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) && abortCause(signal) !== 'deadline';
}

/** The timeline note a chain writes when it lost a reviewer and the rest passed (a split, or no verdict under a council FAIL). */
export function isPartialPassNote(message: string): boolean {
  return message.startsWith('crew review incomplete: ') && message.includes(PARTIAL_PASS);
}

/**
 * Run a playbook's review chain over one run's work.
 *
 * Returns null — meaning "the caller keeps the council-only semantics it
 * already has" — when there is no playbook, no reviewer chain, nothing to
 * review, the skip rule fires, the task was canceled mid-review, every
 * reviewer turned out to be unreachable, or a reviewer was lost and the rest
 * passed work the local council had FAILED (a partial PASS cannot overrule a
 * fail; any other partial PASS is recorded as a split). A crew chain that
 * cannot be run must never wedge a task; it degrades to the verdict the local
 * council already produced, and says in the log why.
 */
export async function crewReview(opts: CrewReviewOptions): Promise<CrewVerdict | null> {
  const { task, store, runId, onNote } = opts;
  const pb = task.playbook ? getPlaybook(task.playbook) : null;
  if (!pb || !pb.reviewers.length) return null;

  // The reviewer is the hosted claude CLI: the diff would leave this machine.
  // S2 promises it never does, so the council's verdict stands alone.
  if (task.sensitivity === 'S2') {
    onNote?.('crew review skipped: S2 work is never sent to the hosted reviewer chain');
    return null;
  }

  // Each reviewer style gets its own bound; prose keeps the whole draft.
  const bounded = new Map<PlaybookReviewer['style'], { body: string; truncated: boolean }>();
  for (const reviewer of pb.reviewers) {
    if (!bounded.has(reviewer.style)) bounded.set(reviewer.style, boundBody(opts.diff.trim(), reviewer.style));
  }
  const body = bounded.values().next().value?.body ?? '';
  if (!body) {
    onNote?.('crew review skipped: nothing to review');
    return null;
  }

  const mode = crewReviewMode();
  const lines = opts.diff.trim().split('\n').length;
  if (mode === 'escalate' && unanimousCouncilPass(opts.council) && lines < SMALL_DIFF_LINES) {
    onNote?.(
      `crew review skipped: council passed unanimously and the diff is ${lines} line(s) ` +
        `(< ${SMALL_DIFF_LINES}); set FOREMAN_CREW_REVIEW=always to review anyway`,
    );
    return null;
  }

  const acceptance = boundBrief(task.acceptance ?? '', config.acceptanceBytes);
  const tracked = opts.treeDir ? trackedListing(opts.treeDir) : '';
  const judged = judgedItems(task, opts.tests ?? null);
  const extras: ReviewPromptExtras = {
    reportPath: opts.reportPath ?? null,
    foremanNote: opts.foremanNote ?? null,
    cited: opts.treeDir ? citedSourceBlock(opts.diff, opts.treeDir, opts.workerReport ?? null) : '',
  };
  // The caller's timeout is the budget for the WHOLE chain, not for each call:
  // it is what is left of the task deadline. The reviewers run concurrently and
  // no reviewer reads another's output, so they share one wall clock rather
  // than a slice each — only the chair, which runs strictly after them, needs
  // its own reservation carved out first.
  const chairShareMs = opts.timeoutMs === undefined ? undefined : crewChairShareMs(opts.timeoutMs, pb.reviewers.length);
  const reviewShareMs = opts.timeoutMs === undefined || chairShareMs === undefined
    ? undefined
    : Math.max(1_000, opts.timeoutMs - chairShareMs);

  /**
   * One reviewer's turn. Notes are buffered rather than emitted as they happen:
   * the calls overlap, and an interleaved timeline would read as nonsense (and
   * would make the log order depend on which CLI answered first). They are
   * replayed in reviewer order once the fan-out settles.
   */
  const reviewOne = async (
    reviewer: PlaybookReviewer,
  ): Promise<{ outcome: CrewReviewOutcome; notes: string[] }> => {
    const notes: string[] = [];
    const model = tierModel(pb.roles[reviewer.role]?.tier ?? 'senior');
    const view = bounded.get(reviewer.style) ?? { body, truncated: false };
    if (view.truncated) {
      notes.push(
        `crew review: ${reviewer.role} (${reviewer.style}) is reading an excerpt — the work exceeded ` +
          'its prompt cap and its letter is told so up front',
      );
    }
    const prompt = buildReviewPrompt(pb, reviewer, task, view.body, view.truncated, opts.tests ?? null, tracked, opts.workerReport ?? null, extras);
    const key = reviewKey(model, reviewer, prompt);
    // Which skills this reviewer's prompt carries and what was refused, on the timeline. A 'status' event, not a
    // 'skills' one: those are the worker run's record, read per run by the debrief and per ticket by a resume.
    if (reviewer.skills !== undefined && config.skillsDir) {
      store.record({
        taskId: task.id, runId, type: 'status', stage: 'verify',
        message: `crew review skills ${skillsRunRecord(pb, reviewer.role, 'full', reviewer.skills, false, true)}`,
      });
    }

    // Still per-reviewer and still before the spawn: a cache hit must not cost
    // a process, concurrency or not.
    const cached = store.getCachedReview(key);
    if (cached) {
      // Book the $0 receipt anyway, so the ledger stays honest about the win.
      store.addReceipt({
        taskId: task.id, runId, kind: 'review:cache',
        provider: OWNER_PROVIDER, model, local: false, costUsd: 0,
      });
      // The cache holds the reply as the reviewer gave it; what its status list does to the verdict is applied
      // on every read, the same as on the first.
      const stored = JSON.parse(cached.issuesJson) as unknown;
      const kept = Array.isArray(stored) ? { issues: stored, acceptance: undefined } : (stored ?? {}) as { issues?: unknown; acceptance?: unknown };
      const acceptance = readAcceptance(kept.acceptance, judged);
      const ruled = enforceAcceptance(cached, acceptance);
      if (ruled.downgraded) notes.push(`${reviewer.role} (${reviewer.style}): pass recorded as fail — its own acceptance status has an item not met`);
      notes.push(`${reviewer.role} (${reviewer.style}): ${ruled.verdict} [cached, $0] ${cached.critique.slice(0, 160)}`);
      return {
        notes,
        outcome: {
          role: reviewer.role, style: reviewer.style, model,
          verdict: ruled.verdict, critique: ruled.critique,
          issues: normalizeIssues(kept.issues, reviewer.style),
          costUsd: 0, cached: true,
          ...(acceptance.length ? { acceptance } : {}),
        },
      };
    }

    try {
      const res = await ownerCall(prompt, {
        signal: opts.signal,
        model,
        maxTurns: REVIEW_MAX_TURNS,
        timeoutMs: reviewShareMs,
        store,
        kind: 'review',
        taskId: task.id,
      });
      const parsed = parseReview(res.text, reviewer.style);
      if (!parsed) {
        // Unparseable is unavailable, not a fail: the other reviewers still count.
        notes.push(`${reviewer.role} (${reviewer.style}): unusable reply, skipping — ${res.text.slice(0, 160)}`);
        return {
          notes,
          outcome: {
            role: reviewer.role, style: reviewer.style, model, verdict: 'fail', critique: '',
            issues: [], costUsd: res.costUsd, cached: false, error: `unparseable reply: ${res.text.slice(0, 200)}`,
          },
        };
      }
      const acceptance = readAcceptance(parsed.acceptance, judged);
      store.putCachedReview(key, model, {
        verdict: parsed.verdict,
        critique: parsed.critique,
        // A ticket with no judged item keeps the plain list this column has always held.
        issuesJson: JSON.stringify(judged.length ? { issues: parsed.issues, acceptance } : parsed.issues),
      });
      const ruled = enforceAcceptance(parsed, acceptance);
      if (ruled.downgraded) notes.push(`${reviewer.role} (${reviewer.style}): pass recorded as fail — its own acceptance status has an item not met`);
      notes.push(`${reviewer.role} (${reviewer.style}): ${ruled.verdict} ${parsed.critique.slice(0, 160)}`);
      return {
        notes,
        outcome: {
          role: reviewer.role, style: reviewer.style, model,
          verdict: ruled.verdict, critique: ruled.critique, issues: parsed.issues,
          costUsd: res.costUsd, cached: false,
          ...(acceptance.length ? { acceptance } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`${reviewer.role} (${reviewer.style}): unavailable — ${message.slice(0, 160)}`);
      return {
        notes,
        outcome: {
          role: reviewer.role, style: reviewer.style, model, verdict: 'fail', critique: '',
          issues: [], costUsd: 0, cached: false, error: message.slice(0, 500),
        },
      };
    }
  };

  // Promise.all resolves in INPUT order regardless of settle order, so the
  // persisted reviews array — and every verdict row derived from it — stays in
  // the playbook's reviewer order however the fan-out happens to land.
  // reviewOne never rejects, so there is no partial-failure case to unwind.
  const settled = await Promise.all(pb.reviewers.map((reviewer) => reviewOne(reviewer)));
  const reviews = settled.map((s) => s.outcome);
  for (const s of settled) for (const line of s.notes) onNote?.(line);

  // A cancel or a daemon stop that landed mid-fan-out reads as reviewers that
  // answered nothing. They were not lost — the run was stopped — so nothing
  // below may record them as unavailable or the review as incomplete. The
  // run's own deadline is different: the reviewers really did not answer in
  // the time the run had, and that is recorded like any other absence.
  if (halted(opts.signal)) {
    const cause = abortCause(opts.signal);
    onNote?.(`crew review abandoned: the run was ${cause === 'stop' ? 'stopped by a daemon shutdown' : 'canceled'} before every reviewer answered`);
    return null;
  }

  const usable = reviews.filter((r) => !r.error);
  if (!usable.length) {
    const why = reviews.map((r) => r.error).filter(Boolean).join('; ').slice(0, 300);
    const message =
      `crew review unusable: no reviewer in the ${pb.id} chain could be reached (${why}) — keeping the council verdict`;
    onNote?.(message);
    // Degrading silently is the danger: the board would show a reviewed ticket
    // that was never reviewed. A $0 receipt and an error event make the missing
    // review visible in the ledger and on the timeline.
    store.addReceipt({
      taskId: task.id, runId, kind: 'review:unavailable',
      provider: OWNER_PROVIDER, model: reviews[0]?.model ?? 'unknown', local: false, costUsd: 0,
    });
    store.record({ taskId: task.id, runId, type: 'error', stage: 'verify', message: message.slice(0, 4_000) });
    return null;
  }

  // A reviewer that gave no usable answer is a review the chain did not give.
  // Survivors that all PASS are not the chain passing — the renormalising the
  // council refuses (council.ts, the lost-seat split). The chain goes on and
  // records a SPLIT below, held for a person, its critique naming the lost
  // reviewer (the error text itself is in that reviewer's 'unavailable' note and
  // on the returned reviews): returning null here let the council's verdict
  // stand, and a council pass would merge work one reviewer never read. Except
  // over a council FAIL: a split would park for a person work the council sent
  // to repair, so the chain gives no verdict and the FAIL stands. A surviving
  // FAIL, or a blocker raised on a pass, still decides below: failing closed is
  // the safe direction.
  // (Only a chain of two or more reviewers can get here: a one-reviewer chain
  // whose reviewer answered is complete, and one that did not is the branch above.)
  const lostReviewers = reviews.filter((r) => r.error);
  if (lostReviewers.length) {
    const lost = lostReviewers.map((r) => `${r.role} (${r.style})`).join(', ');
    const survivorsPass = usable.every((r) => r.verdict === 'pass') &&
      !usable.some((r) => r.issues.some((i) => i.severity === 'blocker'));
    const councilFailed = survivorsPass && opts.council?.verdict === 'fail';
    const message = councilFailed
      ? `crew review incomplete: ${lost} ${PARTIAL_PASS} — the council's FAIL stands`
      : survivorsPass
      ? `crew review incomplete: ${lost} ${PARTIAL_PASS} — recorded as split, held for a person`
      : `crew review incomplete: ${lost} gave no usable answer — the rest found a reason to fail it, so the chain goes on as a FAIL`;
    onNote?.(message);
    // Degrading silently is the danger here too: a $0 receipt and an error
    // event make the missing review visible in the ledger and on the timeline,
    // and the receipt keeps a partial round out of the crew report's
    // first-review pass rate whichever way it went (queue.ts crewReport).
    store.addReceipt({
      taskId: task.id, runId, kind: 'review:incomplete',
      provider: OWNER_PROVIDER, model: lostReviewers[0]!.model, local: false, costUsd: 0,
    });
    store.record({ taskId: task.id, runId, type: 'error', stage: 'verify', message: message.slice(0, 4_000) });
    if (councilFailed) {
      // The survivors' issues are still the chain's point. File the fresh ones
      // now: a cached review's issues count as filed the round it was paid for,
      // so skipping them here would lose them for good.
      const replayedHere = new Set(usable.filter((r) => r.cached).flatMap((r) => r.issues));
      const freshHere = usable.flatMap((r) => r.issues).slice(0, MAX_ISSUES).filter((i) => !replayedHere.has(i));
      if (!halted(opts.signal)) fileIssues(store, task, pb, freshHere, { branch: opts.branch, runId }, onNote);
      return null;
    }
  }

  let verdict: 'pass' | 'fail' = usable.some((r) => r.verdict === 'fail') ? 'fail' : 'pass';
  const critiques = usable
    .filter((r) => r.critique)
    .map((r) => `${r.role} (${r.style}) says ${r.verdict.toUpperCase()}:\n${r.critique}`);

  // One reviewer's five, not five per reviewer: the filing cap is per verdict.
  const raised = usable.flatMap((r) => r.issues);
  const issues = raised.slice(0, MAX_ISSUES);
  // Read from the PRE-slice set: the cap decides what gets FILED, never what
  // gets HEARD, so a flood of normals cannot push a later blocker off the end
  // and out of the verdict.
  const blockers = raised.filter((i) => i.severity === 'blocker');
  if (verdict === 'pass' && blockers.length) {
    // A blocker cannot ride a pass: the reviewer said this cannot ship as-is.
    verdict = 'fail';
    critiques.push(
      `blocking issue(s) raised on an otherwise passing review:\n- ${blockers.map((i) => `${i.title}: ${i.prompt}`).join('\n- ')}`,
    );
    onNote?.(`crew review downgraded to fail: ${blockers.length} blocker-severity issue(s) on a pass`);
  }
  // A FAIL that demands a scan for text the code does not contain cannot be
  // met as written. Said here, it reaches the chair's evidence and, through
  // the critique, the next repair round's notes.
  if (verdict === 'fail' && opts.treeDir) {
    const missing = ungroundedLiterals(critiques.join('\n'), opts.treeDir);
    if (missing.length) {
      critiques.push(literalNote(missing));
      onNote?.(`crew review demands ${missing.length} source string(s) found nowhere in the tree`);
    }
  }

  let costUsd = reviews.reduce((n, r) => n + r.costUsd, 0);
  const councilVerdict = opts.council?.verdict;
  const disagreement = (councilVerdict === 'pass' || councilVerdict === 'fail') && councilVerdict !== verdict;
  // The streak is the escalation counter: this round's fail plus the unbroken
  // run of crew fails before it. A round that passed breaks the streak, so it
  // never escalates on the strength of rounds it has already superseded.
  const failures = verdict === 'fail' ? store.crewFailureStreak(task.id) + 1 : 0;
  const afterFailures = Math.max(1, pb.escalation.afterFailures);

  let chair: CrewVerdict['chair'] = null;
  // Only ever a chair's actual rationale. `chair_summary` is read back as a
  // training rationale by the align dataset, so an error string written here
  // would be learned from as if a chair had said it.
  let chairSummary: string | null = null;
  if (disagreement || failures >= afterFailures) {
    const reason = disagreement
      ? `the crew says ${verdict} and the local council said ${councilVerdict}`
      : `${failures} consecutive crew review failure(s) (escalation.afterFailures = ${afterFailures})`;
    const chairRole = pb.escalation.chair;
    const chairModel = tierModel(pb.roles[chairRole]?.tier ?? 'owner');
    const prompt = buildChairPrompt({
      crew: pb.id,
      reason,
      councilVerdict,
      councilCritique: opts.council?.critique ?? null,
      verdict,
      critiques,
      task,
      acceptance,
      change: summarizeDiff(opts.diff),
    });
    try {
      const res = await ownerCall(prompt, {
        signal: opts.signal,
        model: chairModel,
        maxTurns: 1,
        timeoutMs: chairShareMs,
        store,
        kind: 'review:chair',
        taskId: task.id,
      });
      costUsd += res.costUsd;
      const parsed = parseChair(res.text);
      if (parsed) {
        chair = { role: chairRole, model: chairModel, verdict: parsed.verdict, rationale: parsed.rationale };
        chairSummary = parsed.rationale || `chair ruled ${parsed.verdict}`;
        onNote?.(`chair ${chairRole} (${chairModel}): ${parsed.verdict} — ${parsed.rationale.slice(0, 200)}`);
        if (parsed.verdict !== verdict) {
          critiques.push(`chair ${chairRole} overruled the chain (${verdict} → ${parsed.verdict}): ${parsed.rationale}`);
        }
        verdict = parsed.verdict;
      } else {
        // No ruling is not a ruling: the chain's own verdict stands, and the
        // failure stays in the log rather than posing as a chair rationale.
        onNote?.(`chair reply unusable, chain verdict stands: ${res.text.slice(0, 200)}`);
      }
    } catch (err) {
      onNote?.(`chair unavailable, chain verdict stands: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  // A canceled task must not gain a verdict row: the run is over, nobody will
  // act on it, and the streak it would join outlives the cancellation. A run
  // that reached its own deadline is not over: the chain's verdict — a FAIL
  // that a chair never got to rule on, say — is still the review it gave.
  if (halted(opts.signal)) {
    onNote?.('crew review abandoned: the run was stopped (canceled or shutting down) before the verdict was written');
    return null;
  }

  // On a FAIL, a blocker is exactly what the repair round is about to fix:
  // filing it as a child ticket as well duplicates that work, and once the
  // repair lands the child finds nothing to do and fails for delivering
  // nothing (first Kiln epic: t0's missing helper tests were both repaired in
  // place and filed as t_5d3566ede7, which then failed). So blockers on a fail
  // go into the critique — which becomes the repair notes — and only
  // normal-severity follow-ups are filed.
  const replayed = new Set(usable.filter((r) => r.cached).flatMap((r) => r.issues));
  const repairedInPlace = verdict === 'fail' ? issues.filter((i) => i.severity === 'blocker') : [];
  if (repairedInPlace.length) {
    critiques.push(
      'BLOCKERS TO FIX IN THIS REPAIR (not filed as separate tickets):\n' +
        repairedInPlace.map((i) => `- ${i.title}: ${i.prompt}`).join('\n'),
    );
    onNote?.(`${repairedInPlace.length} blocker issue(s) kept for this ticket's repair round instead of filed`);
  }

  // A pass the chain may not give. An item a reviewer could not verify — it was not shown the source, part of the
  // report was cut — or gave no status for is not a defect of the work, so no repair round is spent on it: the
  // worker cannot fix what the reviewer could not see. It is not a pass either. Recorded as a split, which parks
  // for a person; decided after the chair on purpose, since a chair sees no more of the source than they did.
  const held = heldItems({ council: usable.map(asOpinion) });
  // The same for an item a reviewer called partial or missing. Its own pass was already recorded as a FAIL
  // (enforceAcceptance); the verdict can only be a pass again here because a chair overruled that — on the default
  // path at once, whenever the local council had passed the work. A chair saw less of the source than the reviewer
  // whose list says the item is not met, so its pass is not a pass either: a person decides.
  const owed = verdict === 'pass' ? owedItems({ council: usable.map(asOpinion) }) : [];
  const recorded: CouncilVerdict = verdict === 'pass' && (held.length || owed.length || lostReviewers.length) ? 'split' : verdict;
  if (owed.length) {
    critiques.push(
      `FOREMAN CHECK (deterministic): a chair passed this work, but the reviewer's own acceptance status has ` +
        `${owed.map((e) => `item ${e.item} ${e.status}`).join(', ')}. A pass cannot carry an item that is not met: held for a person.\n` +
        itemList(owed),
    );
    onNote?.(`crew review held for a person: a chair passed work whose reviewer lists acceptance item(s) ${owed.map((e) => e.item).join(', ')} as not met`);
  }
  if (lostReviewers.length && recorded === 'split') {
    critiques.push(
      `FOREMAN CHECK (deterministic): ${lostReviewers.map((r) => `${r.role} (${r.style})`).join(', ')} gave no usable answer. ` +
        'A review the chain did not give is not a pass: held for a person.',
    );
  }
  if (held.length && recorded === 'split') {
    critiques.push(
      `FOREMAN CHECK (deterministic): the review found nothing to fail, but could not verify acceptance item${held.length > 1 ? 's' : ''} ` +
        `${held.map((e) => e.item).join(', ')} from what it was shown. That is not a pass and not the worker's to repair: held for a person.\n` +
        itemList(held),
    );
    onNote?.(`crew review held for a person: acceptance item(s) ${held.map((e) => e.item).join(', ')} could not be verified`);
  }

  // Too deep in the epic to file follow-ups: the issues are dropped below
  // (recorded whole) and the park note puts them on the gate item. Replayed
  // (cached) issues too — a same-diff retry must not reach the gate clean.
  const tooDeep = epicDepth(store, task.id) >= MAX_EPIC_DEPTH;

  const critique = critiques.join('\n\n').slice(0, 8_000) || null;
  const record = store.addVerdict({
    runId,
    taskId: task.id,
    verdict: recorded,
    disagreement,
    council: usable.map(asOpinion),
    chairSummary,
    chairModel: chair?.model ?? null,
    source: 'crew',
    critique,
    costUsd,
  });

  // Issues are filed on a pass as well as a fail: a follow-up ticket is the
  // point of the chain, not a consolation prize for rejected work. But never
  // from a cached outcome — those issues were filed the round they were first
  // paid for, and a replay on every repair/retry round would file them again.
  // At depth nothing is filed, so a replayed issue left over is dropped
  // (recorded) like a fresh one rather than vanishing.
  const fresh = issues.filter((i) => (tooDeep || !replayed.has(i)) && !repairedInPlace.includes(i));
  // Cancellation between the verdict and the filing still spawns work nobody
  // asked for; the verdict row above is the last state a canceled run writes.
  const filed = halted(opts.signal) ? [] : fileIssues(store, task, pb, fresh, { branch: opts.branch, runId }, onNote);

  return { verdict: recorded, critique: critique ?? '', reviews, issues, filed, chair, costUsd, record };
}
