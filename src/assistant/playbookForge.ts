import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearPlaybookCache,
  isPlaybookId,
  loadPlaybooks,
  loadPlaybooksFrom,
  playbooksDir,
  type Playbook,
} from '../playbooks.ts';
import type { Store } from '../queue.ts';
import { ownerCall } from './ownerCall.ts';

/**
 * Gate classes a forged playbook may never drop: an unknown domain's crew is
 * the least-proven crew there is, so the classes that always stop for a human
 * are forced on regardless of what the draft asked for.
 */
export const REQUIRED_HARD_HUMAN = ['S2', 'budget', 'allowCore'];

/**
 * The file-format contract is embedded rather than read from `playbooks/` in
 * the repo: the seeds are copied into $FOREMAN_HOME by `foreman crew init` and
 * are then the operator's to edit or delete, so reading one at prompt-build
 * time would make the forge's behaviour depend on files it does not own — and
 * would vary the prompt prefix per install, costing the prompt-cache hit.
 */
const FORMAT_CONTRACT = `A playbook is ONE markdown file: a JSON object between --- fences, then the body.

FRONT MATTER — a single JSON object, every field required:
{
  "id": "lowercase-kebab-case, starts with a letter, 2-41 chars",
  "description": "one line: the domain and how this crew works",
  "triggers": ["words", "an", "ask", "in", "this", "domain", "really", "contains"],
  "roles": { "<role-name>": { "tier": "owner" | "senior" | "worker" } },
  "reviewers": [{ "role": "<one of the roles above>", "style": "code-review" | "editorial-letter" | "devils-advocate" | "peer-review" }],
  "escalation": { "chair": "<the owner-tier role>", "afterFailures": 2 },
  "checks": [],
  "gate": { "default": "human", "hardHuman": ["S2", "budget", "allowCore"] },
  "constraints": ["hard rules injected into every ticket prompt in this domain"]
}

BODY — a '## pipeline' section, then one '## role: <name>' section per role in
"roles", names matching exactly. The pipeline section is prose naming the
stages an epic passes through, in order. Each role section is that role's
standing system prompt, written in the second person: what they do, what they
refuse to do, and what "done" means to them.

Tiers are model tiers, not seniority theatre: "owner" plans and chairs
escalations, "senior" designs and reviews, "worker" does the volume of the
work.`;

/** ONE short example — enough to fix the shape without dictating the domain. */
const FORMAT_EXAMPLE = `---
{
  "id": "software",
  "description": "Software development, scrum-style: plan, implement, test, review, gate.",
  "triggers": ["code", "bug", "feature", "refactor", "api"],
  "roles": {
    "planner": { "tier": "owner" },
    "senior": { "tier": "senior" },
    "dev": { "tier": "worker" }
  },
  "reviewers": [{ "role": "senior", "style": "code-review" }],
  "escalation": { "chair": "planner", "afterFailures": 2 },
  "checks": [],
  "gate": { "default": "human", "hardHuman": ["S2", "budget", "allowCore"] },
  "constraints": [
    "Keep diffs minimal and focused on the ticket.",
    "Never commit secrets or disable tests to make them pass."
  ]
}
---

## pipeline

An epic breaks down as plan -> implement -> test -> review -> gate: the planner
decomposes the ask into independently-testable tickets, each is implemented by a
dev, proven by the project's test command, reviewed by a senior who did not
write it, and gated by a human before it merges.

## role: planner

You decompose a software ask into a small set of independently-testable tickets
with explicit dependencies and acceptance criteria. Flag ambiguity in the
ticket brief rather than guessing at scope.

## role: senior

You review work you did not write: correctness first, then security, then
whether the tests actually exercise the change. A pass with unaddressed
security concerns is not a pass.

## role: dev

You implement exactly what the ticket asks — no unrelated refactors. Run the
project's tests before declaring the ticket done; if one fails, fix the cause,
not the assertion.

<!-- sources: scrum guide (scrumguides.org); Google engineering practices code review guide -->`;

const REQUIREMENTS = `REQUIREMENTS for the playbook you write:
- 3 to 6 roles, spread across the tiers, named the way this profession names them.
- Exactly 1 or 2 reviewers, with the style that matches how this field actually
  reviews work: code-review for engineering, editorial-letter for prose,
  peer-review for research and analysis, devils-advocate where the risk is a
  confident wrong conclusion.
- "escalation.chair" MUST be the owner-tier role.
- "checks" MUST be the empty array. Do not invent shell commands.
- "gate.default" MUST be "human" and "gate.hardHuman" MUST include
  "S2", "budget" and "allowCore".
- "constraints" MUST carry the hard rules of this profession — the things a
  practitioner is never allowed to do (fabricating a source, shipping unreviewed
  work, promising an outcome, giving licensed advice without the licence).
- End the body with an HTML comment citing what you modelled the org on:
  <!-- sources: ... -->

Output ONLY the file, starting with the first --- line. No preamble, no
explanation, and do not wrap it in a markdown code fence.`;

export interface ForgeOptions {
  domain: string;
  /** The original ask, when the forge was triggered by one — context, not scope. */
  ask?: string;
  store: Store;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ForgeResult {
  id: string;
  /** Where the draft parked: always under pending/, never the live dir. */
  path: string;
  playbook: Playbook;
  /** What was forced, stripped, or flagged — shown to the human who approves. */
  warnings: string[];
  costUsd: number;
}

/** Drafts live here until a human approves them; loadPlaybooks() never reads it. */
export function pendingDir(): string {
  return path.join(playbooksDir(), 'pending');
}

function pendingFile(id: string): string {
  // isPlaybookId first, always: this string becomes a path segment.
  if (!isPlaybookId(id)) throw new Error(`invalid playbook id: ${JSON.stringify(id)}`);
  return path.join(pendingDir(), `${id}.md`);
}

/** Models like to wrap a whole file in a fence even when told not to. */
function unfence(text: string): string {
  const fenced = text.trim().match(/^(?:`{3,}|~{3,})[a-z]*\r?\n([\s\S]*?)\r?\n(?:`{3,}|~{3,})\s*$/i);
  return (fenced ? fenced[1]! : text).trim();
}

interface Patched {
  text: string;
  id: string;
  warnings: string[];
}

/**
 * The privilege boundary in one place: what a model-authored playbook is not
 * allowed to decide for itself. Read two ways — the forge FORCES these fields
 * on a fresh draft (patchFrontMatter), and the approve path REFUSES a pending
 * file that still violates them (approvePending) — so the two can never drift.
 */
function privilegeGap(checks: unknown, gate: unknown): {
  checks: string[];
  gateDefault: unknown;
  gateSoft: boolean;
  hardHuman: string[];
  missingHard: string[];
} {
  const g = (gate && typeof gate === 'object' && !Array.isArray(gate) ? gate : {}) as Record<string, unknown>;
  const hardHuman = Array.isArray(g['hardHuman']) ? g['hardHuman'].map(String) : [];
  return {
    checks: Array.isArray(checks) ? checks.map(String) : [],
    gateDefault: g['default'] ?? null,
    gateSoft: g['default'] !== 'human',
    hardHuman,
    missingHard: REQUIRED_HARD_HUMAN.filter((cls) => !hardHuman.includes(cls)),
  };
}

/**
 * Why this playbook may not be installed as it stands, one named reason per
 * violated rule. Empty means it is inside the boundary.
 */
export function installRefusals(checks: unknown, gate: unknown): string[] {
  const gap = privilegeGap(checks, gate);
  const reasons: string[] = [];
  if (gap.checks.length) {
    reasons.push(
      `checks is not empty — it carries ${gap.checks.length} executable command(s) ` +
        `(${gap.checks.map((c) => JSON.stringify(c.slice(0, 60))).join(', ')})`,
    );
  }
  if (gap.gateSoft) reasons.push(`gate.default is ${JSON.stringify(gap.gateDefault)}, not 'human'`);
  if (gap.missingHard.length) reasons.push(`gate.hardHuman is missing ${gap.missingHard.join(', ')}`);
  return reasons;
}

/**
 * Force the front-matter fields the model is not allowed to decide, keeping its
 * body verbatim. This is not validation — the loader does that next — it is the
 * privilege boundary: a drafted playbook may describe an organization, but it
 * may not hand itself executable commands or a softer gate.
 */
function readFrontMatter(raw: string): { front: Record<string, unknown>; body: string; id: string } {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) throw new Error('the draft has no JSON front matter between --- fences');
  let front: Record<string, unknown>;
  try {
    front = JSON.parse(fm[1]!) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`the draft's front matter is not valid JSON: ${(err as Error).message}`);
  }
  if (!front || typeof front !== 'object' || Array.isArray(front)) {
    throw new Error("the draft's front matter must be a JSON object");
  }
  const id = typeof front['id'] === 'string' ? front['id'] : '';
  if (!isPlaybookId(id)) throw new Error(`the draft has an invalid id: ${JSON.stringify(front['id'])}`);
  return { front, body: fm[2] ?? '', id };
}

function patchFrontMatter(raw: string): Patched {
  const { front, body, id } = readFrontMatter(raw);
  const warnings: string[] = [];

  const gap = privilegeGap(front['checks'], front['gate']);

  // A forged playbook may not ship commands: `checks` run under /bin/sh in the
  // jail, and nothing model-authored gets that on a human's say-so alone.
  if (gap.checks.length) {
    warnings.push(
      `stripped ${gap.checks.length} check command(s) the draft shipped — a forged playbook may not carry ` +
        `executable checks (${gap.checks.map((c) => JSON.stringify(c.slice(0, 60))).join(', ')})`,
    );
  }
  front['checks'] = [];

  if (gap.gateSoft) warnings.push(`forced gate.default to 'human' (draft asked for ${JSON.stringify(gap.gateDefault)})`);
  if (gap.missingHard.length) warnings.push(`added required hardHuman class(es): ${gap.missingHard.join(', ')}`);
  const gate = (front['gate'] && typeof front['gate'] === 'object' && !Array.isArray(front['gate'])
    ? front['gate']
    : {}) as Record<string, unknown>;
  gate['default'] = 'human';
  gate['hardHuman'] = [...gap.hardHuman, ...gap.missingHard];
  front['gate'] = gate;

  return { text: `---\n${JSON.stringify(front, null, 2)}\n---\n${body}`, id, warnings };
}

/** Run the real loader over one file in a scratch dir; refusals become errors. */
function validateDraft(id: string, text: string): Playbook {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-forge-'));
  try {
    fs.writeFileSync(path.join(dir, `${id}.md`), text);
    const catalog = loadPlaybooksFrom(dir);
    const refusal = catalog.refused[0];
    if (refusal) throw new Error(`the drafted playbook is not loadable: ${refusal.reason}`);
    const pb = catalog.playbooks.find((p) => p.id === id);
    if (!pb) throw new Error('the drafted playbook did not survive the loader');
    return pb;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Domain-appropriate checks the loader cannot know about. */
function shapeWarnings(pb: Playbook): string[] {
  const warnings: string[] = [];
  const roles = Object.keys(pb.roles);
  if (roles.length < 3 || roles.length > 6) warnings.push(`${roles.length} roles (the brief asked for 3-6)`);
  if (pb.reviewers.length < 1 || pb.reviewers.length > 2) {
    warnings.push(`${pb.reviewers.length} reviewer(s) (the brief asked for 1-2)`);
  }
  if (pb.roles[pb.escalation.chair]?.tier !== 'owner') {
    warnings.push(`escalation chair '${pb.escalation.chair}' is not an owner-tier role`);
  }
  if (!pb.constraints.length) warnings.push('the draft carries no constraints — every ticket will run unconstrained');
  if (!pb.pipeline.trim()) warnings.push('the draft has no ## pipeline section — the planner gets no stage order');
  for (const f of pb.findings) warnings.push(`admission finding: ${f.rule} — ${f.message}`);
  return warnings;
}

/**
 * Draft a playbook for a domain nothing on the shelf covers.
 *
 * ONE Owner call, and the result is a file parked in `pending/` — never
 * installed. Installation is `approvePending`, reachable only from a human
 * typing `foreman playbook approve <id>` or clicking through the API: there is
 * deliberately no env var, flag, or config that lets a forged playbook install
 * itself. A playbook decides which model tier runs a role and what standing
 * instructions every worker in the domain carries, so self-installation would
 * let a model author its own operating instructions.
 */
export async function forgePlaybook(opts: ForgeOptions): Promise<ForgeResult> {
  const domain = opts.domain.trim().slice(0, 200);
  if (!domain) throw new Error('domain cannot be empty');

  const prompt =
    // static-first for prompt-cache hits: format contract, example and
    // requirements are byte-identical for every forge, so they lead; the
    // domain-bearing sentences (which name the domain inline) trail with it.
    `FILE FORMAT:\n${FORMAT_CONTRACT}\n\nEXAMPLE (a different domain, for shape only):\n${FORMAT_EXAMPLE}\n\n` +
    `${REQUIREMENTS}\n\n` +
    `You are designing an organizational playbook for the domain '${domain}'. ` +
    'Model it on how a real professional organization in this field structures ' +
    'roles, pipeline, review, and quality gates — not on how a software team ' +
    'would do it, unless this domain is software.\n\n' +
    `DOMAIN: ${domain}\n` +
    (opts.ask ? `The ask that found no playbook: ${opts.ask.trim().slice(0, 2000)}\n` : '');

  const { text, costUsd } = await ownerCall(prompt, {
    signal: opts.signal,
    // One reply, one file — this is a drafting call, not an agent loop.
    maxTurns: 2,
    timeoutMs: opts.timeoutMs,
    store: opts.store,
    kind: 'forge',
    taskId: null,
  });

  const patched = patchFrontMatter(unfence(text));
  const draft = validateDraft(patched.id, patched.text);

  // Collision is a refusal, not an overwrite: an installed playbook is one a
  // human already approved, and the forge does not get to replace it.
  clearPlaybookCache();
  if (loadPlaybooks().playbooks.some((p) => p.id === patched.id)) {
    throw new Error(`playbook '${patched.id}' is already installed — edit it directly or forge under another name`);
  }
  const file = pendingFile(patched.id);
  if (fs.existsSync(file)) {
    throw new Error(`a pending draft '${patched.id}' already exists — approve or reject it first`);
  }

  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.writeFileSync(file, patched.text);
  // Re-read from where it actually landed so `source` names the real file and
  // a truncated write cannot be reported as a good draft.
  const parked = loadPlaybooksFrom(pendingDir()).playbooks.find((p) => p.id === patched.id) ?? draft;

  return {
    id: patched.id,
    path: file,
    playbook: parked,
    warnings: [...patched.warnings, ...shapeWarnings(parked)],
    costUsd,
  };
}

export interface PendingCatalog {
  dir: string;
  drafts: Playbook[];
  refused: Array<{ id: string; reason: string }>;
}

/** Pending drafts are ordinary files, so this survives a daemon restart for free. */
export function listPending(): PendingCatalog {
  const dir = pendingDir();
  const catalog = loadPlaybooksFrom(dir);
  return { dir, drafts: catalog.playbooks, refused: catalog.refused };
}

/**
 * id → file, resolved through the same catalog `foreman playbook pending`
 * prints rather than by assuming `pending/<id>.md`. A draft whose filename
 * disagrees with its front-matter id used to be unapprovable under either
 * name — one said "no pending playbook", the other installed a file the loader
 * then read under a different id and failed with "unknown reason". Now the id
 * in the front matter is the id, and a disagreement is named.
 */
function resolvePending(id: string): string {
  // isPlaybookId first, always: this string becomes a path segment.
  if (!isPlaybookId(id)) throw new Error(`invalid playbook id: ${JSON.stringify(id)}`);
  const byName = path.join(pendingDir(), `${id}.md`);
  const catalog = listPending();
  const draft = catalog.drafts.find((p) => p.id === id);
  if (draft) return draft.source;
  const mismatch = catalog.drafts.find((p) => p.source === byName);
  if (mismatch) {
    throw new Error(
      `no pending playbook '${id}': ${byName} declares id '${mismatch.id}' in its front matter — ` +
        `approve it as '${mismatch.id}', or fix the id in the file`,
    );
  }
  // Not in `drafts` and not a mismatch: either the file does not load at all
  // (it is in `refused`) or it is not there. The first still resolves, so the
  // loader's own reason is what the caller is told below.
  if (fs.existsSync(byName)) return byName;
  throw new Error(`no pending playbook '${id}' — run 'foreman playbook pending' to see the drafts`);
}

/** The privilege pass, run over a file on disk; an unreadable one is its own reason. */
function installRefusalsFor(src: string, id: string): string[] {
  try {
    const { front, id: declared } = readFrontMatter(fs.readFileSync(src, 'utf8'));
    if (declared !== id) return [`its front matter declares id '${declared}'`];
    return installRefusals(front['checks'], front['gate']);
  } catch (err) {
    return [(err as Error).message];
  }
}

/**
 * The human gate's only door. Moving the file IS the installation — the loader
 * scans the live dir, and `pending/` is a subdirectory it never reads (it skips
 * every entry not named `*.md`, and stats what is left).
 *
 * The file is re-sanitized first, by the same pass the forge runs. A violation
 * REFUSES the approve rather than being patched out here: the pending file has
 * been hand-editable since it was forged, and quietly rewriting it at approve
 * time would install something other than what the human just read.
 */
export function approvePending(id: string): Playbook {
  const src = resolvePending(id);
  const refusals = installRefusalsFor(src, id);
  if (refusals.length) {
    throw new Error(
      `refusing to install '${id}': ${refusals.join('; ')} — ${src} is not what the forge would have written; ` +
        `fix it by hand or re-forge, then approve again`,
    );
  }

  const dest = path.join(playbooksDir(), `${id}.md`);
  if (fs.existsSync(dest)) throw new Error(`playbook '${id}' is already installed at ${dest}`);

  fs.mkdirSync(playbooksDir(), { recursive: true });
  fs.renameSync(src, dest);
  clearPlaybookCache();

  // Belt and braces: the draft validated when it was forged, but the file has
  // been on disk (and editable by hand) since. If the live loader will not take
  // it, put it back rather than leaving a refused file in the catalog dir.
  const catalog = loadPlaybooks();
  const pb = catalog.playbooks.find((p) => p.id === id);
  if (!pb) {
    const reason = catalog.refused.find((r) => r.id === id || r.id === `${id}.md`)?.reason ?? 'unknown reason';
    fs.renameSync(dest, src);
    clearPlaybookCache();
    throw new Error(`refusing to install '${id}': ${reason} — the draft is back in pending/`);
  }
  return pb;
}

export function rejectPending(id: string): { id: string; path: string } {
  // Same resolution as approve, so a draft is rejectable under exactly the
  // name it is approvable under — including one whose filename disagrees.
  const file = resolvePending(id);
  fs.rmSync(file);
  return { id, path: file };
}
