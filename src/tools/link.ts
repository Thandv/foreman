import fs from 'node:fs';
import path from 'node:path';
import { loadPlaybooks, playbooksDir } from '../playbooks.ts';

/**
 * Linking a newly built tool back to the playbook role that needed it.
 *
 * The forge could already build a tool on demand: a run decides it wants one,
 * `build_tool` queues a real tool task, it passes its own tests, survives an
 * admission scan and is approved by a human. And then nothing remembered. The
 * tool sat in the catalog unmentioned by any role, so the next epic of the same
 * shape rediscovered the same need and, as often as not, built it again or did
 * the work by hand.
 *
 * A tool built for a task today should be a habit tomorrow. That means writing
 * it onto the playbook, which is a configuration change — so it happens at
 * exactly one moment: when a human approves the tool task. The approval is
 * already the human decision that registers the tool; riding it is what keeps
 * this from being a background process editing the operator's config.
 *
 * Failure is never fatal to the approval. A tool that registered and did not
 * link is a working tool with a missing habit; refusing the approval over it
 * would trade something that matters for something that does not.
 */

export interface LinkResult {
  linked: boolean;
  reason: string;
}

/** Where a tool task records who wanted it. Set by the planner and by build_tool. */
export interface ToolRequest {
  playbook: string;
  role: string;
  when: string;
}

/**
 * Parse `for <playbook>.<role>: <when>` out of a tool task's prompt.
 *
 * A convention rather than a column, because a tool task can be queued by hand,
 * by the planner, or by a worker calling `build_tool`, and a line of text is
 * the one channel all three already have.
 */
export function parseToolRequest(prompt: string): ToolRequest | null {
  const m = prompt.match(/^\s*for\s+([a-z][a-z0-9-]{1,40})\.([a-z][a-z0-9-]{1,40})\s*:\s*(.+)$/im);
  if (!m) return null;
  return { playbook: m[1]!, role: m[2]!, when: m[3]!.trim().slice(0, 240) };
}

/**
 * Add a tool to a playbook role's list, in the playbook file itself.
 *
 * Re-reads and re-validates through `loadPlaybooks` afterwards and rolls the
 * file back if the result no longer parses. A playbook that fails to load is
 * not a degraded playbook — it is dropped from the catalog entirely, and every
 * ticket that would have used it loses its roles, its reviewers and its gate
 * policy. That is far worse than never having linked the tool.
 */
export function linkToolToPlaybook(tool: string, req: ToolRequest): LinkResult {
  const dir = playbooksDir();
  const file = path.join(dir, `${req.playbook}.md`);
  if (!fs.existsSync(file)) return { linked: false, reason: `no playbook file at ${file}` };

  const before = fs.readFileSync(file, 'utf8');
  const fm = before.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) return { linked: false, reason: 'playbook has no JSON front matter' };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fm[1]!) as Record<string, unknown>;
  } catch (err) {
    return { linked: false, reason: `playbook front matter is not JSON: ${(err as Error).message}` };
  }

  const roles = (parsed['roles'] ?? {}) as Record<string, unknown>;
  if (!Object.hasOwn(roles, req.role)) {
    return { linked: false, reason: `playbook '${req.playbook}' has no role '${req.role}'` };
  }

  const tools = (parsed['tools'] ?? {}) as Record<string, unknown[]>;
  const list = Array.isArray(tools[req.role]) ? tools[req.role]! : [];
  const already = list.some((t) => (typeof t === 'string' ? t : (t as { name?: string })?.name) === tool);
  if (already) return { linked: false, reason: `already linked to ${req.playbook}.${req.role}` };

  tools[req.role] = [...list, { name: tool, when: req.when }];
  parsed['tools'] = tools;

  fs.writeFileSync(file, `---\n${JSON.stringify(parsed, null, 2)}\n---\n${fm[2] ?? ''}`);

  // Prove the edit did not break the playbook before leaving it on disk.
  const catalog = loadPlaybooks();
  const stillLoads = catalog.playbooks.some((p) => p.id === req.playbook);
  if (!stillLoads) {
    fs.writeFileSync(file, before);
    loadPlaybooks();
    const why = catalog.refused.find((r) => r.id === req.playbook)?.reason ?? 'it no longer loads';
    return { linked: false, reason: `rolled back: linking would have broken the playbook — ${why}` };
  }

  return { linked: true, reason: `linked '${tool}' to ${req.playbook}.${req.role}` };
}
