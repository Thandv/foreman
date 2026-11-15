import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { processAlive } from '../lock.ts';
import { admit, AdmissionBlocked, type Finding } from '../security/admit.ts';
import { validate, type Schema } from './schema.ts';
import { probeTask } from '../types.ts';

export interface ToolManifest {
  name: string;
  description: string;
  input: Schema;
  output: Schema;
  entry: string;
  runtime: 'node' | 'python';
  version: number;
  provenance: { taskId: string | null; runId: string | null; model: string | null; date: string };
  admit: { scannedAt: string; findings: Finding[] };
  stats: { calls: number; failures: number; consecutiveFailures: number; lastUsed: string | null };
  quarantined: boolean;
  quarantineReason: string | null;
}

export class ToolError extends Error {}

/** The static, version-controllable half of a manifest — no runtime state. */
type StaticManifest = Omit<ToolManifest, 'stats' | 'quarantined' | 'quarantineReason'>;

interface ToolState {
  stats: ToolManifest['stats'];
  quarantined: boolean;
  quarantineReason: string | null;
}

/** Names are directory names and appear in prompts: keep them boring. */
const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const QUARANTINE_AFTER = Number(process.env['FOREMAN_TOOL_QUARANTINE_AFTER'] ?? 3);

/**
 * The catalog directory. Defaults to the git-tracked `toolbox/` in the repo so
 * Foreman can use and improve its own tools; `FOREMAN_TOOLS_DIR` overrides it
 * outright (used in tests), and `FOREMAN_TOOLBOX`/`config.toolbox` sets the
 * default. Only tool SOURCE lives here — usage stats and quarantine state are
 * kept out, in `home`, so the toolbox stays clean for version control.
 */
export function toolsDir(): string {
  return process.env['FOREMAN_TOOLS_DIR'] ?? process.env['FOREMAN_TOOLBOX'] ?? config.toolbox;
}

/** Where mutable per-tool state lives — deliberately outside the toolbox. */
function statePath(): string {
  return path.join(config.home, 'tool-state.json');
}

/** A lock older than this is abandoned whoever holds it: a state write takes milliseconds. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 10;
const lockSleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * The whole state file. A missing file is no state; a file that exists but
 * cannot be read as a JSON object is an error, never "no state": reading it as
 * empty let the next write drop every tool's entry, quarantines included.
 */
function readAllState(): Record<string, ToolState> {
  const file = statePath();
  const unreadable = (detail: string): ToolError =>
    new ToolError(`${file} is unreadable (${detail}); move it aside to start tool state afresh: mv ${file} ${file}.corrupt`);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw unreadable((err as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw unreadable((err as Error).message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unreadable('not a JSON object');
  return parsed as Record<string, ToolState>;
}

export function defaultState(): ToolState {
  return { stats: { calls: 0, failures: 0, consecutiveFailures: 0, lastUsed: null }, quarantined: false, quarantineReason: null };
}

/** A lock is stale when it is older than LOCK_STALE_MS or its recorded pid is dead. */
function lockIsStale(file: string): boolean {
  let mtimeMs: number;
  let holder: string;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
    holder = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; // released meanwhile: just retry
    throw err;
  }
  if (Date.now() - mtimeMs > LOCK_STALE_MS) return true;
  // An empty file is a holder between its O_EXCL create and its write, not a dead one.
  const pid = Number(holder.split(' ')[0]);
  return Number.isInteger(pid) && pid > 0 && !processAlive(pid);
}

/**
 * Take `tool-state.json.lock` (O_CREAT|O_EXCL), waiting for a live holder and
 * reclaiming a stale one. The CLI and the daemon both write tool state, so an
 * unlocked read-modify-write lost one side's update. Returns the release.
 */
function lockState(): () => void {
  const file = `${statePath()}.lock`;
  const token = `${process.pid} ${crypto.randomBytes(8).toString('hex')}\n`;
  for (;;) {
    try {
      fs.writeFileSync(file, token, { flag: 'wx' });
      return () => {
        let held: string;
        try {
          held = fs.readFileSync(file, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw err;
        }
        // Never remove a lock that was reclaimed from us and taken by another writer.
        if (held === token) fs.rmSync(file);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (lockIsStale(file)) fs.rmSync(file, { force: true });
    else Atomics.wait(lockSleeper, 0, 0, LOCK_POLL_MS);
  }
}

/** Replace the state file whole: write an O_EXCL temp file, then rename it over. */
function replaceState(all: Record<string, ToolState>): void {
  const file = statePath();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeSync(fd, `${JSON.stringify(all, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Read-modify-write the state file under its lock; `change` returns false when nothing changed. */
function updateState(change: (all: Record<string, ToolState>) => boolean): void {
  fs.mkdirSync(config.home, { recursive: true });
  const release = lockState();
  try {
    const all = readAllState();
    if (change(all)) replaceState(all);
  } finally {
    release();
  }
}

function writeState(name: string, state: ToolState): void {
  updateState((all) => {
    all[name] = state;
    return true;
  });
}

function clearState(name: string): void {
  updateState((all) => {
    if (!(name in all)) return false;
    delete all[name];
    return true;
  });
}

export function assertName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new ToolError(`invalid tool name '${name}': use lowercase letters, digits and dashes (2-40 chars)`);
  }
  return name;
}

function manifestPath(name: string): string {
  return path.join(toolsDir(), assertName(name), 'manifest.json');
}

function normalise(raw: Partial<ToolManifest>, name: string): ToolManifest {
  return {
    name,
    description: String(raw.description ?? ''),
    input: (raw.input ?? { type: 'object' }) as Schema,
    output: (raw.output ?? {}) as Schema,
    entry: String(raw.entry ?? (raw.runtime === 'python' ? 'tool.py' : 'tool.js')),
    runtime: raw.runtime === 'python' ? 'python' : 'node',
    version: Number(raw.version ?? 1),
    provenance: {
      taskId: raw.provenance?.taskId ?? null,
      runId: raw.provenance?.runId ?? null,
      model: raw.provenance?.model ?? null,
      date: raw.provenance?.date ?? new Date().toISOString(),
    },
    admit: { scannedAt: raw.admit?.scannedAt ?? new Date().toISOString(), findings: raw.admit?.findings ?? [] },
    stats: {
      calls: Number(raw.stats?.calls ?? 0),
      failures: Number(raw.stats?.failures ?? 0),
      consecutiveFailures: Number(raw.stats?.consecutiveFailures ?? 0),
      lastUsed: raw.stats?.lastUsed ?? null,
    },
    quarantined: Boolean(raw.quarantined),
    quarantineReason: raw.quarantineReason ?? null,
  };
}

export function getTool(name: string): ToolManifest | null {
  let file: string;
  try {
    file = manifestPath(name);
  } catch {
    return null; // an invalid name is simply not in the catalog
  }
  if (!fs.existsSync(file)) return null;
  let base: ToolManifest;
  try {
    base = normalise(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ToolManifest>, name);
  } catch {
    return null;
  }
  // Overlay mutable state from home. A tool predating the split keeps whatever
  // stats its manifest still carries (the legacy read path), until its next use
  // moves them out to the state file.
  let state: ToolState | undefined;
  try {
    state = readAllState()[name];
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    // Unreadable state cannot vouch that a tool is not quarantined: fail closed.
    base.quarantined = true;
    base.quarantineReason = err.message;
    return base;
  }
  if (state) {
    base.stats = { ...base.stats, ...state.stats };
    base.quarantined = state.quarantined;
    base.quarantineReason = state.quarantineReason;
  }
  return base;
}

export function listTools(): ToolManifest[] {
  const dir = toolsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => NAME_RE.test(n) && fs.existsSync(path.join(dir, n, 'manifest.json')))
    .map((n) => getTool(n))
    .filter((t): t is ToolManifest => t !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Keyword search over name + description. Embeddings can replace this later. */
export function searchTools(query: string): ToolManifest[] {
  const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (!terms.length) return listTools();
  const scored = listTools().map((tool) => {
    const hay = `${tool.name} ${tool.description}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (tool.name.toLowerCase().includes(term)) score += 3;
      else if (hay.includes(term)) score += 1;
    }
    return { tool, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.tool);
}

export function toolDir(name: string): string {
  return path.join(toolsDir(), assertName(name));
}

export function entryPath(tool: ToolManifest): string {
  const file = path.resolve(toolDir(tool.name), tool.entry);
  const root = path.resolve(toolDir(tool.name));
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new ToolError(`tool '${tool.name}' has an entry outside its own directory`);
  }
  return file;
}

/** Write ONLY the static half to the toolbox; runtime state never lands here. */
function writeManifest(m: ToolManifest): void {
  fs.mkdirSync(toolDir(m.name), { recursive: true });
  const staticFields: StaticManifest = {
    name: m.name,
    description: m.description,
    input: m.input,
    output: m.output,
    entry: m.entry,
    runtime: m.runtime,
    version: m.version,
    provenance: m.provenance,
    admit: m.admit,
  };
  fs.writeFileSync(manifestPath(m.name), `${JSON.stringify(staticFields, null, 2)}\n`);
}

export interface RegisterInput {
  /** Directory holding manifest.json, the entry file and any test/. */
  sourceDir: string;
  provenance?: Partial<ToolManifest['provenance']>;
}

/**
 * Copy a built tool into the catalog. The source is admission-scanned first —
 * a BLOCK finding refuses registration outright, exactly as it does for a task,
 * because a registered tool is code Foreman will run again unattended.
 */
export function registerTool(input: RegisterInput): ToolManifest {
  const src = path.resolve(input.sourceDir);
  const manifestFile = path.join(src, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new ToolError(`no manifest.json in ${src}`);

  let raw: Partial<ToolManifest>;
  try {
    raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Partial<ToolManifest>;
  } catch (err) {
    throw new ToolError(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  const name = assertName(String(raw.name ?? ''));
  if (!raw.description) throw new ToolError('manifest.json needs a description');

  const manifest = normalise(raw, name);
  const entry = path.resolve(src, manifest.entry);
  if (!entry.startsWith(src + path.sep) || !fs.existsSync(entry)) {
    throw new ToolError(`entry '${manifest.entry}' is missing from ${src}`);
  }

  // Scan every source file the tool ships, and the entry point whatever it is
  // called: `node tool.txt` runs it as CommonJS all the same.
  const sources = scannedFiles(src, entry);
  const findings: Finding[] = [];
  for (const file of sources) {
    findings.push(...scanSource(name, fs.readFileSync(file, 'utf8')));
  }

  const previous = getTool(name);
  manifest.version = previous ? previous.version + 1 : 1;
  // Usage history survives a re-registration; the fresh version starts un-quarantined.
  manifest.stats = previous?.stats ?? manifest.stats;
  manifest.quarantined = false;
  manifest.quarantineReason = null;
  manifest.admit = { scannedAt: new Date().toISOString(), findings };
  manifest.provenance = { ...manifest.provenance, ...input.provenance } as ToolManifest['provenance'];

  const dest = toolDir(name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  copyTree(src, dest);
  writeManifest(manifest);
  writeState(name, { stats: manifest.stats, quarantined: false, quarantineReason: null });
  return manifest;
}

function scanSource(name: string, text: string): Finding[] {
  return admit(probeTask({ id: `tool:${name}`, title: name, prompt: text, kind: 'tool' }));
}

/**
 * Re-run the admission scan over a tool's CURRENT sources on disk, independent
 * of whatever `admit.findings` its manifest.json happens to declare. registerTool
 * scans at registration time and freezes the result into the manifest; nothing
 * stops a hand-added or hand-edited tool's manifest from simply claiming zero
 * findings afterward. Callers that need to trust the scan result — not just the
 * self-report — should call this instead of reading `getTool(name).admit.findings`.
 */
export function rescanToolSources(name: string): Finding[] {
  const dir = toolDir(name);
  const tool = getTool(name);
  const findings: Finding[] = [];
  // Installed tree: nothing is skipped. registerTool never copies node_modules or
  // .git, so one found here was put there afterwards, and node resolves into it.
  for (const file of scannedFiles(dir, tool ? path.resolve(dir, tool.entry) : null, false)) {
    findings.push(...scanSource(name, fs.readFileSync(file, 'utf8')));
  }
  return findings;
}

/** Everything Node or Python will execute: Node 24 runs .mts/.cts by stripping types. */
const SOURCE_RE = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|py|pyw|sh)$/;
const MAX_TREE_DEPTH = 6;

/** The files an admission scan reads: every source file in the tree, plus the entry point. */
function scannedFiles(dir: string, entry: string | null, skipUncopied = true): string[] {
  const files = collectSources(dir, 0, skipUncopied);
  if (entry && !files.includes(entry) && fs.existsSync(entry) && fs.statSync(entry).isFile()) files.push(entry);
  return files;
}

/**
 * Every source file in a tool's tree. A tree nested deeper than the scan
 * reaches is refused outright: the scan used to stop at that depth silently
 * while copyTree copied everything, so a helper one level further down was
 * registered, and run, unscanned.
 */
function collectSources(dir: string, depth = 0, skipUncopied = true): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow a link out of the tree
    if (entry.isDirectory()) {
      if (skipUncopied && (entry.name === 'node_modules' || entry.name === '.git')) continue; // copyTree does not copy these either
      if (depth >= MAX_TREE_DEPTH) throw new ToolError(`tool tree is nested deeper than ${MAX_TREE_DEPTH} directories: ${full}`);
      out.push(...collectSources(full, depth + 1, skipUncopied));
    }
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

function copyTree(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * One-time move of a pre-toolbox catalog (`~/.foreman/tools`) into the tracked
 * `toolbox/`. Only runs when the default location is in use and the toolbox has
 * no tools yet; the legacy directory is left untouched. Each migrated manifest
 * is rewritten static-only, with its usage stats seeded into the state file, so
 * the toolbox lands clean for git. Returns the names it copied.
 */
export function migrateLegacyToolbox(): string[] {
  if (process.env['FOREMAN_TOOLS_DIR']) return []; // an explicit override owns its own layout
  const dest = process.env['FOREMAN_TOOLBOX'] ?? config.toolbox;
  const legacy = path.join(config.home, 'tools');
  if (path.resolve(legacy) === path.resolve(dest) || !fs.existsSync(legacy)) return [];

  const hasTool = (dir: string): boolean =>
    fs.existsSync(dir) &&
    fs.readdirSync(dir).some((n) => NAME_RE.test(n) && fs.existsSync(path.join(dir, n, 'manifest.json')));
  if (hasTool(dest)) return []; // never overwrite an existing toolbox

  const migrated: string[] = [];
  for (const name of fs.readdirSync(legacy)) {
    if (!NAME_RE.test(name)) continue;
    const from = path.join(legacy, name);
    if (!fs.existsSync(path.join(from, 'manifest.json'))) continue;
    const to = path.join(dest, name);
    fs.mkdirSync(to, { recursive: true });
    copyTree(from, to);
    try {
      const m = normalise(JSON.parse(fs.readFileSync(path.join(to, 'manifest.json'), 'utf8')) as Partial<ToolManifest>, name);
      writeManifest(m); // strip any embedded runtime state from the tracked copy
      writeState(name, { stats: m.stats, quarantined: m.quarantined, quarantineReason: m.quarantineReason });
    } catch {
      /* an unreadable legacy manifest is copied verbatim rather than dropped */
    }
    migrated.push(name);
  }
  return migrated;
}

export function removeTool(name: string): void {
  fs.rmSync(toolDir(name), { recursive: true, force: true });
  clearState(name);
}

/**
 * Book-keeping after a call. Repeated failure quarantines the tool. Only the
 * mutable state file is touched — the tool's source in the toolbox is not
 * rewritten, so a call never dirties the git-tracked catalog.
 */
export function recordUse(name: string, ok: boolean, reason?: string): ToolManifest | null {
  const tool = getTool(name);
  if (!tool) return null;
  updateState((all) => {
    const state: ToolState = all[name] ?? { stats: { ...tool.stats }, quarantined: tool.quarantined, quarantineReason: tool.quarantineReason };
    state.stats.calls++;
    state.stats.lastUsed = new Date().toISOString();
    if (ok) {
      state.stats.consecutiveFailures = 0;
    } else {
      state.stats.failures++;
      state.stats.consecutiveFailures++;
      if (state.stats.consecutiveFailures >= QUARANTINE_AFTER) {
        state.quarantined = true;
        state.quarantineReason = `${state.stats.consecutiveFailures} consecutive failures; last: ${reason ?? 'unknown'}`;
      }
    }
    all[name] = state;
    return true;
  });
  return getTool(name);
}

export function setQuarantine(name: string, quarantined: boolean, reason?: string): ToolManifest {
  const tool = getTool(name);
  if (!tool) throw new ToolError(`unknown tool: ${name}`);
  updateState((all) => {
    const state: ToolState = all[name] ?? { stats: { ...tool.stats }, quarantined: tool.quarantined, quarantineReason: tool.quarantineReason };
    state.quarantined = quarantined;
    state.quarantineReason = quarantined ? (reason ?? 'quarantined by operator') : null;
    if (!quarantined) state.stats.consecutiveFailures = 0;
    all[name] = state;
    return true;
  });
  return getTool(name)!;
}

export function validateArgs(tool: ToolManifest, args: unknown): string[] {
  return validate(args, tool.input);
}

export { AdmissionBlocked };
