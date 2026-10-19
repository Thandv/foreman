import type { Broker } from '../budget.ts';
import { extractJson, pickAlias } from '../models.ts';
import type { Store } from '../queue.ts';
import { listTools, searchTools } from '../tools/catalog.ts';
import { toolBrief, toolSurface } from '../tools/forge.ts';
import type { Sensitivity, Task, TaskKind } from '../types.ts';

export interface PlanNode {
  /** Plan-local id (`n1`), resolved to real task ids at queue time. */
  ref: string;
  title: string;
  prompt: string;
  kind: TaskKind;
  runner: Task['runner'];
  repo: string | null;
  after: string[];
  /** Set when this node is a tool build the planner asked for. */
  buildsTool: string | null;
  reason: string;
}

export interface Plan {
  ask: string;
  nodes: PlanNode[];
  reusedTools: string[];
  notes: string;
  /** True when the planner model was unreachable and this is the fallback. */
  degraded: boolean;
}

export interface PlanOptions {
  ask: string;
  store: Store;
  broker: Broker;
  repo?: string | null;
  sensitivity?: Sensitivity;
  runner?: Task['runner'];
  signal?: AbortSignal;
}

const KINDS: TaskKind[] = ['code', 'writing', 'research', 'general', 'tool'];
const RUNNERS: Task['runner'][] = ['echo', 'shell', 'claude-code', 'codex-cli', 'api'];

const SYSTEM = `You turn a request into a small execution plan for a task runner.
Reply with JSON only:
{"notes":"one sentence on the approach",
 "nodes":[{"ref":"n1","title":"short imperative title","prompt":"the full brief for the worker",
           "kind":"code|writing|research|general","after":[],"needsTool":null,"reason":"why this step"}]}
Rules:
- Prefer ONE node. Add nodes only when a step genuinely cannot start until an earlier one finishes.
- Never exceed 5 nodes. "after" lists the refs this node waits on.
- "prompt" is read by a worker with no other context: restate everything it needs.
- If an existing tool from the catalog does the job, say so in "reason" and do NOT ask for a new one.
- Set "needsTool" to a short kebab-case name ONLY if a reusable tool must be built first.
Example of a request that needs a tool it does not have:
{"notes":"build the converter, then run it",
 "nodes":[{"ref":"n1","title":"Convert data.csv to a pivot table","prompt":"Use the csv-pivot tool on data.csv and save the result.",
           "kind":"general","after":[],"needsTool":"csv-pivot","reason":"the catalog has no csv pivot tool"}]}
Do NOT describe building the tool in a node's prompt — that is what "needsTool" is for.`;

/** A tool name from whatever the planner gave us: field, else the title. */
function toolNameFrom(candidate: string, title: string): string | null {
  const source = candidate || title;
  const slug = source
    .toLowerCase()
    .replace(/\b(build|create|make|a|an|the|reusable|new|tool|utility|script)\b/g, ' ')
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return /^[a-z][a-z0-9-]{1,39}$/.test(slug) ? slug : null;
}

/** The single-node plan used when the planner is unreachable or unusable. */
function fallback(opts: PlanOptions, reason: string): Plan {
  return {
    ask: opts.ask,
    nodes: [{
      ref: 'n1',
      title: opts.ask.length > 70 ? `${opts.ask.slice(0, 67)}…` : opts.ask,
      prompt: opts.ask,
      kind: opts.repo ? 'code' : 'general',
      runner: opts.runner ?? 'api',
      repo: opts.repo ?? null,
      after: [],
      buildsTool: null,
      reason,
    }],
    reusedTools: [],
    notes: reason,
    degraded: true,
  };
}

/**
 * Decompose an ask into a task DAG. Planning is advisory: the plan is shown
 * and only becomes tasks when the human confirms, so a bad plan costs a glance
 * rather than a run.
 */
export async function planAsk(opts: PlanOptions): Promise<Plan> {
  const { ask, broker } = opts;
  if (!ask.trim()) throw new Error('ask cannot be empty');

  const sensitivity = opts.sensitivity ?? 'S1';
  const candidates = searchTools(ask).filter((t) => !t.quarantined);
  const catalogue = candidates.length ? candidates : listTools().filter((t) => !t.quarantined);

  let alias: string;
  try {
    alias = pickAlias(['local-reason', 'local-general', 'local-fast'], sensitivity);
  } catch (err) {
    return fallback(opts, `no planner model available (${(err as Error).message}); queued as a single task`);
  }

  let text: string;
  try {
    const res = await broker.call({
      taskId: null,
      runId: null,
      kind: 'plan',
      alias,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            `REQUEST: ${ask}\n\n` +
            (opts.repo ? `TARGET REPO: ${opts.repo}\n\n` : '') +
            `TOOLS ALREADY AVAILABLE (reuse these before asking for new ones):\n${toolSurface(catalogue.slice(0, 15))}`,
        },
      ],
      sensitivity,
      maxTokens: 1200,
      json: true,
      signal: opts.signal,
    });
    text = res.text;
  } catch (err) {
    return fallback(opts, `planner unavailable (${(err as Error).message.slice(0, 160)}); queued as a single task`);
  }

  const parsed = extractJson<{ notes?: string; nodes?: unknown }>(text);
  // `nodes` is model output: it may be a scalar, a string, or an array of
  // nulls/scalars. Anything that is not an array of objects is not a plan, so
  // it falls back gracefully rather than throwing out of the parse.
  const rawNodes = Array.isArray(parsed?.nodes) ? (parsed!.nodes as unknown[]) : [];
  if (!rawNodes.length) return fallback(opts, 'planner did not return a usable plan; queued as a single task');

  const nodes: PlanNode[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of rawNodes.slice(0, 5).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const title = String(raw['title'] ?? '').trim();
    const prompt = String(raw['prompt'] ?? '').trim();
    if (!title || !prompt) continue;
    const ref = String(raw['ref'] ?? `n${i + 1}`);
    if (seen.has(ref)) continue;
    seen.add(ref);
    let kind = KINDS.includes(raw['kind'] as TaskKind) ? (raw['kind'] as TaskKind) : opts.repo ? 'code' : 'general';
    // Prose like "Build a reusable X tool" is a tool build however it is labelled.
    if (kind !== 'tool' && /\b(build|create|write|make)\b[^.]{0,40}\b(reusable|new)?\s*\btool\b/i.test(`${title} ${prompt.slice(0, 200)}`)) {
      kind = 'tool';
    }
    const runner = RUNNERS.includes(raw['runner'] as Task['runner'])
      ? (raw['runner'] as Task['runner'])
      : opts.runner ?? 'api';
    let needsTool = typeof raw['needsTool'] === 'string' ? raw['needsTool'].trim() : '';

    // A planner that describes a tool build as an ordinary node still has to
    // produce the tool layout, so normalise it into a real tool node.
    if (kind === 'tool') {
      const name = toolNameFrom(needsTool, title);
      if (name) {
        nodes.push({
          ref, title: `Build tool: ${name}`,
          prompt: toolBrief({ name, description: title, spec: prompt }),
          kind: 'tool', runner: 'api', repo: null,
          after: (Array.isArray(raw['after']) ? (raw['after'] as unknown[]) : []).map(String),
          buildsTool: name,
          reason: String(raw['reason'] ?? 'the catalog has no such tool'),
        });
        continue;
      }
      // No usable name means no usable build brief; a 'tool' node without one
      // would fail its structural check, so it is not a tool node at all.
      needsTool = '';
      kind = opts.repo ? 'code' : 'general';
    }
    nodes.push({
      ref,
      title: title.slice(0, 120),
      prompt,
      kind,
      runner,
      repo: opts.repo ?? null,
      // Only keep edges that point at nodes we actually kept.
      after: (Array.isArray(raw['after']) ? (raw['after'] as unknown[]) : []).map(String),
      buildsTool: null,
      reason: String(raw['reason'] ?? ''),
    });

    // A requested tool becomes a real build node the work then depends on.
    if (needsTool && /^[a-z][a-z0-9-]{1,39}$/.test(needsTool) && !catalogue.some((t) => t.name === needsTool)) {
      const buildRef = `${ref}-tool`;
      nodes.push({
        ref: buildRef,
        title: `Build tool: ${needsTool}`,
        prompt: toolBrief({ name: needsTool, description: `tool for: ${title}`, spec: prompt }),
        kind: 'tool',
        runner: 'api',
        repo: null,
        after: [],
        buildsTool: needsTool,
        reason: `${ref} needs a '${needsTool}' tool that the catalog does not have`,
      });
      nodes[nodes.length - 2]!.after.push(buildRef);
    }
  }

  if (!nodes.length) return fallback(opts, 'planner returned no usable nodes; queued as a single task');

  const refs = new Set(nodes.map((n) => n.ref));
  for (const node of nodes) node.after = [...new Set(node.after.filter((a) => refs.has(a) && a !== node.ref))];

  return {
    ask,
    nodes: topoSort(nodes),
    reusedTools: catalogue.filter((t) => text.includes(t.name)).map((t) => t.name),
    notes: String(parsed?.notes ?? '').slice(0, 500),
    degraded: false,
  };
}

/**
 * Dependencies must exist before their dependents, because the queue only
 * accepts edges pointing backwards. A cycle (or anything unorderable) is
 * flattened rather than rejected — a plan is a suggestion, not a contract.
 */
export function topoSort<T extends { ref: string; after: string[] }>(nodes: T[]): T[] {
  // Generic over the node shape so crew tickets (crewPlan.ts) order through
  // this exact code rather than a second copy of it.
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const out: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (node: T): void => {
    const mark = state.get(node.ref);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      // Cycle: drop the edge that closed it rather than looping forever.
      node.after = [];
      return;
    }
    state.set(node.ref, 'visiting');
    for (const ref of node.after) {
      const dep = byRef.get(ref);
      if (dep) visit(dep);
    }
    state.set(node.ref, 'done');
    out.push(node);
  };
  for (const node of nodes) visit(node);
  return out;
}

export interface QueueResult {
  tasks: Task[];
  plan: Plan;
}

/** Turn a confirmed plan into real tasks, wiring plan refs to task ids. */
export function queuePlan(store: Store, plan: Plan, extra: Partial<Task> = {}): QueueResult {
  const ids = new Map<string, string>();
  const tasks: Task[] = [];
  for (const node of topoSort(plan.nodes)) {
    const task = store.addTask({
      title: node.title,
      prompt: node.prompt,
      kind: node.kind,
      runner: node.runner,
      repo: node.repo,
      sensitivity: (extra.sensitivity as Sensitivity) ?? 'S1',
      budgetUsd: extra.budgetUsd ?? null,
      priority: extra.priority ?? 0,
      deps: node.after.map((ref) => ids.get(ref)).filter((id): id is string => Boolean(id)),
    });
    ids.set(node.ref, task.id);
    tasks.push(task);
  }
  return { tasks, plan };
}
