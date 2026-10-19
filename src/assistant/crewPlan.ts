import fs from 'node:fs';
import path from 'node:path';
import { repoBrief } from './repoBrief.ts';
import { claudeSpecs, extractJson } from '../models.ts';
import { getPlaybook, loadPlaybooks, type Playbook } from '../playbooks.ts';
import type { Store } from '../queue.ts';
import { scanCommand } from '../security/admit.ts';
import { MAX_SKILLS_PER_TICKET, checkTicketSkills, loadSkills, ticketSkillRefusal } from '../skills.ts';
import type { Sensitivity, Task, TaskKind } from '../types.ts';
import { detectTestCmd } from '../verify/tests.ts';
import { ownerCall } from './ownerCall.ts';
import {
  PLAN_NOTES_MAX, askItemCount, boundPlanNote, lintPlan, planNoteBlock, type PlanFinding, type PlanReview,
} from './planCheck.ts';
import { topoSort } from './plan.ts';
import { precedentsFor, type Precedent } from './retro.ts';

export interface CrewTicket {
  /** Plan-local id (`t1`), resolved to real task ids at queue time. */
  ref: string;
  title: string;
  prompt: string;
  /** A role defined by the playbook; anything else is remapped at parse time. */
  role: string;
  kind: TaskKind;
  after: string[];
  acceptance: string | null;
  testCmd: string | null;
  points: number | null;
  /** Paths the ticket may not touch (see scope.ts); absent or null when none. */
  forbiddenPaths?: string[] | null;
  /** Skills named for this ticket in place of its role's default (skills.ts); absent or null when none. */
  skills?: string[] | null;
  /**
   * Notes from the senior's review of the plan that name this ticket (planCheck.ts attachReviewNotes). Queued, they
   * are the tail of the ticket's prompt, where its worker and its reviewers read them. Absent when none.
   */
  reviewNotes?: string[] | null;
}

export interface CrewPlan {
  ask: string;
  playbook: string;
  epic: { title: string; summary: string };
  tickets: CrewTicket[];
  repo: string | null;
  /** True when the Owner was unreachable/unusable and this is the fallback. */
  degraded: boolean;
  notes: string;
  costUsd: number;
  /** Retrospective keys fed to the Owner as precedent, for the receipt trail. */
  precedents: string[];
  /** Layer-A lint findings (see planCheck.ts) — always populated, empty for --from-epic clones. */
  findings: PlanFinding[];
  /** The latest senior review of this plan, with where each note went; absent when it was not reviewed. */
  review?: PlanReview | null;
}

export interface Classification {
  playbook: Playbook;
  confidence: 'high' | 'low';
}

/**
 * The model that consults on an ambiguous classification. `FOREMAN_MODEL_ROUTER`
 * overrides; read lazily like every other model knob.
 */
export function routerModel(): string {
  // The consult goes to the claude CLI, so only a Claude alias can serve it;
  // anything else (a local alias) would fail into the keyword guess silently.
  const wanted = process.env['FOREMAN_MODEL_ROUTER'] || 'haiku';
  const spec = claudeSpecs().find((c) => c.alias === wanted || c.model === wanted);
  return spec ? spec.model : claudeSpecs().find((c) => c.alias === 'haiku')!.model;
}

/** Crew tickets are work, never tool builds — the forge has its own path. */
const KINDS: TaskKind[] = ['code', 'writing', 'research', 'general'];
const MAX_TICKETS = 12;

/**
 * The cap for a plan an operator hands in over the wire (edited or written by
 * hand). Higher than the owner's: a person splitting the owner's tickets is
 * the reason it exists.
 */
export function maxWirePlanTickets(): number {
  const n = Number(process.env['FOREMAN_MAX_PLAN_TICKETS']);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 30;
}

/**
 * Tickets past the cap used to be dropped in silence — with every dependency
 * edge pointing at them — so an operator's 16-ticket plan for Kiln Easy would
 * have queued as 12, losing the wiring, both UI tickets and the installer, and
 * the epic would have closed "complete" without them. Over the cap is now a
 * blocking finding that names what would be lost.
 */
function capFinding(raw: unknown[], cap: number): PlanFinding | null {
  if (raw.length <= cap) return null;
  const refs = raw.slice(cap).map((e, i) => {
    const ref = e && typeof e === 'object' ? String((e as Record<string, unknown>)['ref'] ?? '') : '';
    return ref || `#${cap + i + 1}`;
  });
  return {
    level: 'error',
    code: 'too-many-tickets',
    message: `${raw.length} tickets, the limit is ${cap}: ${refs.join(', ')} would be dropped — split the epic` +
      ' (or raise FOREMAN_MAX_PLAN_TICKETS for a hand-written plan)',
  };
}
/** An epic queued under a ticket this deep would spawn work nobody is watching. */
export const MAX_EPIC_DEPTH = 3;

/** Ancestor count of a task, itself included; 0 for "no parent context". */
export function epicDepth(store: Store, taskId: string | null | undefined): number {
  let depth = 0;
  let cursor = taskId ?? null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor) && depth <= MAX_EPIC_DEPTH + 1) {
    seen.add(cursor);
    const task = store.getTask(cursor);
    if (!task) break;
    depth++;
    cursor = task.parentId;
  }
  return depth;
}

function assertDepth(store: Store, parentId: string | null | undefined): void {
  const depth = epicDepth(store, parentId);
  if (depth >= MAX_EPIC_DEPTH) {
    throw new Error(
      `refusing to build an epic under ${parentId}: it is already ${depth} parents deep (max ${MAX_EPIC_DEPTH})`,
    );
  }
}

/**
 * Crew planning is an Owner call, and the Owner is the hosted `claude` CLI: the
 * ask itself — plus the precedent retrospectives of past epics — leaves the
 * machine. That is exactly what S2 promises will not happen, so S2 is refused
 * here, before a token is spent, rather than silently rerouted to a local model
 * (a different, weaker planner producing a plan the operator did not ask for)
 * or discovered later when every ticket fails admission on the same grounds.
 */
export function assertPlannable(sensitivity: Sensitivity | undefined): void {
  if (sensitivity === 'S2') {
    throw new Error(
      'S2 asks cannot use crew planning: decomposition runs through the hosted claude CLI, ' +
        'which would send the ask (and past retrospectives) off this machine. ' +
        'Queue the work directly with `foreman add --sensitivity S2` and a local runner instead.',
    );
  }
}

/** The role a degraded plan falls back to: the playbook's first worker-tier role. */
export function firstWorkerRole(pb: Playbook): string {
  const worker = Object.entries(pb.roles).find(([, def]) => def.tier === 'worker');
  return worker?.[0] ?? Object.keys(pb.roles)[0] ?? 'worker';
}

const wordHits = (ask: string, term: string): number => {
  const clean = term.trim().toLowerCase();
  if (!clean) return 0;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(ask) ? 1 : 0;
};

/** Free, offline trigger scoring. Nothing here costs a token. */
function scorePlaybooks(ask: string, playbooks: Playbook[]): Array<{ pb: Playbook; score: number }> {
  return playbooks
    .map((pb) => ({
      pb,
      // Naming the playbook outright outweighs any single trigger word.
      score: pb.triggers.reduce((n, t) => n + wordHits(ask, t), 0) + wordHits(ask, pb.id) * 2,
    }))
    .sort((a, b) => b.score - a.score || a.pb.id.localeCompare(b.pb.id));
}

const CLASSIFY_SYSTEM = `You route a request to the crew that should run it.
Reply with JSON only: {"playbook":"<id from the list>","confidence":"high|low"}
Pick the single best fit. Use "low" when nothing on the list really fits.`;

/**
 * Two-stage classification, cheap stage first: keyword scoring settles the
 * clear cases for free, and the Owner is consulted only when the trigger words
 * genuinely do not separate the candidates. Unreachable Owner degrades to the
 * best keyword guess; nothing matching at all returns null (the caller decides
 * whether that means "ask the human" or "forge a playbook").
 */
export async function classifyAsk(
  ask: string,
  playbooks: Playbook[],
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Refused up front when S2: routing may consult the hosted Owner. */
    sensitivity?: Sensitivity;
    /** Store to bill the classify call to, when one happens. */
    store?: Store;
    taskId?: string | null;
  } = {},
): Promise<Classification | null> {
  // Before the keyword stage, not after: an S2 ask must not reach a code path
  // whose fallback is an Owner call at all.
  assertPlannable(opts.sensitivity);
  if (!playbooks.length) return null;
  const scored = scorePlaybooks(ask, playbooks);
  const top = scored[0]!;
  const runnerUp = scored[1]?.score ?? 0;

  // A clear single winner: either the only playbook that matched at all, or one
  // that matched by a real margin.
  if (top.score > 0 && (runnerUp === 0 || top.score - runnerUp >= 2)) {
    return { playbook: top.pb, confidence: 'high' };
  }
  if (playbooks.length === 1) return { playbook: top.pb, confidence: top.score > 0 ? 'high' : 'low' };

  // static-first for prompt-cache hits: the routing contract and the installed
  // catalog are the same on every ask; only the request itself varies.
  const prompt =
    `${CLASSIFY_SYSTEM}\n\nPLAYBOOKS:\n` +
    playbooks.map((pb) => `- ${pb.id}: ${pb.description} (triggers: ${pb.triggers.join(', ')})`).join('\n') +
    `\n\nREQUEST: ${ask}`;
  try {
    const { text } = await ownerCall(prompt, {
      // Picking one of a handful of playbooks is a one-word decision; it does
      // not need the owner tier's most expensive model, and paying for it on
      // every ambiguous ask is spend nobody gets value from.
      model: routerModel(),
      signal: opts.signal,
      maxTurns: 1,
      timeoutMs: opts.timeoutMs,
      // Its own receipt rather than folded into the plan's: routing spend that
      // is invisible is routing spend nobody tunes away.
      store: opts.store,
      kind: 'plan:classify',
      taskId: opts.taskId ?? null,
    });
    const parsed = extractJson<{ playbook?: unknown; confidence?: unknown }>(text);
    const picked = playbooks.find((pb) => pb.id === String(parsed?.playbook ?? ''));
    if (picked) {
      return { playbook: picked, confidence: parsed?.confidence === 'high' ? 'high' : 'low' };
    }
  } catch {
    /* fall through to the keyword guess */
  }
  return top.score > 0 ? { playbook: top.pb, confidence: 'low' } : null;
}

/**
 * How long one planning call may take. Not ownerCall's 180s default: with a
 * repo snapshot in the prompt the owner writes a self-contained brief per
 * ticket, and the first Kiln epic measured 87s without the snapshot and over
 * 180s with it — a timeout there silently degrades a ten-ticket plan to one.
 */
export function planTimeoutMs(): number {
  const n = Number(process.env['FOREMAN_PLAN_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 480_000;
}

export interface CrewPlanOptions {
  ask: string;
  store: Store;
  repo?: string | null;
  /** Skip classification and use this playbook id. */
  playbook?: string | null;
  /** Ticket context this epic is being built from; depth-guarded. */
  parentId?: string | null;
  /** The sensitivity the epic will be queued at. S2 is refused (see assertPlannable). */
  sensitivity?: Sensitivity;
  signal?: AbortSignal;
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * One revision round: the plan this ask produced last time and the senior
   * critic's notes on it. The owner returns a whole corrected plan.
   */
  revise?: { previous: CrewPlan; notes: string[] } | null;
}

/** The previous plan and the critic's notes, as the trailing half of a revision prompt. */
function revisionBrief(revise: { previous: CrewPlan; notes: string[] }): string {
  const tickets = revise.previous.tickets.map((t) => ({
    ref: t.ref, title: t.title, role: t.role, after: t.after,
    acceptance: t.acceptance, points: t.points, prompt: t.prompt.slice(0, 800),
    ...(t.skills?.length ? { skills: t.skills } : {}),
  }));
  return (
    '\nREVISION — a senior lead reviewed your previous plan for this request and found the problems below. ' +
    'Return a complete corrected plan under the same JSON contract. Resolve every note; where one does not ' +
    'apply, say why in epic.summary rather than ignoring it.\n' +
    `NOTES:\n${revise.notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n` +
    `PREVIOUS PLAN:\n${JSON.stringify(tickets)}\n`
  );
}

/** The planning contract; `cap` is the ticket limit the planner is told. */
export const decomposeContract = (cap: number): string => `Reply with JSON only, no prose:
{"epic":{"title":"short epic title","summary":"one sentence on the approach"},
 "tickets":[{"ref":"t1","title":"short imperative title","prompt":"self-contained brief for the worker",
   "role":"<one of the roles above>","kind":"code|writing|research|general","after":["t0"],
   "acceptance":"what the reviewer checks","testCmd":"the command that proves it, or null","points":2}]}
Rules:
- At most ${cap} tickets, as few as the ask honestly needs. "after" lists the refs a ticket waits on.
- "prompt" is read by a worker with no other context: restate everything it needs. Do NOT repeat the
  role's own standing instructions or the playbook's constraints — the worker already has both.
- Assign every ticket a role from the list above, matching the pipeline stage it belongs to.
- Work that can run in parallel must NOT be chained with "after".
- When a REPO SNAPSHOT follows, plan against it: what it shows already exists needs no ticket.
- Workers can read the repo. When a spec or doc in it covers a ticket, CITE it ("SPEC.md §3, the
  search route") instead of restating it, and keep every "prompt" under 1,500 characters — a plan
  too long to finish is cut off mid-ticket.
- Workers are headless: no browser, app window or eyes. A check only a person can run (live in a
  browser or app, visual) goes in "acceptance" prefixed "(operator)" — the operator runs it at the
  gate; reviewers will not fail the worker over it.
- In a repo with a test command, a ticket whose deliverable is a file in the repo (README, docs/, an ADR,
  help text) is kind "code" whatever its prose content: only a code ticket merges on approval and runs the suite.`;

export const DECOMPOSE_CONTRACT = decomposeContract(MAX_TICKETS);

function playbookBrief(pb: Playbook): string {
  const roles = Object.entries(pb.roles).map(([name, def]) => `${name} (${def.tier} tier)`).join(', ');
  const reviewers = pb.reviewers.map((r) => `${r.role} (${r.style})`).join(' → ') || '(none)';
  return (
    `You are the OWNER of a "${pb.id}" crew: ${pb.description}\n` +
    `PIPELINE:\n${pb.pipeline || '(none defined)'}\n\n` +
    `ROLES: ${roles}\nREVIEW CHAIN: ${reviewers}\n`
  );
}

/** The most the skills section may add to a planning prompt, in bytes. */
export const PLAN_SKILLS_MAX_BYTES = 2_048;

const PLAN_SKILLS_HEAD =
  'TICKET SKILLS: a role\'s default skills (procedures in the worker\'s brief) apply unless a ticket names others. ' +
  'Add "skills":["name"] to a ticket ONLY when its nature differs from its role\'s default (e.g. a bug with an ' +
  `unknown cause; a docs deliverable): at most ${MAX_SKILLS_PER_TICKET}, from its own role's list below; they REPLACE the default. Otherwise omit the field.`;

/**
 * What the planner is told about skills: per role that has a choice to make,
 * the default it carries and what it may be given instead, then one `when`
 * line per skill named. '' with the feature off, and '' when no role of this
 * playbook has anything to choose, so those prompts are what they were.
 *
 * A skill the playbook names only on a reviewer entry for a role, and that is
 * not in that role's ticket default, is not offered for that role's tickets:
 * it is a reviewer's procedure. This filters the menu only; checkTicketSkills
 * still accepts it on a ticket an operator names it on, because loadouts.json
 * decides what a role may carry.
 *
 * Static per playbook, so it sits in the cache-stable prefix. Held under
 * PLAN_SKILLS_MAX_BYTES whatever the catalogue holds, and a `when` line is
 * never cut: the defaults' lines go first (detail only), then whole entries
 * from the end with one "N more not shown" line, then role lines from the end
 * of the playbook's role order. The last two lose what the planner chooses by,
 * so `lost` says what went and the plan check shows it.
 */
export function planSkillsSection(pb: Playbook): { text: string; lost: string | null } {
  const none = { text: '', lost: null };
  const catalog = loadSkills();
  if (!catalog.dir) return none;
  const serves = (key: string, name: string): boolean => catalog.skills.some((s) => s.name === name && s.roles.includes(key));
  const roles: Array<{ role: string; usual: string[]; extra: string[] }> = [];
  for (const role of Object.keys(pb.roles)) {
    const key = `${pb.id}.${role}`;
    if (!Object.prototype.hasOwnProperty.call(catalog.loadouts, key)) continue;
    const loadout = catalog.loadouts[key]!;
    const usual = (pb.skills?.[role]?.length ? pb.skills[role]! : loadout.default)
      .filter((n) => (loadout.default.includes(n) || loadout.allowed.includes(n)) && serves(key, n))
      .slice(0, MAX_SKILLS_PER_TICKET);
    const reviewerOnly = pb.reviewers.filter((r) => r.role === role).flatMap((r) => r.skills ?? [])
      .filter((n) => !loadout.default.includes(n) && !(pb.skills?.[role] ?? []).includes(n));
    const extra = [...new Set([...loadout.default, ...loadout.allowed])]
      .filter((n) => !usual.includes(n) && serves(key, n) && !reviewerOnly.includes(n));
    // Nothing to choose: the role carries its default whatever a ticket says.
    if (extra.length) roles.push({ role, usual, extra });
  }
  if (!roles.length) return none;
  const roleLine = (r: (typeof roles)[number]): string =>
    `- ${r.role}: default ${r.usual.join(', ') || '(none)'}; may carry instead ${r.extra.join(', ')}`;
  /** One whole `when` entry per skill named in the roles shown (the defaults' too when asked). */
  const entries = (withUsual: boolean): string[] =>
    [...new Set(roles.flatMap((r) => (withUsual ? [...r.usual, ...r.extra] : r.extra)))].flatMap((name) => {
      const when = (catalog.skills.find((s) => s.name === name)?.when ?? '').replace(/\s+/g, ' ').trim();
      return when ? [`- ${name}: ${when}`] : [];
    });
  const render = (whens: string[], total: number, roleCount = roles.length): string => {
    const shownRoles = roles.slice(0, roleCount);
    return [
      PLAN_SKILLS_HEAD,
      ...shownRoles.map(roleLine),
      ...(roleCount < roles.length ? [`(${roles.length - roleCount} more role(s) not listed: their default applies)`] : []),
      ...(whens.length ? ['USE A SKILL WHEN:', ...whens] : []),
      ...(whens.length < total ? [`(${total - whens.length} more not shown)`] : []),
    ].join('\n') + '\n';
  };
  const fits = (text: string): boolean => Buffer.byteLength(text) <= PLAN_SKILLS_MAX_BYTES;
  const everything = entries(true);
  const full = render(everything, everything.length);
  if (fits(full)) return { text: full, lost: null };
  // The defaults' lines go first: the worker's brief already carries those procedures.
  const extras = entries(false);
  const over = `the skills section of the planning prompt did not fit in ${PLAN_SKILLS_MAX_BYTES} bytes`;
  for (let n = extras.length; n > 0; n--) {
    const text = render(extras.slice(0, n), extras.length);
    if (!fits(text)) continue;
    return { text, lost: n === extras.length ? null : `${over}: ${extras.length - n} \`when\` line(s) were left out, so the planner chose those skills by name alone` };
  }
  const blind = 'every `when` line was left out, so the planner chose skills by name alone';
  for (let n = roles.length; n > 0; n--) {
    const text = render([], extras.length, n);
    if (!fits(text)) continue;
    // With no other skill's `when` line to leave out, only the defaults' went: detail, nothing lost.
    if (n === roles.length) return { text, lost: extras.length ? `${over}: ${blind}` : null };
    const unlisted = roles.slice(n).map((r) => r.role).join(', ');
    return { text, lost: `${over}: ${blind}, and was not told what ${unlisted} may carry (their tickets get the role default)` };
  }
  return { text: '', lost: `${over} at all: the planner was told nothing about skills, and every ticket gets its role default` };
}

/** The text of planSkillsSection: what goes into the planning prompt. */
export function planSkillsBrief(pb: Playbook): string {
  return planSkillsSection(pb).text;
}

function precedentBrief(precedents: Precedent[]): string {
  if (!precedents.length) return '';
  return (
    `\nPRECEDENT — past epics of this crew and how they actually went. Reuse what worked:\n` +
    precedents
      .map((p) => JSON.stringify({
        ask: p.retro.ask,
        tickets: p.retro.tickets.map((t) => ({ title: t.title, role: t.role, points: t.points })),
        reviewRounds: p.retro.reviewRounds,
        checksThatCaught: p.retro.checksThatCaught,
        pitfalls: p.retro.pitfalls,
      }))
      .join('\n') +
    '\n'
  );
}

/** The single-ticket plan used when the Owner is unreachable or unusable. */
function fallback(opts: CrewPlanOptions, pb: Playbook, reason: string, costUsd = 0): CrewPlan {
  const title = opts.ask.length > 70 ? `${opts.ask.slice(0, 67)}…` : opts.ask;
  const tickets: CrewTicket[] = [{
    ref: 't1',
    title,
    prompt: opts.ask,
    role: firstWorkerRole(pb),
    kind: opts.repo ? 'code' : 'general',
    after: [],
    acceptance: null,
    testCmd: null,
    points: null,
  }];
  const plan: CrewPlan = {
    ask: opts.ask,
    playbook: pb.id,
    epic: { title, summary: reason },
    tickets,
    repo: opts.repo ?? null,
    degraded: true,
    notes: reason,
    costUsd,
    precedents: [],
    findings: [],
  };
  plan.findings = lintPlan(plan, pb);
  return plan;
}

/** What the plan shows where a ticket's kind was corrected (see gatedRepoKind). */
export const KIND_CORRECTED = 'deliverable is a file in a gated repo';

const ROOT_DOCS = /\b(?:README|CHANGELOG|CONTRIBUTING|SECURITY|ARCHITECTURE)(?:\.[A-Za-z]+)?\b/g;
const PATH_TOKENS = /(?<![\w$~./-])(?:\.\/)?[\w@-][\w.@-]*(?:\/[\w.@-]+)*\/?/g;
const DOC_DIRS = new Set(['docs', 'doc', 'documentation', 'adr']);
const DOC_FILE = /\.(?:md|mdx|rst|adoc|txt)$/i;
/** Deliverables that live in a repo's files by their nature, wherever the ticket says to put them. */
const REPO_PROSE = /\bADR\b|\barchitecture decision record\b|\bhelp text\b|--help\b|\busage (?:text|string|line)\b|\bdocstrings?\b|\bcode comments?\b/i;

/**
 * Does this ticket's text name a file or folder of the repo, or a kind of prose that only exists as one? A path
 * counts when it has a `/` or a file extension and it, or its first folder, exists in the repo (a document or a docs
 * folder also before it exists); a root document (README, CHANGELOG, …) when the repo has one.
 */
function namesRepoFile(ticket: { title: string; prompt: string; acceptance: string | null }, repo: string): boolean {
  const text = `${ticket.title}\n${ticket.prompt}\n${ticket.acceptance ?? ''}`;
  if (REPO_PROSE.test(text)) return true;
  let top: string[];
  try {
    top = fs.readdirSync(repo);
  } catch {
    return false;
  }
  for (const m of text.matchAll(ROOT_DOCS)) {
    const stem = m[0].split('.')[0]!;
    if (top.some((name) => name === stem || name.startsWith(`${stem}.`))) return true;
  }
  for (const m of text.matchAll(PATH_TOKENS)) {
    const token = m[0].replace(/^\.\//, '').replace(/[.]+$/, '');
    if (!token.includes('/') && !/\w\.[A-Za-z]\w*$/.test(token)) continue;
    const first = token.split('/')[0]!;
    if (first === '.' || first === '..' || first === '.git' || first === 'node_modules') continue;
    // A document or a docs folder counts before it exists: writing it is the ticket.
    if (token.includes('/') ? top.includes(first) || DOC_DIRS.has(first) : DOC_FILE.test(token) || fs.existsSync(path.join(repo, token))) return true;
  }
  return false;
}

/**
 * The kind a ticket runs as. In a repo with a suite of its own, a `writing` ticket whose deliverable is a file in
 * that repo is `code`: a writing ticket never merges on approval and its change is not what the suite gates, so on
 * the Kiln trial an approved ADR was silently not landed and a README ticket would have skipped the gate. `gated`
 * is whether the REPO has a test command — not the ticket: a manuscript chapter with a check of its own is still
 * writing, as is anything in a repo-less plan.
 */
function gatedRepoKind(
  ticket: { title: string; prompt: string; acceptance: string | null }, kind: TaskKind, repo: string | null, gated: boolean,
): TaskKind {
  return kind === 'writing' && repo && gated && namesRepoFile(ticket, repo) ? 'code' : kind;
}

/**
 * Coerce raw ticket objects — from the Owner's reply or from an HTTP caller —
 * into `CrewTicket`s, dropping whatever does not survive. Shared so a plan that
 * arrives over the wire is validated by exactly the code that validates a
 * model's reply, and neither can grow a hole the other does not have.
 */
function normalizeTickets(
  raw: unknown[], pb: Playbook | null, defaultKind: TaskKind, cap = MAX_TICKETS,
  /** Filled with one warning per skill name a ticket asked for and may not have, and one note per kind corrected. */
  skillFindings: PlanFinding[] = [],
  /** The plan's repo: where a `writing` ticket's deliverable is looked for (see gatedRepoKind). */
  repo: string | null = null,
): CrewTicket[] {
  const tickets: CrewTicket[] = [];
  const seen = new Set<string>();
  // Not under a playbook whose reviewers do not review code (publishing, research): there a `writing` ticket IS the
  // work — a chapter names a file of its repo, and a manuscript repo with a lint target, a `tests` folder or a
  // package.json would have had every chapter planned as code, merged on approval and judged by the suite.
  const codeCrew = !pb || pb.reviewers.some((r) => r.style === 'code-review');
  const gated = codeCrew && Boolean(repo) && detectTestCmd(repo!) !== null;
  for (const [i, entry] of raw.slice(0, cap).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const title = String(row['title'] ?? '').trim();
    const prompt = String(row['prompt'] ?? '').trim();
    if (!title || !prompt) continue;
    const ref = String(row['ref'] ?? `t${i + 1}`);
    if (seen.has(ref)) continue;
    seen.add(ref);

    const role = String(row['role'] ?? '');
    const points = Number(row['points']);
    let testCmd = typeof row['testCmd'] === 'string' ? row['testCmd'].trim() : '';
    // The testCmd runs in the jail like any other command, and never passed
    // task admission, so screen it the way playbook checks are screened.
    if (testCmd && scanCommand(testCmd)) testCmd = '';

    const forbidden = (Array.isArray(row['forbiddenPaths']) ? (row['forbiddenPaths'] as unknown[]) : [])
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      .map((p) => p.trim());

    // An invented role would resolve to no model tier and no role prompt.
    const resolvedRole = pb ? (pb.roles[role] ? role : firstWorkerRole(pb)) : role;
    // Checked against the role the ticket will actually run as. A name that
    // fails is dropped from this ticket and shown; the plan itself stands.
    const target = { playbook: pb?.id ?? null, role: resolvedRole };
    const skills = checkTicketSkills(target, row['skills']);
    for (const r of skills.refused) {
      skillFindings.push({ level: 'warn', code: 'skill-dropped', ticket: ref, message: ticketSkillRefusal(target, skills, r) });
    }
    // Only a plan that comes back over the wire has these (a preview confirmed from the board); bounded again.
    const reviewNotes = (Array.isArray(row['reviewNotes']) ? (row['reviewNotes'] as unknown[]) : [])
      .filter((n): n is string => typeof n === 'string').map(boundPlanNote).filter(Boolean).slice(0, PLAN_NOTES_MAX);

    const acceptance = typeof row['acceptance'] === 'string' ? row['acceptance'].slice(0, 20_000) : null;
    const planned = KINDS.includes(row['kind'] as TaskKind) ? (row['kind'] as TaskKind) : defaultKind;
    const kind = gatedRepoKind({ title, prompt, acceptance }, planned, repo, gated);
    if (kind !== planned) {
      skillFindings.push({ level: 'note', code: 'kind-corrected', ticket: ref, message: `kind ${planned} → ${kind} (${KIND_CORRECTED})` });
    }

    tickets.push({
      ref,
      title: title.slice(0, 120),
      prompt: prompt.slice(0, 20_000),
      role: resolvedRole,
      kind,
      after: (Array.isArray(row['after']) ? (row['after'] as unknown[]) : []).map(String),
      acceptance,
      testCmd: testCmd || null,
      points: Number.isFinite(points) && points > 0 ? Math.min(21, Math.trunc(points)) : null,
      forbiddenPaths: forbidden.length ? forbidden : null,
      ...(skills.names.length ? { skills: skills.names } : {}),
      ...(reviewNotes.length ? { reviewNotes } : {}),
    });
  }
  // Only keep edges pointing at tickets that survived validation.
  const refs = new Set(tickets.map((t) => t.ref));
  for (const ticket of tickets) {
    ticket.after = [...new Set(ticket.after.filter((a) => refs.has(a) && a !== ticket.ref))];
  }
  return tickets;
}

/** The review a wire plan carries, rebuilt field by field: its notes bounded, its tickets held to the plan's own. */
function parseReview(raw: unknown, tickets: CrewTicket[]): PlanReview | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const refs = new Set(tickets.map((t) => t.ref));
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const notes = (Array.isArray(body['notes']) ? (body['notes'] as unknown[]) : []).slice(0, PLAN_NOTES_MAX).flatMap((n) => {
    if (!n || typeof n !== 'object') return [];
    const row = n as Record<string, unknown>;
    const text = boundPlanNote(String(row['text'] ?? ''));
    return text
      ? [{ text, tickets: strings(row['tickets']).filter((r) => refs.has(r)), unmatched: strings(row['unmatched']).slice(0, PLAN_NOTES_MAX).map((u) => u.slice(0, 40)) }]
      : [];
  });
  return { verdict: body['verdict'] === 'risky' ? 'risky' : 'sound', notes };
}

/**
 * Validate a plan supplied by an HTTP caller instead of produced here. The
 * caller is not trusted to have gone through `crewPlan`, so every field is
 * rebuilt.
 *
 * A plan with zero usable tickets is NOT rejected here with a throw: it is
 * returned with `findings: [{level:'error', code:'empty-plan', ...}]` so the
 * caller goes through the same lint-and-refuse path as every other bad shape
 * (see the `/api/build` handler) instead of a bespoke error message. Nothing
 * downstream treats an empty plan as safe to queue — `queueCrewPlan` still
 * throws on it independently, so a caller that skips the findings check
 * (calling this function directly, say) is still refused.
 */
export function parseCrewPlan(raw: unknown): CrewPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plan must be an object');
  const body = raw as Record<string, unknown>;
  const ask = String(body['ask'] ?? '').trim();
  if (!ask) throw new Error('plan.ask is required');
  const playbookId = String(body['playbook'] ?? '').trim();
  const pb = playbookId ? getPlaybook(playbookId) ?? null : null;
  if (playbookId && !pb) throw new Error(`no playbook '${playbookId}' — run 'foreman playbooks' to see what is loaded`);
  const repo = typeof body['repo'] === 'string' && body['repo'].trim() ? body['repo'] : null;

  const rawTickets = Array.isArray(body['tickets']) ? (body['tickets'] as unknown[]) : [];
  const cap = maxWirePlanTickets();
  const skillFindings: PlanFinding[] = [];
  const tickets = topoSort(normalizeTickets(rawTickets, pb, repo ? 'code' : 'general', cap, skillFindings, repo));

  const epic = (body['epic'] ?? {}) as Record<string, unknown>;
  const title = String(epic['title'] ?? '').trim() || (ask.length > 70 ? `${ask.slice(0, 67)}…` : ask);
  const plan: CrewPlan = {
    ask: ask.slice(0, 20_000),
    playbook: playbookId,
    epic: { title: title.slice(0, 120), summary: String(epic['summary'] ?? '').slice(0, 500) },
    tickets,
    repo,
    degraded: body['degraded'] === true,
    notes: String(body['notes'] ?? '').slice(0, 500),
    // A caller-supplied cost is not evidence of spend; the receipt trail is.
    costUsd: 0,
    precedents: [],
    findings: [],
  };
  plan.findings = [...lintPlan(plan, pb), ...skillFindings];
  const review = parseReview(body['review'], tickets);
  if (review) plan.review = review;
  const overCap = capFinding(rawTickets, cap);
  if (overCap) plan.findings.unshift(overCap);
  return plan;
}

/**
 * One Owner call turns an ask into an epic of role-assigned tickets. Every
 * field of the reply is treated as hostile: a plan is a suggestion the human
 * confirms, so anything unusable degrades to a single ticket rather than
 * throwing. The only hard refusals come before the call: no playbook, too deep,
 * or S2 (which may not be planned by a hosted model at all).
 */
export async function crewPlan(opts: CrewPlanOptions): Promise<CrewPlan> {
  const ask = opts.ask.trim();
  if (!ask) throw new Error('ask cannot be empty');
  // Both refusals happen before spending a token, and before the ask reaches
  // any subprocess at all.
  assertPlannable(opts.sensitivity);
  assertDepth(opts.store, opts.parentId);

  const catalog = loadPlaybooks().playbooks;
  let pb: Playbook | null = null;
  if (opts.playbook) {
    pb = catalog.find((p) => p.id === opts.playbook) ?? null;
    if (!pb) throw new Error(`no playbook '${opts.playbook}' — run 'foreman playbooks' to see what is loaded`);
  } else {
    pb = (await classifyAsk(ask, catalog, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      sensitivity: opts.sensitivity,
      store: opts.store,
      taskId: opts.parentId ?? null,
    }))?.playbook ?? null;
    if (!pb) {
      // Nothing scored, so no installed crew fits. Suggest the forge; do NOT
      // run it — a forge is an Owner call, and spending owner tokens the human
      // did not ask for is exactly what the token economy forbids.
      const forge = `or forge one: foreman playbook forge "<domain>"`;
      throw new Error(
        catalog.length
          ? `no playbook matches this ask — pass --playbook <id> (loaded: ${catalog.map((p) => p.id).join(', ')}), ${forge}`
          : `no playbooks loaded — run 'foreman crew init', ${forge}`,
      );
    }
  }

  // An ask that numbers more items than the default cap gets a cap to fit
  // them, so the planner is not forced to drop the tail in silence.
  const items = askItemCount(ask);
  const cap = items > MAX_TICKETS ? Math.min(items, maxWirePlanTickets()) : MAX_TICKETS;

  const precedents = precedentsFor(opts.store, pb.id, ask, 2);
  const skillsSection = planSkillsSection(pb);
  const prompt =
    // static-first for prompt-cache hits: the playbook brief and the decompose
    // contract are byte-stable across every epic of this playbook; the
    // precedents and the ask trail.
    `${playbookBrief(pb)}\n${decomposeContract(cap)}\n${skillsSection.text}` +
    precedentBrief(precedents) +
    `\nREQUEST: ${ask}\n` +
    (cap > MAX_TICKETS
      ? `ASK ITEMS: the request lists ${items} numbered items. This overrides the ${MAX_TICKETS}-ticket limit: ` +
        `at most ${cap} tickets, and every numbered item must be covered by a ticket.\n`
      : '') +
    (opts.repo ? `TARGET REPO: ${opts.repo}\n` : '') +
    (opts.revise?.notes.length ? revisionBrief(opts.revise) : '') +
    // Last: it is the largest and least cache-stable part of the prompt.
    (opts.repo ? `\n${repoBrief(opts.repo, ask)}` : '');

  let text: string;
  let costUsd = 0;
  try {
    const res = await ownerCall(prompt, {
      signal: opts.signal,
      maxTurns: opts.maxTurns ?? 5,
      timeoutMs: opts.timeoutMs ?? planTimeoutMs(),
      // Billed to the parent ticket when there is one, so an epic built from
      // inside a run carries its own planning cost.
      store: opts.store,
      kind: 'plan',
      taskId: opts.parentId ?? null,
    });
    text = res.text;
    costUsd = res.costUsd;
  } catch (err) {
    return fallback(opts, pb, `owner unavailable (${(err as Error).message.slice(0, 160)}); queued as one ticket`);
  }

  const parsed = extractJson<{ epic?: unknown; tickets?: unknown }>(text);
  const rawTickets = Array.isArray(parsed?.tickets) ? (parsed!.tickets as unknown[]) : [];
  if (!rawTickets.length) return fallback(opts, pb, 'owner did not return a usable epic; queued as one ticket', costUsd);

  const skillFindings: PlanFinding[] = [];
  const tickets = normalizeTickets(rawTickets, pb, opts.repo ? 'code' : 'general', cap, skillFindings, opts.repo ?? null);
  if (!tickets.length) return fallback(opts, pb, 'owner returned no usable tickets; queued as one ticket', costUsd);

  const epic = (parsed?.epic ?? {}) as Record<string, unknown>;
  const epicTitle = String(epic['title'] ?? '').trim() || (ask.length > 70 ? `${ask.slice(0, 67)}…` : ask);
  const plan: CrewPlan = {
    ask,
    playbook: pb.id,
    epic: { title: epicTitle.slice(0, 120), summary: String(epic['summary'] ?? '').slice(0, 500) },
    tickets: topoSort(tickets),
    repo: opts.repo ?? null,
    degraded: false,
    notes: String(epic['summary'] ?? '').slice(0, 500),
    costUsd,
    precedents: precedents.map((p) => p.epicId),
    findings: [],
  };
  plan.findings = [...lintPlan(plan, pb), ...skillFindings];
  if (skillsSection.lost) plan.findings.push({ level: 'warn', code: 'skills-prompt-trimmed', message: skillsSection.lost });
  const ownerOverCap = capFinding(rawTickets, cap);
  if (ownerOverCap) plan.findings.unshift(ownerOverCap);
  // extractJson repairs a reply that was cut off mid-object, which keeps a
  // usable plan from a trailing glitch — and also turns an owner reply that
  // ran out of output into a plan missing every ticket after the cut, presented
  // as complete. (Kiln Desktop: ~22k output tokens, six tickets for a spec
  // that needed a dozen, the last with no acceptance.) A plan that only parses
  // after repair must not be queued without a human reading it.
  if (!parsesWithoutRepair(text)) {
    plan.findings.unshift({
      level: 'error',
      code: 'truncated-plan',
      message: 'the owner reply was cut off and only parsed after repair — tickets after the cut are missing; re-plan, or narrow the ask',
    });
  }
  return plan;
}

/** extractJson's strict shapes only: a fenced block or the outermost braces, parsed as-is. */
function parsesWithoutRepair(text: string): boolean {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    const braced = trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
    for (const slice of [trimmed, braced]) {
      if (!slice) continue;
      try {
        JSON.parse(slice);
        return true;
      } catch {
        /* next shape */
      }
    }
  }
  return false;
}

/** Where a review note went, in the words the plan is printed with. */
export function planNoteHome(note: { tickets: string[]; unmatched: string[] }): string {
  if (note.tickets.length) return `in the brief of ${note.tickets.join(', ')}`;
  return note.unmatched.length
    ? `NOT MATCHED to a ticket (it names ${note.unmatched.join(', ')}, which the plan does not have): on the epic only`
    : 'on the epic only (it names no ticket)';
}

export interface QueuedEpic {
  epic: Task;
  tickets: Task[];
}

export interface QueueCrewOptions {
  sensitivity?: Sensitivity;
  budgetUsd?: number | null;
  priority?: number;
  runner?: Task['runner'];
  /** Parent ticket this epic hangs off, when one asked for it. */
  parentId?: string | null;
  /**
   * Gate opt-in for the whole epic (`foreman build --gate owner`). It rides on
   * every ticket, not on the container: the container never parks at a gate.
   */
  gate?: Task['gate'];
}

/**
 * Materialize a confirmed plan: one epic container plus its tickets.
 *
 * Epic-container mechanics (the decision): the epic is a real task row carrying
 * `isEpic`, born `blocked` and never claimable. `blocked` is the only
 * non-terminal status that neither consumes a worker slot nor asks the human
 * for a decision, so the container does no fake work and adds no gate noise;
 * the board already renders it in the Queue lane, where a container waiting on
 * its tickets belongs. It closes in `Store.closeEpicIfComplete` — `done` when
 * every ticket is `done`, `failed` naming the first ticket that failed,
 * rejected or was canceled — driven from `setStatus` (immediate, on the last
 * ticket's terminal transition) with `reconcileBlocked` as the convergence net.
 * The alternative (deps + echo runner + auto-approve) was rejected: it burns a
 * worker slot, a run row and a gate decision to represent "nothing happened",
 * and dep edges cannot point forward at tickets that do not exist yet.
 *
 * Playbook constraints are deliberately NOT injected into ticket prompts:
 * `briefFor` already prepends them via `roleAgent` at launch time, so doing it
 * here would duplicate them in every prompt and break the cache-stable prefix.
 */
export function queueCrewPlan(store: Store, plan: CrewPlan, extra: QueueCrewOptions = {}): QueuedEpic {
  assertDepth(store, extra.parentId);
  // A container with no tickets can never be closed by a ticket closing, so it
  // would sit `blocked` forever. Refuse before the row exists.
  if (!plan.tickets.length) throw new Error('refusing to open an epic with no tickets');
  const epic = store.addTask({
    title: plan.epic.title,
    prompt: [plan.epic.summary, plan.ask].filter(Boolean).join('\n\n') || plan.ask,
    kind: 'general',
    // Never runs; the runner field only has to be a valid one.
    runner: 'echo',
    repo: plan.repo,
    playbook: plan.playbook,
    isEpic: true,
    mergeOnApprove: false,
    parentId: extra.parentId ?? null,
    sensitivity: extra.sensitivity ?? 'S1',
    budgetUsd: extra.budgetUsd ?? null,
    priority: extra.priority ?? 0,
  });

  const ids = new Map<string, string>();
  const tickets: Task[] = [];
  for (const ticket of topoSort(plan.tickets)) {
    // Checked again as the row is written: a plan can be queued well after it
    // was drawn up (a preview confirmed later, a clone of an old epic), and a
    // name that has stopped passing since must not cost the epic its ticket.
    const target = { playbook: plan.playbook, role: ticket.role };
    const skills = checkTicketSkills(target, ticket.skills);
    const task = store.addTask({
      title: ticket.title,
      // The review notes that name this ticket ride on its prompt: the one per-ticket text that reaches both the
      // worker's brief and the reviewers' prompt as it is (see planNoteBlock for why not acceptance or demands).
      prompt: ticket.prompt + planNoteBlock(ticket.reviewNotes),
      kind: ticket.kind,
      runner: extra.runner ?? 'claude-code',
      repo: plan.repo,
      role: ticket.role,
      playbook: plan.playbook,
      acceptance: ticket.acceptance,
      forbiddenPaths: ticket.forbiddenPaths ?? null,
      skills: skills.names,
      points: ticket.points,
      testCmd: ticket.testCmd,
      parentId: epic.id,
      sensitivity: extra.sensitivity ?? 'S1',
      budgetUsd: extra.budgetUsd ?? null,
      priority: extra.priority ?? 0,
      gate: extra.gate ?? null,
      deps: ticket.after.map((ref) => ids.get(ref)).filter((id): id is string => Boolean(id)),
    });
    for (const r of skills.refused) {
      store.record({ taskId: task.id, type: 'warning', message: `${ticketSkillRefusal(target, skills, r)} — queued without it` });
    }
    if (ticket.reviewNotes?.length) {
      store.record({
        taskId: task.id, type: 'status',
        message: `plan review: ${ticket.reviewNotes.length} note(s) from the senior's review of the plan are in this ticket's brief`,
      });
    }
    ids.set(ticket.ref, task.id);
    tickets.push(task);
  }
  store.record({
    taskId: epic.id,
    type: 'status',
    message: `epic '${plan.epic.title}' opened with ${tickets.length} ticket(s) under playbook ${plan.playbook}`,
  });
  // A note that is in no ticket's brief is kept where the epic is read, and says why it is there.
  for (const note of plan.review?.notes ?? []) {
    if (note.tickets.some((ref) => ids.has(ref))) continue;
    store.record({ taskId: epic.id, type: 'warning', message: `plan review note, ${planNoteHome(note)}: ${note.text}` });
  }
  return { epic: store.getTask(epic.id)!, tickets };
}

/**
 * Rebuild a past epic's structure from the DB — titles, roles, dependency
 * shape, acceptance and the original ticket prompts. Zero Owner calls: repeat
 * work of a known shape should cost no planning tokens at all.
 */
export function cloneEpic(store: Store, epicId: string, opts: { repo?: string | null } = {}): CrewPlan {
  const source = store.getTask(epicId);
  if (!source) throw new Error(`no task ${epicId}`);
  if (!source.isEpic) throw new Error(`${epicId} is not an epic`);
  const children = store.childrenOf(epicId);
  if (!children.length) throw new Error(`epic ${epicId} has no tickets to clone`);

  // The playbook may have been edited since; a role it no longer defines has
  // no tier and no prompt, so it is remapped exactly as a fresh plan's would be.
  const pb = source.playbook ? getPlaybook(source.playbook) : null;
  const refByTaskId = new Map(children.map((c, i) => [c.id, `t${i + 1}`]));
  const tickets: CrewTicket[] = children.map((child) => ({
    ref: refByTaskId.get(child.id)!,
    title: child.title,
    prompt: child.prompt,
    role: pb ? (child.role && pb.roles[child.role] ? child.role : firstWorkerRole(pb)) : child.role ?? '',
    kind: child.kind,
    // Only sibling edges survive the clone; anything else pointed outside this epic.
    after: child.deps.map((d) => refByTaskId.get(d)).filter((r): r is string => Boolean(r)),
    acceptance: child.acceptance,
    forbiddenPaths: child.forbiddenPaths,
    // A clone is the same ticket again, so it keeps the skills it was given.
    ...(child.skills?.length ? { skills: child.skills } : {}),
    testCmd: child.testCmd,
    points: child.points,
  }));

  return {
    ask: source.prompt,
    playbook: source.playbook ?? '',
    epic: { title: source.title, summary: `cloned from epic ${epicId}` },
    tickets: topoSort(tickets),
    repo: opts.repo ?? source.repo,
    degraded: false,
    notes: `cloned from epic ${epicId} — no owner call`,
    costUsd: 0,
    precedents: [],
    // Zero-planning-token path by design: no lint pass,
    // no critique call. The structure already ran once and closed.
    findings: [],
  };
}
