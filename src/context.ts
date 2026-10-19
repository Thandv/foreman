import { config } from './config.ts';

/**
 * Deterministic context compaction — the "token saver". Everything that ends up
 * in a model prompt (diffs, logs, remembered facts) is bounded HERE, by code,
 * before a single token is paid for. Compaction is never a model call: it is a
 * pure, testable transform, so the same input always yields the same, cheaper
 * output.
 */

export interface FileStat {
  path: string;
  added: number;
  removed: number;
}

/** Per-file add/remove counts, read from a unified diff's headers and hunks. */
export function diffStats(diff: string): FileStat[] {
  const stats = new Map<string, FileStat>();
  let current: FileStat | null = null;
  for (const line of diff.split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/);
    if (header) {
      const path = header[2] === 'dev/null' ? header[1]! : header[2]!;
      current = stats.get(path) ?? { path, added: 0, removed: 0 };
      stats.set(path, current);
      continue;
    }
    if (!current) continue;
    // Count content lines only, never the +++/--- file markers.
    if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
  }
  return [...stats.values()];
}

/** Split a unified diff into per-file sections keyed by their `diff --git` path. */
function diffSections(diff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = diff.split('\n');
  let path: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (path !== null) sections.set(path, buf.join('\n'));
  };
  for (const line of lines) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/);
    if (header) {
      flush();
      path = header[2] === 'dev/null' ? header[1]! : header[2]!;
      buf = [line];
    } else if (path !== null) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Reduce a diff to at most `capBytes`. Under the cap it is returned untouched.
 * Over it, the result is a deterministic summary: a per-file stat table for
 * EVERY changed file, followed by the full hunks of the most-touched files,
 * added one whole file at a time until the next one would breach the cap. The
 * council still sees exactly which files changed, and reads the largest changes
 * in full, without ever paying for a 500 KB dump.
 */
export function compactDiff(diff: string, capBytes = config.diffCapBytes): string {
  if (diff.length <= capBytes) return diff;

  const stats = diffStats(diff);
  const sections = diffSections(diff);
  // Most-touched first; ties broken by path so the output is stable.
  const ranked = [...stats].sort(
    (a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path),
  );

  const table = [
    `[FOREMAN compacted this diff for review: ${diff.length} bytes across ${stats.length} file(s) ` +
      `exceeded Foreman's own ${capBytes}-byte reading cap. The worker's output was NOT truncated ` +
      `and this cap is not part of the task.]`,
    'Per-file change summary (all files):',
    ...ranked.map((s) => `  ${s.path}  +${s.added} -${s.removed}`),
    '',
  ].join('\n');

  const parts: string[] = [table];
  let used = table.length;
  let shown = 0;
  for (const stat of ranked) {
    const section = sections.get(stat.path);
    if (!section) continue;
    const remaining = capBytes - used;
    if (remaining < 400) break; // no room left for another meaningful block
    const header = `--- hunks: ${stat.path} ---\n`;
    const full = `${header}${section}\n`;
    if (full.length <= remaining) {
      parts.push(full);
      used += full.length;
      shown++;
      continue;
    }
    // The file's own hunks blow the budget: include as much of them as fits,
    // truncated deterministically, then stop. The stat table above still names
    // every file, so nothing changed is hidden — only the bytes are bounded.
    const budget = remaining - header.length - 48;
    if (budget > 200) {
      parts.push(`${header}${section.slice(0, budget)}\n… [FOREMAN cut these hunks to fit its own reading cap; the work itself is complete]\n`);
      shown++;
    }
    break;
  }
  if (shown < ranked.length) {
    parts.push(`[${ranked.length - shown} smaller file(s) shown in the summary above only]`);
  }
  return parts.join('\n');
}

/** Keep only the last `maxLines` lines (and at most `maxBytes`) of a log. */
export function tailLog(text: string, maxLines = config.logTailLines, maxBytes = config.logTailBytes): string {
  if (!text) return text;
  let out = text.split('\n').slice(-maxLines).join('\n');
  if (out.length > maxBytes) out = `…\n${out.slice(-maxBytes)}`;
  return out;
}

/** One cut boundBrief made: which section, its limit, and how much of the text went. In characters, as boundBrief measures. */
export interface BriefCut {
  /** The caller's name for the section; `limit-<n>` when it gave none. */
  section: string;
  limit: number;
  /** The section's length before the cut. */
  before: number;
  /** Characters of the section that were not sent. */
  cut: number;
}

/** Where boundBrief reports its cuts while a brief is being built; null outside collectBriefCuts. */
let cutSink: BriefCut[] | null = null;

/**
 * Run `build` and return what it returned together with every cut boundBrief
 * made while it ran. A brief is assembled by several functions that each bound
 * their own section, so the cuts are collected here instead of being threaded
 * through every one of them. `build` must be synchronous: the sink is this
 * module's, and an await inside would let another brief's cuts in.
 */
export function collectBriefCuts<T>(build: () => T): { value: T; cuts: BriefCut[] } {
  const outer = cutSink;
  const cuts: BriefCut[] = [];
  cutSink = cuts;
  try {
    return { value: build(), cuts };
  } finally {
    cutSink = outer;
  }
}

/**
 * Bound an injected memory brief to `maxBytes`, cutting on a line boundary.
 *
 * The marker is paid for out of the budget, not added on top of it. A function
 * that promises a bound and then returns more than the bound is a slow leak
 * into every prompt that uses it — and lengthening the marker (worth doing, so
 * a reviewer stops mistaking our truncation for the worker's) is exactly the
 * kind of edit that would have done it silently.
 *
 * `section` names the text for the cut report (collectBriefCuts); it changes
 * nothing in what is returned.
 */
export function boundBrief(text: string, maxBytes = config.memoryBriefBytes, section?: string): string {
  if (text.length <= maxBytes) return text;
  const report = (kept: number): void => {
    cutSink?.push({ section: section ?? `limit-${maxBytes}`, limit: maxBytes, before: text.length, cut: text.length - kept });
  };
  const marker = `\n… [FOREMAN cut this section here at ${maxBytes} bytes; the rest was NOT sent]`;
  // A budget too small to hold the marker gets a bare cut: saying "truncated"
  // is worth less than the bytes it would cost at that size.
  const budget = maxBytes - marker.length;
  if (budget <= 0) {
    report(maxBytes);
    return text.slice(0, maxBytes);
  }
  const cut = text.slice(0, budget);
  const lastNl = cut.lastIndexOf('\n');
  const kept = lastNl > 0 ? cut.slice(0, lastNl) : cut;
  report(kept.length);
  return `${kept}${marker}`;
}
