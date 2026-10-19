import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../queue.ts';
import { TERMINAL_STATUSES, type Task } from '../types.ts';

/**
 * When a reviewer-filed follow-up may start, decided when it is filed and by two fixed rules — no model.
 *
 * Three tickets that edited ONE function ran side by side from different bases (two follow-ups of one review and an
 * operator's ticket): each was green alone, together they conflicted and mis-merged. And of nine follow-ups one
 * trial's reviewer filed, four were already covered when their worker started.
 *
 *  (a) Follow-ups filed on the same ticket run one at a time: a new one waits for every follow-up of that ticket
 *      that is still open, in filing order.
 *  (b) A new follow-up also waits for any other open ticket in the same repo that names a file its own brief names:
 *      in the diff its latest run recorded, or — for another reviewer-filed follow-up — in its brief.
 *
 * The waits are stored as dependency edges, written when the ticket is created and never afterwards, so they point
 * only at tickets that already exist: no edge can close a cycle (`chainIsAcyclic` checks it all the same). They are
 * an ORDER, not a dependency: when a ticket a follow-up is ordered behind ends canceled, failed or rejected, the
 * follow-up is not failed with it — that ticket has left the line and the next one may start
 * (`Store.reconcileBlocked` tells the two kinds apart: on a reviewer-filed follow-up, the edge to the ticket it was
 * filed on is the dependency, every other edge is one of these). Only the ticket it was filed on takes it down.
 */

/** The prefix every review-filed ticket's prompt carries (verify/crewReview.ts writes it). */
export const FILED_PREFIX = 'Filed by ';

/** Open tickets in the repo a new follow-up is compared with; past it the oldest are kept and the cut is said. */
export const MAX_CHAIN_COMPARED = 40;
/** Paths read out of one brief, and out of one diff. */
export const MAX_BRIEF_PATHS = 40;
const MAX_DIFF_PATHS = 2_000;
/** Brief text scanned for paths, in characters. */
const MAX_BRIEF_CHARS = 64_000;
/** The largest diff artifact read for its headers. A larger one is not compared, and the plan says so. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_PATH_CHARS = 200;
/** A header line longer than this is not a path. */
const MAX_HEADER_CHARS = 4_096;

/** A bare file name (no directory) counts as a path only with one of these endings: "e.g" and "v1.2" are not files. */
const BARE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'py', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp',
  'java', 'kt', 'rb', 'sh', 'yml', 'yaml', 'toml', 'css', 'scss', 'html', 'sql', 'txt', 'swift',
]);

function isSegmentChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 95 /* _ */ || code === 46 /* . */ || code === 45 /* - */ || code === 64 /* @ */ || code === 43 /* + */;
}

/** One token as a repo-relative path, or null. A single pass over the token; nothing here backtracks. */
function asRepoPath(raw: string): string | null {
  let token = raw;
  if (token.length > MAX_PATH_CHARS) return null;
  if (token.includes('://')) return null;
  // `src/x.ts:42` and `src/x.ts:42:7` name the file; a sentence's last word carries its full stop.
  const colon = token.indexOf(':');
  if (colon !== -1) token = token.slice(0, colon);
  while (token.endsWith('.') || token.endsWith(',')) token = token.slice(0, -1);
  while (token.startsWith('./')) token = token.slice(2);
  // A diff's own prefixes, when a brief quotes a header.
  if (token.startsWith('a/') || token.startsWith('b/')) token = token.slice(2);
  if (!token || token.startsWith('/') || token.startsWith('.') || token.startsWith('-')) return null;
  let segmentStart = 0;
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (code === 47 /* / */) {
      if (i === segmentStart) return null; // `//`
      segmentStart = i + 1;
    } else if (!isSegmentChar(code)) {
      return null;
    }
  }
  if (segmentStart >= token.length) return null; // ends in `/`
  const base = token.slice(segmentStart);
  if (base === '.' || base === '..' || token.split('/').includes('..')) return null;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext.length > 8) return null;
  for (let i = 0; i < ext.length; i++) {
    const code = ext.charCodeAt(i);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 122))) return null;
  }
  const first = ext.charCodeAt(0);
  if (first >= 48 && first <= 57) return null; // `1.2`, `v0.10`
  if (segmentStart === 0 && !BARE_EXTENSIONS.has(ext)) return null;
  return token;
}

function isDelimiter(code: number): boolean {
  // Whitespace and control characters, quotes, brackets, and the punctuation prose puts around a path.
  return code <= 32 || code === 34 || code === 39 || code === 96 || code === 40 || code === 41 || code === 60
    || code === 62 || code === 91 || code === 93 || code === 123 || code === 125 || code === 44 || code === 59
    || code === 61 || code === 42 || code === 124 || code === 33 || code === 63 || code > 126;
}

/**
 * The repo-relative paths a brief names: `src/helper/packages.ts`, `test/x.test.mjs:12`, `README.md`. The text is
 * the reviewer model's, so it is read in one pass, character by character, with every size bounded.
 */
export function briefPaths(text: string | null | undefined): string[] {
  const source = (text ?? '').slice(0, MAX_BRIEF_CHARS);
  const out = new Set<string>();
  let start = -1;
  for (let i = 0; i <= source.length && out.size < MAX_BRIEF_PATHS; i++) {
    const delimiter = i === source.length || isDelimiter(source.charCodeAt(i));
    if (!delimiter) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1) {
      const found = asRepoPath(source.slice(start, i));
      if (found) out.add(found);
      start = -1;
    }
  }
  return [...out];
}

/** The paths a stored diff's `---` / `+++` headers name. One pass, line by line; an over-long line is skipped. */
export function diffHeaderPaths(diff: string): string[] {
  const out = new Set<string>();
  let at = 0;
  while (at < diff.length && out.size < MAX_DIFF_PATHS) {
    let end = diff.indexOf('\n', at);
    if (end === -1) end = diff.length;
    const length = end - at;
    if (length > 6 && length <= MAX_HEADER_CHARS && (diff.startsWith('+++ b/', at) || diff.startsWith('--- a/', at))) {
      let line = diff.slice(at + 6, end);
      const tab = line.indexOf('\t');
      if (tab !== -1) line = line.slice(0, tab);
      line = line.trimEnd();
      if (line) out.add(line);
    }
    at = end + 1;
  }
  return [...out];
}

/** The paths in the diff artifact the ticket's LATEST run recorded: [] when it recorded none, null when it cannot be read. */
function recordedDiffPaths(store: Store, taskId: string): string[] | null {
  const run = store.latestRun(taskId);
  if (!run) return [];
  const artifact = store.artifactsForTask(taskId).filter((a) => a.runId === run.id && a.type === 'diff').pop();
  if (!artifact) return [];
  try {
    // The artifact directory is Foreman's own, but the file is read the way any file a run produced is: a regular
    // file, of bounded size, or not at all.
    const stat = fs.lstatSync(artifact.path);
    if (!stat.isFile() || stat.size > MAX_DIFF_BYTES) return null;
    return diffHeaderPaths(fs.readFileSync(artifact.path, 'utf8'));
  } catch {
    return null;
  }
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/**
 * The first path both lists name. Two full paths must be equal; a bare file name ("packages.ts") names any path
 * that ends in it, since reviewers write both.
 */
export function sharedPath(mine: string[], theirs: string[]): string | null {
  const full = new Set(theirs);
  const bare = new Set(theirs.filter((p) => !p.includes('/')));
  const bases = new Set(theirs.map(baseName));
  for (const p of mine) {
    if (full.has(p)) return p;
    if (!p.includes('/') && bases.has(p)) return p;
    if (p.includes('/') && bare.has(baseName(p))) return p;
  }
  return null;
}

function sameRepo(a: string | null, b: string | null): boolean {
  return (a ? path.resolve(a) : null) === (b ? path.resolve(b) : null);
}

const isOpen = (t: Pick<Task, 'status' | 'archivedAt'>): boolean => !TERMINAL_STATUSES.includes(t.status) && t.archivedAt == null;

export interface ChainLink {
  /** The ticket the new follow-up waits for. */
  id: string;
  /** Why, in the words its event log shows. */
  why: string;
}

export interface ChainPlan {
  links: ChainLink[];
  /** Anything the plan could not compare, for the same event log. */
  notes: string[];
}

/**
 * What a follow-up about to be filed on `parent` waits for besides `parent` itself. `brief` is the follow-up's
 * title and prompt. Reads only; the caller writes the edges with the ticket.
 */
export function planFollowUpChain(store: Store, parent: Task, brief: string): ChainPlan {
  const links: ChainLink[] = [];
  const notes: string[] = [];
  const chained = new Set<string>([parent.id]);

  // (a) every open follow-up already filed on this ticket, oldest first — not one assigned to a person (an
  // '(operator)' follow-up, crewReview.ts): no runner works it, so nothing collides, and work a person may take
  // days over must not hold the AI's follow-ups.
  for (const sibling of store.childrenOf(parent.id)) {
    if (chained.has(sibling.id) || sibling.isEpic || !isOpen(sibling) || !sibling.prompt.startsWith(FILED_PREFIX)) continue;
    if (sibling.assignee === 'human') continue;
    chained.add(sibling.id);
    links.push({ id: sibling.id, why: `an earlier follow-up of ${parent.id}; follow-ups of one ticket run one at a time` });
  }

  // (b) open tickets in the same repo naming a file this brief names.
  const mine = briefPaths(brief);
  if (!mine.length) {
    notes.push('its brief names no file, so it is ordered only behind the follow-ups filed on the same ticket');
    return { links, notes };
  }
  const placeholders = TERMINAL_STATUSES.map(() => '?').join(',');
  const rows = store.db
    .prepare(
      `SELECT id, repo FROM tasks WHERE archived_at IS NULL AND is_epic = 0 AND status NOT IN (${placeholders})
        ORDER BY created_at ASC, rowid ASC LIMIT 2000`,
    )
    .all(...TERMINAL_STATUSES) as Array<Record<string, unknown>>;
  const inRepo = rows
    .filter((r) => !chained.has(String(r['id'])) && sameRepo(r['repo'] == null ? null : String(r['repo']), parent.repo))
    .map((r) => String(r['id']));
  if (inRepo.length > MAX_CHAIN_COMPARED) {
    notes.push(`compared with the ${MAX_CHAIN_COMPARED} oldest of ${inRepo.length} open tickets in this repo; the rest were not compared`);
  }
  for (const id of inRepo.slice(0, MAX_CHAIN_COMPARED)) {
    const other = store.getTask(id);
    if (!other || !isOpen(other) || other.isEpic) continue;
    const recorded = recordedDiffPaths(store, other.id);
    if (recorded === null) notes.push(`${other.id}'s recorded diff could not be read (missing, not a regular file, or over ${MAX_DIFF_BYTES} bytes); not compared by its diff`);
    const inDiff = sharedPath(mine, recorded ?? []);
    const inBrief = inDiff || !other.prompt.startsWith(FILED_PREFIX) ? null : sharedPath(mine, briefPaths(`${other.title}\n${other.prompt}`));
    const shared = inDiff ?? inBrief;
    if (!shared) continue;
    chained.add(other.id);
    links.push({ id: other.id, why: inDiff ? `both name ${shared} (in ${other.id}'s recorded diff)` : `both name ${shared}` });
  }
  return { links, notes };
}

/**
 * Whether the dependency graph reachable from `ids` is free of a cycle and never reaches `selfId`. A new ticket's
 * edges point at tickets that existed before it, so this holds by construction; it is asked anyway, before the
 * edges are written, and a `false` drops the chain rather than risk a ticket that waits on itself for ever.
 */
export function chainIsAcyclic(store: Store, ids: string[], selfId: string | null = null, limit = 5_000): boolean {
  const done = new Set<string>();
  const onPath = new Set<string>();
  let visited = 0;
  // Iterative depth-first walk: a long chain must not be able to overflow the stack.
  const stack: Array<{ id: string; deps: string[]; next: number }> = [];
  for (const root of ids) {
    if (done.has(root)) continue;
    stack.push({ id: root, deps: store.depsOf(root), next: 0 });
    onPath.add(root);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top.id === selfId) return false;
      if (top.next >= top.deps.length) {
        onPath.delete(top.id);
        done.add(top.id);
        stack.pop();
        continue;
      }
      const dep = top.deps[top.next++]!;
      if (dep === selfId || onPath.has(dep)) return false;
      if (done.has(dep)) continue;
      if (++visited > limit) return false; // too large to prove: treated as unsafe
      onPath.add(dep);
      stack.push({ id: dep, deps: store.depsOf(dep), next: 0 });
    }
  }
  return true;
}
