import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import type { Finding } from './security/admit.ts';
import { ROLE_MODES, type RoleMode } from './verify/determinism.ts';
import { admit, AdmissionBlocked, scanCommand } from './security/admit.ts';
import { probeTask } from './types.ts';
import type { Tier } from './roles.ts'; // type-only: erased at compile time, no runtime cycle with roles.ts
import type { Assignee } from './types.ts';
import { checkTicketSkills, loadSkills, MAX_SKILLS_PER_TICKET, MAX_TICKET_SKILL_NAMES, printable, shown } from './skills.ts';

export interface PlaybookTool {
  name: string;
  /** When this role should reach for it. Optional; the manifest says what it does. */
  when: string;
}

export interface PlaybookReviewer {
  role: string;
  style: 'code-review' | 'editorial-letter' | 'devils-advocate' | 'peer-review';
  /** Skills this reviewer carries. Present only when the file names the key; a bad list is [] (none), never the role default. */
  skills?: string[];
}

/** A problem with a reviewer's `skills` list. The playbook still loads; a malformed entry is dropped. */
export interface PlaybookWarning {
  playbook: string;
  /** Position in the playbook's reviewers. */
  reviewer: number;
  role: string;
  skill: string;
  reason: string;
}

/**
 * A playbook is the org-structure definition for one domain: roles (mapped to
 * model tiers), a review chain, an escalation chair, domain check commands for
 * the test stage, a gate policy, and hard constraints injected into every
 * ticket prompt. Files live as markdown-with-JSON-front-matter under
 * $FOREMAN_HOME/playbooks (override with FOREMAN_PLAYBOOKS_DIR) — no YAML
 * parser in this codebase, so the front matter between the `---` fences is a
 * single JSON object, and the body carries role prompts as `## role: <name>`
 * sections plus an optional `## pipeline` section.
 */
export interface Playbook {
  id: string;
  description: string;
  triggers: string[];
  /**
   * `assignee` is optional per role: a playbook can declare that one of its
   * roles is the operator's own work (a publisher's binding ruling, say) while
   * the rest run unattended. Omitted, it falls through to the playbook default
   * and then to FOREMAN_ASSIGNEE — see assign.ts:effectiveAssignee.
   */
  roles: Record<string, { tier: Tier; assignee?: Assignee; mode?: RoleMode }>;
  /**
   * Content every document a role writes must contain (a disclaimer, a limitations section), checked
   * deterministically before any reviewer is paid (verify/determinism.ts). `pattern` is a case-insensitive,
   * multiline regular expression; `roles` limits the rule to the roles that write such documents.
   */
  required?: Array<{ label: string; pattern: string; roles?: string[] }>;
  /**
   * Web access for this playbook's claude-code workers: WebSearch and WebFetch join their allowlist (never for an S2
   * ticket). For work whose job is finding sources (research); reviewers never get it. Fetched text is untrusted
   * data and only the role text says so; WebFetch reaches any host, and the claude-code worker is not sandboxed, so a
   * page that steers the worker reaches its jail and the network (README, "web"). A forged playbook may not set it.
   */
  web?: boolean;
  /** Playbook-wide default for who does the work. Omitted means "don't decide here". */
  assignee: Assignee | null;
  /**
   * Tools a role is expected to reach for, per role.
   *
   * A toolbox nobody is told about is a toolbox nobody uses. Ten book-relevant
   * tools existed here — prose-gate, numeral-tic, continuity-check,
   * find-artifacts, book-lint — while every drafting ticket went out with no
   * mention of any of them, so each run either rediscovered them or, far more
   * often, did the job by hand. Naming them on the role is what turns a
   * catalog into a habit.
   *
   * `when` is the playbook's own note about the moment to use it; the tool's
   * manifest supplies what it does, so the two are never duplicated.
   */
  tools: Record<string, PlaybookTool[]>;
  /**
   * Skill names a role carries on every ticket, per role, in place of the
   * role's loadout default (skills.ts). Naming one here does not grant it: the
   * role's loadout must allow it and the skill must list the role, or it is
   * left out and the brief says so. Absent on a playbook that names none.
   */
  skills?: Record<string, string[]>;
  reviewers: PlaybookReviewer[];
  escalation: { chair: string; afterFailures: number };
  /** Domain check commands run in the jail during the test stage, after testCmd. */
  checks: string[];
  /**
   * Additive, default false. When set, the scheduler's test stage also runs
   * an in-process manuscript audit (scanTics + metrics + bible consistency)
   * plus a factDrift guard over every .md/.txt file the jail touched — see
   * scheduler.ts's proseAudit block. Unrelated to `checks`, which are shelled
   * out; this runs no shell at all.
   */
  proseAudit: boolean;
  gate: { default: 'human' | 'owner'; hardHuman: string[] };
  /** Hard rules injected into every ticket prompt for this playbook. */
  constraints: string[];
  /** Prose pipeline description from '## pipeline', fed to the Phase 2 planner. Empty string if absent. */
  pipeline: string;
  /** One system-prompt-shaped block per role, from '## role: <name>' sections. */
  rolePrompts: Record<string, string>;
  /**
   * Optional short variant of a role's prompt, from '## role-card: <name>' sections. A worker gets it in place
   * of the full prompt when its role's tier resolves to a local model — the same rule that serves a skill's
   * card.md instead of its full.md (roles.ts skillVariantFor). Absent for a role with no card section.
   */
  roleCards?: Record<string, string>;
  source: string;
  findings: Finding[];
}

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const TIERS = new Set<string>(['owner', 'senior', 'worker']);
const GATE_DEFAULTS = new Set<string>(['human', 'owner']);
const ASSIGNEES = new Set<string>(['ai', 'human']);
// Matches the tool catalog's own naming rule; a playbook must not be able to
// name something the catalog could never register.
const TOOL_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
// The skill catalog's own naming rule (skills.ts SKILL_NAME_RE), for the same reason.
const SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;
const REVIEWER_STYLES = new Set<string>(['code-review', 'editorial-letter', 'devils-advocate', 'peer-review']);

export function playbooksDir(): string {
  return process.env['FOREMAN_PLAYBOOKS_DIR'] ?? path.join(config.home, 'playbooks');
}

/**
 * Shape check for an id, exported because a playbook id is also a filename:
 * anything writing `<id>.md` has to refuse traversal and shell-hostile names
 * before it touches the disk, and it must refuse by exactly the rule the
 * loader would later apply.
 */
export function isPlaybookId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * Blank out the interior of fenced code blocks (``` or ~~~, CRLF-tolerant)
 * while preserving every other character's offset in the string — including
 * the fence delimiter lines themselves. This lets the heading scanner run
 * against the blanked copy (so a `## role: x` inside a fence is invisible to
 * it) while still slicing section content out of the original, unblanked
 * body by the same character offsets.
 */
function blankFencedRegions(body: string): string {
  const parts = body.split(/(\r\n|\n)/); // odd indices are the line separators
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!;
    if (!inFence) {
      const open = line.match(/^(\s*)(`{3,}|~{3,})/);
      if (open) {
        inFence = true;
        fenceChar = open[2]![0]!;
        fenceLen = open[2]!.length;
        parts[i] = ' '.repeat(line.length);
      }
      continue;
    }
    const close = new RegExp(`^\\s*[${fenceChar}]{${fenceLen},}\\s*$`).test(line);
    parts[i] = ' '.repeat(line.length);
    if (close) inFence = false;
  }
  return parts.join('');
}

/** Split the body into '## role: <name>' prompts and the '## pipeline' prose. */
function parseSections(body: string): {
  pipeline: string;
  rolePrompts: Record<string, string>;
  roleCards: Record<string, string>;
  duplicateRole: string | null;
  duplicateCard: string | null;
} {
  const rolePrompts: Record<string, string> = {};
  const roleCards: Record<string, string> = {};
  let pipeline = '';
  let duplicateRole: string | null = null;
  let duplicateCard: string | null = null;
  const scanBody = blankFencedRegions(body);
  const heads = [...scanBody.matchAll(/^##\s+(.+)$/gm)];
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i]!;
    const heading = head[1]!.trim();
    const contentStart = head.index! + head[0].length;
    const contentEnd = i + 1 < heads.length ? heads[i + 1]!.index! : body.length;
    const content = body.slice(contentStart, contentEnd).trim();
    const cardMatch = heading.match(/^role-card:\s*(.+)$/i);
    const roleMatch = heading.match(/^role:\s*(.+)$/i);
    if (cardMatch) {
      const name = cardMatch[1]!.trim();
      if (Object.prototype.hasOwnProperty.call(roleCards, name) && duplicateCard === null) duplicateCard = name;
      roleCards[name] = content;
    } else if (roleMatch) {
      const name = roleMatch[1]!.trim();
      if (Object.prototype.hasOwnProperty.call(rolePrompts, name) && duplicateRole === null) duplicateRole = name;
      rolePrompts[name] = content;
    } else if (/^pipeline$/i.test(heading)) {
      pipeline = content;
    }
  }
  return { pipeline, rolePrompts, roleCards, duplicateRole, duplicateCard };
}

interface RawFrontMatter {
  id?: unknown;
  description?: unknown;
  triggers?: unknown;
  roles?: Record<string, { tier?: unknown; assignee?: unknown; mode?: unknown } | undefined>;
  required?: unknown;
  web?: unknown;
  assignee?: unknown;
  tools?: Record<string, unknown>;
  skills?: Record<string, unknown>;
  reviewers?: Array<{ role?: unknown; style?: unknown; skills?: unknown }>;
  escalation?: { chair?: unknown; afterFailures?: unknown };
  checks?: unknown;
  proseAudit?: unknown;
  gate?: { default?: unknown; hardHuman?: unknown };
  constraints?: unknown;
}

/**
 * A reviewer's `skills` list as the file names it: shape and name checked, a
 * repeat counted once, at most MAX_SKILLS_PER_TICKET. Never refuses the
 * playbook: each problem goes to `warnings` and the bad entry is dropped, so a
 * non-array or a list with no valid name is [] (no skills), not the role's
 * default. With FOREMAN_SKILLS_DIR set, a name the catalog would not serve now
 * is warned about but kept: this list is cached with the playbook file, while
 * the catalog changes on its own, so crew review checks it again when it serves
 * (skillsFor). A skill added later is then served without a restart, and one
 * the catalog refuses is recorded where the review ran.
 */
function reviewerSkills(playbook: string, reviewer: number, role: string, raw: unknown, warnings: PlaybookWarning[]): string[] {
  const warn = (skill: string, reason: string): void => void warnings.push({ playbook, reviewer, role, skill, reason });
  // Before either path: checkTicketSkills reads null as "nothing asked for", but a key the file names is a list or a mistake.
  if (!Array.isArray(raw)) {
    warn(typeof raw === 'string' ? raw : '(not a list)', 'skills must be a list of skill names');
    return [];
  }
  if (raw.length > MAX_TICKET_SKILL_NAMES) {
    warn(`(${raw.length} names)`, `a reviewer names at most ${MAX_SKILLS_PER_TICKET} skills`);
    return [];
  }
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (!SKILL_NAME_RE.test(name)) warn(typeof entry === 'string' ? entry : '(not a name)', 'not a valid skill name');
    else if (names.includes(name)) continue; // a repeat is one name, as skillsFor reads it
    else if (names.length >= MAX_SKILLS_PER_TICKET) warn(name, `over the limit of ${MAX_SKILLS_PER_TICKET} skills per ticket`);
    else names.push(name);
  }
  if (loadSkills().dir) {
    for (const f of checkTicketSkills({ playbook, role }, names).refused) warn(f.name, f.reason);
  }
  return names;
}

/** Parse + validate one playbook file. Returns a reason string instead of throwing on any schema problem. */
function parseFile(text: string, file: string): { pb: Playbook | null; reason: string | null; warnings?: PlaybookWarning[] } {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) return { pb: null, reason: 'no JSON front matter fences (--- ... ---)' };

  let raw: RawFrontMatter;
  try {
    raw = JSON.parse(fm[1]!) as RawFrontMatter;
  } catch (err) {
    return { pb: null, reason: `invalid JSON front matter: ${(err as Error).message}` };
  }

  const { pipeline, rolePrompts, roleCards, duplicateRole, duplicateCard } = parseSections(fm[2] ?? '');
  if (duplicateRole) {
    return { pb: null, reason: `duplicate '## role: ${duplicateRole}' section — ambiguous authorship, refusing rather than picking one` };
  }
  if (duplicateCard) {
    return { pb: null, reason: `duplicate '## role-card: ${duplicateCard}' section — ambiguous authorship, refusing rather than picking one` };
  }

  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!ID_RE.test(id)) return { pb: null, reason: `invalid or missing id: ${JSON.stringify(raw.id)}` };

  const rawRoles = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  const roleNames = Object.keys(rawRoles);
  if (!roleNames.length) return { pb: null, reason: 'roles must be non-empty' };
  // A card stands in for a role's prompt: one for a role the playbook does not declare, or one with no text,
  // would be served to nobody or serve nothing, so either is a mistake in the file and refuses it.
  for (const [name, card] of Object.entries(roleCards)) {
    if (!Object.prototype.hasOwnProperty.call(rawRoles, name)) {
      return { pb: null, reason: `'## role-card: ${name}' names a role the playbook does not declare` };
    }
    if (!card.trim()) return { pb: null, reason: `'## role-card: ${name}' is empty` };
  }
  const roles: Record<string, { tier: Tier; assignee?: Assignee; mode?: RoleMode }> = {};
  for (const name of roleNames) {
    const tier = rawRoles[name]?.tier;
    if (typeof tier !== 'string' || !TIERS.has(tier)) {
      return { pb: null, reason: `role '${name}' has an invalid tier: ${JSON.stringify(tier)}` };
    }
    if (!rolePrompts[name]?.trim()) {
      return { pb: null, reason: `role '${name}' has no non-empty '## role: ${name}' prompt section` };
    }
    // An unrecognised assignee is refused rather than defaulted: the whole
    // point of the field is to keep a model off a ticket, so a typo that
    // silently reverted to 'ai' would defeat it in exactly the case it matters.
    const rawRoleAssignee = rawRoles[name]?.assignee;
    if (rawRoleAssignee !== undefined && !ASSIGNEES.has(String(rawRoleAssignee))) {
      return { pb: null, reason: `role '${name}' has an invalid assignee: ${JSON.stringify(rawRoleAssignee)}` };
    }
    // The slider (verify/determinism.ts): a typo would silently fall back to balanced and turn checks off or on
    // behind the author's back, so an unknown mode refuses the playbook.
    const rawMode = rawRoles[name]?.mode;
    if (rawMode !== undefined && !ROLE_MODES.has(String(rawMode))) {
      return { pb: null, reason: `role '${name}' has an invalid mode: ${JSON.stringify(rawMode)} (deterministic, balanced or generative)` };
    }
    roles[name] = {
      tier: tier as Tier,
      ...(rawRoleAssignee === undefined ? {} : { assignee: String(rawRoleAssignee) as Assignee }),
      ...(rawMode === undefined ? {} : { mode: String(rawMode) as RoleMode }),
    };
  }

  if (raw.assignee !== undefined && !ASSIGNEES.has(String(raw.assignee))) {
    return { pb: null, reason: `assignee is invalid: ${JSON.stringify(raw.assignee)}` };
  }
  const assignee: Assignee | null = raw.assignee === undefined ? null : (String(raw.assignee) as Assignee);

  // Tools, per role. A string is shorthand for { name, when: '' }.
  const tools: Record<string, PlaybookTool[]> = {};
  const rawTools = raw.tools && typeof raw.tools === 'object' ? raw.tools as Record<string, unknown> : {};
  for (const [role, list] of Object.entries(rawTools)) {
    if (!roleNames.includes(role)) return { pb: null, reason: `tools names role '${role}', which is not defined in roles` };
    if (!Array.isArray(list)) return { pb: null, reason: `tools.${role} must be an array` };
    const entries: PlaybookTool[] = [];
    for (const item of list) {
      const name = typeof item === 'string' ? item : (item as { name?: unknown })?.name;
      if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
        return { pb: null, reason: `tools.${role} has an invalid tool name: ${JSON.stringify(name)}` };
      }
      const when = typeof item === 'object' && item && typeof (item as { when?: unknown }).when === 'string'
        ? String((item as { when: string }).when).slice(0, 240)
        : '';
      entries.push({ name, when });
    }
    tools[role] = entries;
  }

  // Skills, per role: a list of names, each a string or { name }. Validated
  // like tools — a role nobody defined or a name the catalog could never hold
  // refuses the playbook rather than being quietly skipped.
  const skills: Record<string, string[]> = {};
  const rawSkills = raw.skills && typeof raw.skills === 'object' && !Array.isArray(raw.skills) ? raw.skills as Record<string, unknown> : {};
  for (const [role, list] of Object.entries(rawSkills)) {
    if (!roleNames.includes(role)) return { pb: null, reason: `skills names role '${role}', which is not defined in roles` };
    if (!Array.isArray(list)) return { pb: null, reason: `skills.${role} must be an array` };
    const names: string[] = [];
    for (const item of list) {
      const name = typeof item === 'string' ? item : (item as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
        return { pb: null, reason: `skills.${role} has an invalid skill name: ${JSON.stringify(name)}` };
      }
      names.push(name);
    }
    skills[role] = names;
  }

  const rawReviewers = Array.isArray(raw.reviewers) ? raw.reviewers : [];
  const reviewers: PlaybookReviewer[] = [];
  const warnings: PlaybookWarning[] = [];
  for (const r of rawReviewers) {
    const role = typeof r.role === 'string' ? r.role : '';
    const style = typeof r.style === 'string' ? r.style : '';
    if (!roleNames.includes(role)) return { pb: null, reason: `reviewer role '${role}' is not defined in roles` };
    if (!REVIEWER_STYLES.has(style)) return { pb: null, reason: `reviewer style '${style}' is not a known style` };
    const entry: PlaybookReviewer = { role, style: style as PlaybookReviewer['style'] };
    if (r.skills !== undefined) entry.skills = reviewerSkills(id, reviewers.length, role, r.skills, warnings);
    reviewers.push(entry);
  }

  const chair = typeof raw.escalation?.chair === 'string' ? raw.escalation.chair : '';
  if (!roleNames.includes(chair)) return { pb: null, reason: `escalation.chair '${chair}' is not defined in roles` };
  const afterFailures = Number(raw.escalation?.afterFailures ?? 2);

  const gateDefault = typeof raw.gate?.default === 'string' ? raw.gate.default : '';
  if (!GATE_DEFAULTS.has(gateDefault)) return { pb: null, reason: `gate.default is invalid: ${JSON.stringify(gateDefault)}` };
  const hardHuman = Array.isArray(raw.gate?.hardHuman) ? raw.gate.hardHuman.map(String) : [];

  // pb.checks are executed with /bin/sh -c in the jail during the test stage,
  // same as testCmd — but unlike testCmd (which a human types when queuing a
  // task) these ship inside a playbook file and never pass task admission.
  // Screen every one at load time; any blocking finding refuses the whole
  // playbook rather than letting it onto the scheduler's hot path.
  const checks = Array.isArray(raw.checks) ? raw.checks.map(String) : [];
  for (const check of checks) {
    const blocked = scanCommand(check);
    if (blocked) return { pb: null, reason: `check ${JSON.stringify(check)} refused: ${blocked}` };
  }

  if (raw.web !== undefined && typeof raw.web !== 'boolean') {
    return { pb: null, reason: `web must be true or false, not ${JSON.stringify(raw.web)}` };
  }
  // Required content (verify/determinism.ts). A malformed rule is a mistake in the file, not something to skip
  // quietly: a rule that silently never runs is a check the author believes exists.
  const required: Array<{ label: string; pattern: string; roles?: string[] }> = [];
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required)) return { pb: null, reason: 'required must be an array of { label, pattern, roles? }' };
    for (const [i, r] of (raw.required as unknown[]).entries()) {
      const rule = (r ?? {}) as { label?: unknown; pattern?: unknown; roles?: unknown };
      if (typeof rule.label !== 'string' || !rule.label.trim()) return { pb: null, reason: `required[${i}] has no label` };
      if (typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > 200) {
        return { pb: null, reason: `required[${i}] needs a pattern of 1-200 characters` };
      }
      try {
        new RegExp(rule.pattern, 'im');
      } catch (err) {
        return { pb: null, reason: `required[${i}] pattern is not a valid regular expression: ${(err as Error).message}` };
      }
      let rolesFor: string[] | undefined;
      if (rule.roles !== undefined) {
        if (!Array.isArray(rule.roles) || !rule.roles.length || !rule.roles.every((x) => typeof x === 'string' && Object.prototype.hasOwnProperty.call(rawRoles, x))) {
          return { pb: null, reason: `required[${i}].roles must list at least one role the playbook declares (leave it out to cover every role)` };
        }
        rolesFor = rule.roles as string[];
      }
      required.push({ label: rule.label.trim(), pattern: rule.pattern, ...(rolesFor ? { roles: rolesFor } : {}) });
    }
  }

  const pb: Playbook = {
    id,
    description: typeof raw.description === 'string' ? raw.description : '',
    triggers: Array.isArray(raw.triggers) ? raw.triggers.map(String) : [],
    roles,
    assignee,
    tools,
    // Only when the file names some: a playbook without the key is the same
    // object it was before the key existed.
    ...(Object.keys(skills).length ? { skills } : {}),
    reviewers,
    escalation: { chair, afterFailures: Number.isFinite(afterFailures) ? afterFailures : 2 },
    checks,
    // Additive flag: unknown/absent front-matter keys are silently ignored
    // everywhere else in this parser (RawFrontMatter only reads what it
    // declares), so `proseAudit` on an older playbook file with no such key
    // just defaults false — same behavior as before this field existed.
    proseAudit: raw.proseAudit === true,
    gate: { default: gateDefault as 'human' | 'owner', hardHuman },
    constraints: Array.isArray(raw.constraints) ? raw.constraints.map(String) : [],
    ...(required.length ? { required } : {}),
    ...(raw.web === true ? { web: true } : {}),
    pipeline,
    rolePrompts,
    ...(Object.keys(roleCards).length ? { roleCards } : {}),
    source: file,
    findings: [],
  };
  return { pb, reason: null, warnings };
}

/**
 * Admission-scan every role prompt + constraint + check command together,
 * exactly like agents.ts scan(). Checks are already screened individually by
 * scanCommand() in parseFile(); folding them in here too is defense in
 * depth — it also runs them past frisk-scan (if installed) and the built-in
 * warn/note patterns, not just the BLOCK patterns scanCommand() checks alone.
 * admit()'s task-shaped rules (core-guard, S2, local-only runner) cannot fire
 * on this probe: it has no repo, is S1 and uses the api runner.
 */
function scan(pb: Playbook): Finding[] {
  const text = [...Object.values(pb.rolePrompts), ...Object.values(pb.roleCards ?? {}), ...pb.constraints, ...pb.checks].join('\n\n');
  return admit(probeTask({ id: `playbook:${pb.id}`, title: pb.id, prompt: text }));
}

/** A tool a playbook asks for that the catalog does not have. */
export interface MissingTool {
  playbook: string;
  role: string;
  tool: string;
  when: string;
}

export interface PlaybookCatalog {
  playbooks: Playbook[];
  refused: Array<{ id: string; reason: string }>;
  /** Problems in a playbook that still loaded (a reviewer's bad `skills` list). */
  warnings: PlaybookWarning[];
}

/**
 * loadPlaybooks() sits on the scheduler's hot path (roles.ts:modelForTask,
 * called once per task per /api/state snapshot) but does a full
 * readdir+parse+admission-scan every time — tens of ms per call, times every
 * task, on every poll. Cache the parsed catalog per playbooks-dir, keyed on a
 * cheap fingerprint (name+mtimeMs+size per .md file): a statSync sweep every
 * call, full re-parse only when a file actually changed. mtime alone is not
 * enough (sub-ms rewrites on fast filesystems can land in the same tick), so
 * size is folded into the fingerprint too — not bulletproof against a
 * same-size same-millisecond edit, but that combination doesn't happen in
 * practice and tests that need a guaranteed-fresh read can call
 * clearPlaybookCache() directly.
 */
const catalogCache = new Map<string, { fingerprint: string | null; catalog: PlaybookCatalog }>();

/** Test-only escape hatch: force the next loadPlaybooks() to re-read from disk. */
export function clearPlaybookCache(): void {
  catalogCache.clear();
}

/** Null when the dir does not exist, so that state is distinguishable from an empty dir. */
function fingerprintDir(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const parts: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      parts.push(`${name}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${name}:unreadable`);
    }
  }
  return parts.join('|');
}

/**
 * One line for a warning, as the log, `foreman playbooks` and `foreman build` print it. The skill and the role come
 * from the playbook file as written, so every field is cut short and made printable: no escape sequence or line break
 * reaches a terminal or the log.
 */
export function formatPlaybookWarning(w: PlaybookWarning): string {
  return `playbook ${printable(String(w.playbook))}: reviewer ${printable(String(w.reviewer))} (${printable(String(w.role))}) skill ${shown(String(w.skill))} — ${printable(String(w.reason))}`;
}

/** Warnings already logged by this process; a reload or a second load does not log them again. */
const loggedWarnings = new Set<string>();

/** Test-only: forget what was logged, so the next load logs its warnings again. */
export function clearLoggedPlaybookWarnings(): void {
  loggedWarnings.clear();
}

export function loadPlaybooks(): PlaybookCatalog {
  const dir = playbooksDir();
  const fingerprint = fingerprintDir(dir);
  const cached = catalogCache.get(dir);
  if (cached && cached.fingerprint === fingerprint) return cached.catalog;

  const catalog = loadPlaybooksFrom(dir);
  for (const w of catalog.warnings) {
    const line = formatPlaybookWarning(w);
    if (loggedWarnings.has(line)) continue;
    loggedWarnings.add(line);
    console.error(`foreman: ${line}`);
  }
  // fingerprint may be null (dir missing); still cache it — an absent dir
  // staying absent is itself a stable, cheap-to-confirm state.
  catalogCache.set(dir, { fingerprint, catalog });
  return catalog;
}

/**
 * The uncached loader, exported so a caller holding a directory that is not
 * the installed one (the forge validating a draft in a temp dir, or listing
 * `pending/`) runs the real parse + admission path instead of a second,
 * weaker copy of it — and does so without mutating FOREMAN_PLAYBOOKS_DIR
 * underneath a concurrently-running scheduler.
 */
export function loadPlaybooksFrom(dir: string): PlaybookCatalog {
  const playbooks: Playbook[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  const warnings: PlaybookWarning[] = [];
  if (!fs.existsSync(dir)) return { playbooks, refused, warnings };

  const seenIds = new Set<string>();
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (!name.endsWith('.md')) continue;
    let text: string;
    try {
      // Stat lives inside this try too: loadPlaybooks runs on the scheduler's
      // hot path, and a dangling symlink or a permission error mid-readdir
      // must land the entry in `refused`, not throw out of the whole call.
      if (!fs.statSync(file).isFile()) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      refused.push({ id: name, reason: `unreadable: ${(err as Error).message}` });
      continue;
    }
    const { pb, reason, warnings: found = [] } = parseFile(text, file);
    if (!pb) {
      refused.push({ id: name, reason: reason ?? 'invalid playbook' });
      continue;
    }
    if (seenIds.has(pb.id)) {
      refused.push({ id: pb.id, reason: `duplicate id: '${pb.id}' is already defined by another playbook file (${file})` });
      continue;
    }
    try {
      pb.findings = scan(pb);
      playbooks.push(pb);
      warnings.push(...found);
      seenIds.add(pb.id);
    } catch (err) {
      // Admission is non-overridable: a blocked playbook is not in the catalog.
      refused.push({ id: pb.id, reason: err instanceof AdmissionBlocked ? err.message : String(err) });
    }
  }
  return { playbooks, refused, warnings };
}

export function getPlaybook(id: string): Playbook | null {
  return loadPlaybooks().playbooks.find((p) => p.id === id) ?? null;
}
