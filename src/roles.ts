import { getAgent, type AgentDef } from './agents.ts';
import { getTool } from './tools/catalog.ts';
// Runtime import of playbooks.ts: playbooks.ts only type-imports Tier from
// here (erased by erasableSyntaxOnly), so this is a one-directional runtime
// edge, not a cycle. roleAgent lives here (not in playbooks.ts) so that
// playbooks.ts never needs a runtime import of tierModel.
import { getPlaybook, type MissingTool, type Playbook, type PlaybookCatalog } from './playbooks.ts';
import { personaForTask } from './align/personas.ts';
import { cloudFallback, crewRunner, localAliasFor, localOnly } from './localOnly.ts';
import { DEPRECATED_ALIASES, specs } from './models.ts';
import type { Store } from './queue.ts'; // type-only (erased): no runtime edge from roles to the store
import { loadSkills, skillBlock, skillBrief, skillsRunRecord, type SkillVariant } from './skills.ts';
import type { Task } from './types.ts';

export type Tier = 'owner' | 'senior' | 'worker';

// Owner was `fable` until 2026-10-05; it is deprecated (see DEPRECATED_ALIASES).
const DEFAULTS: Record<Tier, string> = { owner: 'opus', senior: 'opus', worker: 'sonnet' };
const ENV_VAR: Record<Tier, string> = {
  owner: 'FOREMAN_MODEL_OWNER',
  senior: 'FOREMAN_MODEL_SENIOR',
  worker: 'FOREMAN_MODEL_WORKER',
};

/**
 * Env is read lazily (not captured at module load) so tests can flip
 * FOREMAN_MODEL_* per-case without reimporting this module.
 */
export function tierModel(tier: Tier, kind?: Task['kind'] | null): string {
  const explicit = process.env[ENV_VAR[tier]];
  if (explicit) {
    warnDeprecated(explicit, ENV_VAR[tier]);
    return explicit;
  }
  // In local-only mode the cloud defaults (fable/opus/sonnet) name aliases that
  // no longer resolve, so the tier collapses onto the local roster instead —
  // the local-only policy. An explicit FOREMAN_MODEL_* still wins, and is still
  // checked for locality downstream by assertAllowed(), so pointing it at a
  // cloud alias fails loudly rather than quietly leaving the machine.
  if (localOnly()) return localAliasFor(tier, kind);
  // The defaults below are all Claude aliases. With the CLI known down they
  // would fail every call, so the tier falls back to the same local roster —
  // and returns to the cloud defaults the moment the CLI is back.
  if (cloudFallback()) return localAliasFor(tier, kind);
  return DEFAULTS[tier];
}

const warned = new Set<string>();

/** One stderr line per alias per process: honoured, but the operator should know. */
export function warnDeprecated(alias: string, source: string): void {
  if (!DEPRECATED_ALIASES.has(alias) || warned.has(alias)) return;
  warned.add(alias);
  process.stderr.write(`foreman: '${alias}' (from ${source}) is deprecated — opus/sonnet are the defaults now; it still runs because you pinned it\n`);
}

/** Convenience snapshot of all three tiers at once, e.g. for `foreman doctor`. */
export const TIER_MODELS: Record<Tier, string> = {
  get owner(): string { return tierModel('owner'); },
  get senior(): string { return tierModel('senior'); },
  get worker(): string { return tierModel('worker'); },
};

const OWNER_ROLES = new Set(['owner', 'planner', 'publisher', 'pi', 'ic-chair']);
const SENIOR_ROLES = new Set([
  'senior', 'reviewer', 'dev-editor', 'pm', 'senior-analyst', 'researcher',
  'internal-reviewer', 'peer-reviewer',
]);

/** Playbooks define arbitrary role strings; this is only the tier fallback for roles they don't map explicitly. */
export function tierForRole(role: string | null): Tier {
  if (role && OWNER_ROLES.has(role)) return 'owner';
  if (role && SENIOR_ROLES.has(role)) return 'senior';
  return 'worker';
}

/**
 * Model resolution order: an explicit agent's own model wins (it may pin a
 * specific alias regardless of role), then a playbook's own tier for that
 * role (a crew ticket), then the generic role→tier fallback. Null means "let
 * the runner use its own default."
 *
 * `catalog` is an optional prefetched playbook catalog (from loadPlaybooks()):
 * a caller resolving many tasks at once (server.ts's snapshot(), one call per
 * task in the board's task list) should load the catalog once and pass it
 * here for every task, rather than let each call hit getPlaybook() — which is
 * itself cached now (see playbooks.ts), but a fetch-once-reuse-across-the-map
 * is still one array scan short of a map lookup per task instead of a cache
 * lookup. Omitted, this falls back to the single-task getPlaybook() path.
 */
export function modelForTask(
  task: Pick<Task, 'agent' | 'role' | 'playbook'> & Partial<Pick<Task, 'kind'>>,
  catalog?: PlaybookCatalog,
): string | null {
  if (task.agent) {
    const model = getAgent(task.agent)?.model;
    if (model) {
      warnDeprecated(model, `agent ${task.agent}`);
      return model;
    }
  }
  // A persona trained for exactly this playbook role, and only once it has
  // been adopted — beaten the model it replaces on the golden set, the safety
  // probes and a blind A/B. An explicit agent pin still outranks it: that is
  // the operator naming a model on purpose.
  const persona = personaForTask({ playbook: task.playbook ?? null, role: task.role ?? null });
  if (persona?.alias) return persona.alias;
  if (task.playbook && task.role) {
    const pb = catalog ? catalog.playbooks.find((p) => p.id === task.playbook) ?? null : getPlaybook(task.playbook);
    const roleDef = pb?.roles[task.role];
    if (roleDef) return tierModel(roleDef.tier, task.kind);
  }
  if (task.role) return tierModel(tierForRole(task.role), task.kind);
  return null;
}

/**
 * The tier a task's crew role resolves to, or null when it has no role at all.
 * Null is "not a crew ticket": the caller must leave the runner's own defaults
 * alone rather than invent a tier for it.
 */
export function tierForTask(task: Pick<Task, 'role' | 'playbook'>, catalog?: PlaybookCatalog): Tier | null {
  if (!task.role) return null;
  if (task.playbook) {
    const pb = catalog ? catalog.playbooks.find((p) => p.id === task.playbook) ?? null : getPlaybook(task.playbook);
    const roleDef = pb?.roles[task.role];
    if (roleDef) return roleDef.tier;
  }
  return tierForRole(task.role);
}

/**
 * Turn ceiling for one agentic CLI run, by tier. An uncapped run is the tail
 * that eats a subscription: a worker that has lost the thread keeps taking
 * turns until the task deadline. Seniors get more because they take the bigger
 * tickets; owner-tier work is rarer and sized like a senior's.
 */
const MAX_TURNS: Record<Tier, number> = { owner: 40, senior: 40, worker: 30 };
const MAX_TURNS_ENV: Record<Tier, string> = {
  owner: 'FOREMAN_MAX_TURNS_OWNER',
  senior: 'FOREMAN_MAX_TURNS_SENIOR',
  worker: 'FOREMAN_MAX_TURNS_WORKER',
};

/** Env read lazily, like tierModel, so a test or an operator can flip it per case. */
export function tierMaxTurns(tier: Tier): number {
  // Owner has its own knob, but falls back to the senior one when it is unset:
  // owner-tier runs shared FOREMAN_MAX_TURNS_SENIOR before this existed, so an
  // operator who set that keeps the cap they already had.
  const set = process.env[MAX_TURNS_ENV[tier]] ?? (tier === 'owner' ? process.env['FOREMAN_MAX_TURNS_SENIOR'] : undefined);
  const raw = Number(set);
  return set !== undefined && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : MAX_TURNS[tier];
}


/**
 * The tools this role is expected to reach for, written into its prompt.
 *
 * A toolbox nobody is told about is a toolbox nobody uses. Ten book-relevant
 * tools sat in the catalog — prose-gate, numeral-tic, continuity-check,
 * find-artifacts, book-lint — while every drafting ticket went out mentioning
 * none of them, so each run either rediscovered them or, far more often, did
 * the job by hand and less well.
 *
 * A tool the playbook names but the catalog does not have is reported as
 * MISSING rather than silently dropped, with the instruction to build it. That
 * is the difference between a stale playbook and a standing request: the forge
 * already exists (`build_tool` queues a real, tested, human-approved tool), and
 * a role that keeps needing something absent is exactly the signal that should
 * reach it.
 */
/**
 * Tools a playbook asks for that the catalog does not have.
 *
 * Reported rather than refused. A playbook naming an absent tool is not
 * broken — it is a standing request, and the forge exists to answer it
 * (`build_tool` queues a real tool that must pass its own tests, survive an
 * admission scan of every source file, and be approved by a human before it is
 * registered). Refusing the playbook would throw away the request; silently
 * dropping the line would lose it. Both are worse than saying so.
 */
export function missingTools(pb: Playbook): MissingTool[] {
  const out: MissingTool[] = [];
  for (const [role, wanted] of Object.entries(pb.tools)) {
    for (const t of wanted) {
      if (!getTool(t.name)) out.push({ playbook: pb.id, role, tool: t.name, when: t.when });
    }
  }
  return out;
}

/**
 * The tools a role is told about. The api runner can call the catalog (use_tool, build_tool); a claude-code worker
 * cannot — it runs with an empty, strict MCP config and a shell allowlist — so its brief says what is true: name
 * the tools, do the work by hand with the working shown, never claim a tool's result, and know that Foreman's own
 * checks run after it. Telling it to "call them with use_tool" sent it looking for a tool it does not have.
 */
export function toolBrief(pb: Playbook, role: string, runner: 'claude-code' | 'api' = 'api'): string {
  const wanted = pb.tools[role] ?? [];
  if (!wanted.length) return '';
  if (runner !== 'api') {
    const lines = wanted.map((t) => {
      const manifest = getTool(t.name);
      const what = manifest ? manifest.description.split('\n')[0]!.slice(0, 160) : 'not in the catalog';
      return `- ${t.name} — ${what}${t.when ? `\n    Its job: ${t.when}` : ''}`;
    });
    return (
      '\n\nTools Foreman keeps for this role. This session cannot call them (there is no use_tool here). Where a ' +
      'step would use one, do that work by hand, show the working, and say in your report which tool you stood in ' +
      'for; never claim a result a tool would have given. Foreman runs its own checks after you finish (the tests, ' +
      'the prose audit, the scope and secret checks) and sends their findings back as a repair round:\n' +
      lines.join('\n')
    );
  }
  const lines = wanted.map((t) => {
    const manifest = getTool(t.name);
    if (!manifest) {
      return `- ${t.name} — NOT IN THE CATALOG YET. Build it with build_tool before you need it` +
        `${t.when ? `, then use it ${t.when}` : ''}.`;
    }
    const quarantined = manifest.quarantined ? ' [QUARANTINED — do not use until released]' : '';
    return `- ${t.name}${quarantined} — ${manifest.description.split('\n')[0]!.slice(0, 160)}` +
      `${t.when ? `\n    Use it ${t.when}` : ''}`;
  });
  return (
    '\n\nTools for this role. Prefer these over doing the same work by hand — they are ' +
    'deterministic, free, and already agreed as the way this job is measured:\n' +
    lines.join('\n') +
    '\nCall them with use_tool. If one of these is missing or cannot do what you need, ' +
    'say so in your summary rather than working around it silently.'
  );
}

/**
 * Which text of a skill a worker on `model` is given: the short card for a
 * local model, the full procedure otherwise. Local is decided the way the
 * rest of Foreman decides it — the crew is on the local plane (local-only, or
 * the Claude CLI is down and auto mode fell back), or the alias is registered
 * as a local model. An alias nothing registers is a CLI alias: full.
 */
export function skillVariantFor(model: string | undefined | null): SkillVariant {
  if (crewRunner() === 'api') return 'card';
  return model && specs().get(model)?.local ? 'card' : 'full';
}

/**
 * Materialize a playbook role as an in-memory AgentDef — no files to keep in
 * sync with the playbook. `id` is namespaced `crew:<playbook>:<role>` so it
 * never collides with a catalog agent. Findings are the playbook's own
 * admission scan (already run at load time), reused rather than re-scanned.
 */
export function roleAgent(
  pb: Playbook,
  role: string,
  opts: { skills?: readonly string[] | null; runner?: 'claude-code' | 'api' } = {},
): AgentDef {
  const roleDef = pb.roles[role];
  if (!roleDef) throw new Error(`playbook '${pb.id}' has no role '${role}'`);
  const model = tierModel(roleDef.tier);
  const variant = skillVariantFor(model);
  // A local-tier worker gets the role's short card when the playbook has one (the same rule that serves a
  // skill's card.md): a long process prompt is harder for a small model to follow. No card: the full prompt.
  const prompt = (variant === 'card' ? pb.roleCards?.[role] : undefined) ?? pb.rolePrompts[role] ?? '';
  const constraints = pb.constraints.length
    ? `\n\nHard constraints:\n${pb.constraints.map((c) => `- ${c}`).join('\n')}`
    : '';
  return {
    id: `crew:${pb.id}:${role}`,
    description: `${pb.id} playbook — ${role}`,
    // Skills trail the tools: '' with FOREMAN_SKILLS_DIR unset or no skill to
    // serve, so the prompt is then exactly what it was before skills existed.
    systemPrompt: `${prompt}${constraints}${toolBrief(pb, role, opts.runner ?? crewRunner())}${skillBrief(pb, role, variant, opts.skills)}`,
    model,
    // The hosted CLI dies with the subscription; in local-only mode every crew
    // ticket runs on the one runner that speaks the local plane (local-only policy).
    runner: crewRunner(),
    source: pb.source,
    findings: pb.findings,
  };
}

/**
 * The message of the `skills` event a run starts with: what the brief of this
 * ticket carries (the same selection roleAgent renders), as JSON. Null when
 * there is nothing to say — skills are off, or the ticket is not an agent-less
 * playbook role. Never throws: it sits on the launch path of every ticket.
 */
export function skillsRunEvent(task: Pick<Task, 'playbook' | 'role' | 'agent' | 'skills'>, resumed = false): string | null {
  try {
    if (!loadSkills().dir || !task.playbook || !task.role || task.agent) return null;
    const pb = getPlaybook(task.playbook);
    const roleDef = pb?.roles[task.role];
    if (!pb || !roleDef) return null;
    return skillsRunRecord(pb, task.role, skillVariantFor(tierModel(roleDef.tier)), task.skills, resumed);
  } catch {
    return null;
  }
}

/**
 * What a resumed repair round adds about skills. The session already holds
 * the brief its first round was given, skills and all, so nothing is re-sent
 * while they are the same — the resumed brief stays the critique alone. When
 * they are not (the operator requeued the ticket with other skills, or one
 * was retired between rounds) the session would go on working to procedures
 * the ticket no longer carries, so the block as it is now is sent, once, with
 * a line saying it replaces the earlier one.
 *
 * "The same" is read from the last `skills` event on the ticket, which the
 * run being resumed wrote. If that event is gone (events are pruned per
 * ticket) a ticket with its own list is sent its block again, and a ticket on
 * its role's default is sent nothing, as before this existed.
 */
export function resumedSkillsBrief(store: Pick<Store, 'db'>, task: Pick<Task, 'id' | 'playbook' | 'role' | 'agent' | 'skills'>): string {
  try {
    const now = skillsRunEvent(task);
    if (!now || !task.playbook || !task.role) return '';
    const row = store.db
      .prepare("SELECT message FROM events WHERE task_id = ? AND type = 'skills' ORDER BY id DESC LIMIT 1")
      .get(task.id) as { message?: unknown } | undefined;
    const current = JSON.parse(now) as { skills: string[]; variant: string };
    let earlier: { skills?: unknown; variant?: unknown } | null = null;
    try {
      earlier = row ? (JSON.parse(String(row.message)) as { skills?: unknown; variant?: unknown }) : null;
    } catch {
      earlier = null;
    }
    if (earlier ? JSON.stringify([earlier.skills, earlier.variant]) === JSON.stringify([current.skills, current.variant]) : !task.skills?.length) return '';
    const pb = getPlaybook(task.playbook)!;
    const block = skillBlock(pb, task.role, current.variant === 'card' ? 'card' : 'full', task.skills);
    return (
      '\n---\nThe skills for this ticket are not the ones this session began with. ' +
      (block ? `These replace any you were given earlier:\n\n${block}` : 'The ones you were given earlier no longer apply to it.')
    );
  } catch {
    return '';
  }
}
