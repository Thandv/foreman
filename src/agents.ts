import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import type { Finding } from './security/admit.ts';
import { admit, AdmissionBlocked } from './security/admit.ts';
import { probeTask } from './types.ts';

export interface AgentDef {
  id: string;
  description: string;
  /** Prepended to the worker brief. */
  systemPrompt: string;
  /**
   * Model for whichever runner executes the task: a Foreman alias
   * (local-code…) for the api runner, or a CLI alias (sonnet, opus, fable)
   * for claude-code. The two vocabularies don't overlap, so a def pinned to
   * one runner's alias should also pin `runner`.
   */
  model?: string;
  runner?: string;
  source: string;
  findings: Finding[];
}

/**
 * Agent definitions live as JSON or Markdown-with-front-matter under
 * ~/.foreman/agents (override with FOREMAN_AGENTS_DIR — point it at another
 * catalog's build output to consume it). Every definition is admission-scanned
 * at load, and a blocking finding drops the agent from the catalog entirely
 * rather than leaving it selectable.
 */
function parseMarkdown(text: string, file: string): AgentDef | null {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) return null;
  const meta: Record<string, string> = {};
  for (const line of fm[1]!.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (m) meta[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  if (!meta['name']) return null;
  return {
    id: meta['name'],
    description: meta['description'] ?? '',
    systemPrompt: fm[2]!.trim(),
    model: meta['model'],
    runner: meta['runner'],
    source: file,
    findings: [],
  };
}

function scan(def: AgentDef): Finding[] {
  // Reuse the task scanner by shaping the agent as a probe task.
  return admit(probeTask({ id: `agent:${def.id}`, title: def.id, prompt: def.systemPrompt }));
}

export function agentsDir(): string {
  return process.env['FOREMAN_AGENTS_DIR'] ?? path.join(config.home, 'agents');
}

export interface Catalog {
  agents: AgentDef[];
  refused: Array<{ id: string; reason: string }>;
}

/**
 * loadCatalog() sits on the /api/state hot path (roles.ts:modelForTask ->
 * getAgent, once per agent-pinned task per snapshot), and every definition it
 * parses costs an admission scan — a `frisk-scan` spawn, failed or not. Cache
 * the catalog per agents-dir on a cheap fingerprint, as playbooks.ts does: a
 * statSync sweep every call, a re-parse and re-scan only when a definition
 * was changed, added or removed. Nothing in this file writes a definition, so
 * nothing here clears it.
 *
 * What is cached reaches the api runner's system prompt and model pin, so the
 * cache must not serve a definition the disk no longer holds:
 *  - the fingerprint is name:ino:mtimeMs:ctimeMs:size:mode per entry. mtime
 *    and size alone miss a same-length rewrite whose mtime was put back
 *    (`touch -r`) and miss a chmod; ctime cannot be set from userland, and
 *    mode is what decides whether the file can be read at all.
 *  - an entry is a miss once it is CATALOG_TTL_MS old, whatever the
 *    fingerprint says. The admission verdict depends on which `frisk-scan` is
 *    on PATH, which no stat of this directory can see; a scanner installed or
 *    removed is applied within the minute, at one re-scan a minute.
 * A hit returns the same object, deep-frozen: a caller that tries to mutate
 * it throws instead of leaking the change into every later caller.
 */
export const CATALOG_TTL_MS = 60_000;

const catalogCache = new Map<string, { fingerprint: string | null; loadedAt: number; catalog: Catalog }>();

/** Force the next loadCatalog() to re-read from disk. */
export function clearAgentCache(): void {
  catalogCache.clear();
}

/** Null when the dir does not exist, so that state is distinguishable from an empty dir. */
function fingerprintDir(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const parts: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.(json|md)$/.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      parts.push(`${name}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.mode}`);
    } catch {
      parts.push(`${name}:unreadable`);
    }
  }
  return parts.join('|');
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function loadCatalog(): Catalog {
  const dir = agentsDir();
  const fingerprint = fingerprintDir(dir);
  const cached = catalogCache.get(dir);
  // Date.now() so a test can drive the clock with node:test mock timers. A
  // clock that stepped backwards is a miss too, not an entry that never ages.
  const now = Date.now();
  const age = cached ? now - cached.loadedAt : 0;
  if (cached && cached.fingerprint === fingerprint && age >= 0 && age < CATALOG_TTL_MS) return cached.catalog;

  const catalog = deepFreeze(loadCatalogFrom(dir));
  catalogCache.set(dir, { fingerprint, loadedAt: now, catalog });
  return catalog;
}

function loadCatalogFrom(dir: string): Catalog {
  const agents: AgentDef[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  if (!fs.existsSync(dir)) return { agents, refused };

  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (!/\.(json|md)$/.test(name)) continue;
    let def: AgentDef | null = null;
    try {
      // Stat lives inside this try too: loadCatalog runs on the scheduler's
      // hot path, and a dangling symlink or a permission error mid-readdir
      // must land the entry in `refused`, not throw out of the whole call.
      if (!fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (name.endsWith('.json')) {
        const raw = JSON.parse(text) as Partial<AgentDef>;
        if (raw.id && raw.systemPrompt) {
          def = {
            id: raw.id, description: raw.description ?? '', systemPrompt: raw.systemPrompt,
            model: raw.model, runner: raw.runner, source: file, findings: [],
          };
        }
      } else {
        def = parseMarkdown(text, file);
      }
    } catch (err) {
      refused.push({ id: name, reason: `unreadable: ${(err as Error).message}` });
      continue;
    }
    if (!def) {
      refused.push({ id: name, reason: 'missing id/name or body' });
      continue;
    }
    try {
      def.findings = scan(def);
      agents.push(def);
    } catch (err) {
      // Admission is non-overridable: a blocked agent is not in the catalog.
      refused.push({ id: def.id, reason: err instanceof AdmissionBlocked ? err.message : String(err) });
    }
  }
  return { agents, refused };
}

export function getAgent(id: string): AgentDef | null {
  return loadCatalog().agents.find((a) => a.id === id) ?? null;
}
