// Ported from the author's earlier novel-writing app, trimmed to Foreman's zero-dep conventions.
// Only the pure parsing + selection surface is ported: everything that needed
// `../workspace` (confineWrite, project-file reads), electron, or the manifest
// serializer is left behind. parseBible/selectRelevant/orderForPrompt operate
// over a markdown string the caller has already read — no fs, no confinement.

export interface BibleEntry {
  /** P6.6: inherited from the series bible rather than written for this book */
  series?: boolean;
  category: string;
  name: string;
  aliases: string[];
  /** always inject regardless of mention (protagonist, core world rules) */
  always: boolean;
  body: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * P1.4 — a name matcher that works outside ASCII.
 *
 * `\b` is defined against `[A-Za-z0-9_]`, so `Zoë`, `李雷` and `Ástríðr` never
 * matched and their bible entries never reached the prompt. Unicode property
 * lookarounds give the same "whole word" behaviour for every alphabet.
 */
export function mentionRegex(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'iu');
}

export function mentions(text: string, names: readonly string[]): boolean {
  return names.some((n) => n && mentionRegex(n).test(text));
}

// --- parsing ----------------------------------------------------------------

/** Parse one bible markdown file. Entries are `## Name` blocks with optional
 *  `- aliases:` and `- always:` metadata lines, then a free-text body. */
export function parseBible(category: string, text: string): BibleEntry[] {
  const out: BibleEntry[] = [];
  const blocks = text.split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const nl = block.indexOf('\n');
    const name = (nl === -1 ? block : block.slice(0, nl)).trim();
    if (!name) continue;
    const rest = nl === -1 ? '' : block.slice(nl + 1);
    const aliases: string[] = [];
    let always = false;
    const bodyLines: string[] = [];
    // Metadata is read from ANYWHERE in the entry, as it always was: the
    // documented format puts it under the heading, but the file is markdown the
    // author may write by hand, and one who wrote the description first had a
    // file that worked. Restricting the parser to the header block (round 12)
    // closed the forgery at the cost of silently dropping those aliases — which
    // silently changes what reaches every prompt.
    //
    // The forgery is closed at the WRITE side (`escapeBodyMeta`, not ported —
    // it only matters for the UI's round-trip write, which this module does
    // not do), so a body line that would read as metadata is stored escaped,
    // and unescaped here. The author never typed the backslash and never sees it.
    //
    // Round 14, severity 4: an escape on the way OUT cannot protect text that
    // never went out through us. A bible file that was hand-written, IMPORTED,
    // or written by the model has never met `escapeBodyMeta`, so a prose line
    // reading `- aliases: a, i, the` was still harvested — and, worse, DELETED
    // from the body, so the author's sentence vanished from their file the first
    // time any other entry in it was saved, and three one-letter aliases matched
    // nearly every scene and rode the entry into every prompt for the book.
    //
    // So the harvest stays wide and the DELETION stops: a meta line inside the
    // header run is metadata and is consumed, and one below the body's first
    // real line is read for its value AND kept verbatim as the author's text.
    // No byte is lost either way, and the next save escapes it, after which it
    // is body only. `inHeader` decides what to KEEP, never what to READ — which
    // is why a hand-written "aliases after the description" file still works.
    let inHeader = true;
    for (const line of rest.split('\n')) {
      const am = line.match(/^\s*-\s*alias(?:es)?\s*:\s*(.+)$/i);
      const alw = line.match(/^\s*-\s*always\s*:\s*(true|yes)\s*$/i);
      if (am || alw) {
        if (am) aliases.push(...am[1]!.split(',').map((s) => s.trim()).filter(Boolean));
        if (alw) always = true;
        if (inHeader) continue;
        bodyLines.push(line);
        continue;
      }
      if (line.trim() !== '') inHeader = false;
      // The EXACT inverse of `escapeBodyMeta` — no wider. Unescaping `#{1,6}`
      // while escaping only `##` meant an author's literal `\### Backstory` lost
      // its backslash on every round trip and became a real heading in their file.
      bodyLines.push(
        line
          .replace(/^(\s{0,3})\\(\\*##(?:\s|$))/, '$1$2')
          .replace(/^(\s*)\\(\\*-\s*(?:alias(?:es)?|always)\s*:)/i, '$1$2'),
      );
    }
    out.push({ category, name, aliases, always, body: bodyLines.join('\n').trim() });
  }
  return out;
}

/**
 * TOKEN SAVER: pick only the entries a scene actually needs — those whose name
 * or an alias is mentioned in the beat/text, plus any marked `always`. This is
 * what keeps the prompt small instead of dumping the whole bible every call.
 */
export function selectRelevant(
  entries: BibleEntry[],
  text: string,
  opts: { max?: number } = {},
): BibleEntry[] {
  const always = entries.filter((e) => e.always);
  // A ONE-CHARACTER alias is not an alias. It matches nearly every scene, so the
  // entry rides into the prompt for the whole book — which is the harm named in
  // `escapeBodyMeta`'s docstring, and it does not need a forged `- aliases: a,
  // i, the` line to happen: an author can type a single letter too. The name is
  // never dropped, only aliases, so nothing an entry is actually called is lost.
  const usable = (e: BibleEntry): string[] => [e.name, ...e.aliases.filter((a) => a.trim().length > 1)];
  const mentioned = entries.filter((e) => !e.always && mentions(text, usable(e)));
  // P1.2: the comment always claimed "always-on first" but the slice ran in FILE
  // order, so on a bible with >24 matches style.md (POV, tense, the never-list)
  // was the first thing dropped. Order before capping.
  const max = opts.max ?? 24;
  return [...always, ...mentioned].slice(0, max);
}

/**
 * Rank a set of entry names into prompt order and apply the same cap.
 * Used by the graph path, which selects by id rather than by matching.
 */
export function orderForPrompt(entries: BibleEntry[], keep: Set<string>, max = 24): BibleEntry[] {
  const picked = entries.filter((e) => keep.has(e.name));
  const always = picked.filter((e) => e.always);
  const rest = picked.filter((e) => !e.always);
  return [...always, ...rest].slice(0, max);
}

export function formatEntries(entries: BibleEntry[]): string {
  if (!entries.length) return '(no relevant bible entries)';
  return entries
    .map(
      (e) =>
        `### ${e.name}${e.aliases.length ? ` (aka ${e.aliases.join(', ')})` : ''} [${e.category}]\n${e.body}`,
    )
    .join('\n\n');
}
