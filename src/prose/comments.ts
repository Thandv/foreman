// Ported from the author's earlier novel-writing app, trimmed to Foreman's zero-dep conventions.
/**
 * P0.6 — beat comments must survive a rewrite.
 *
 * Every pipeline that rewrites an existing scene strips `<!-- Beat: … -->` to
 * build the model's input, then writes the model's output back as the WHOLE
 * file. The author's notes were destroyed on every red-team fix and every
 * recast. These helpers put them back.
 */

/**
 * Remove HTML comments — linearly.
 *
 * `text.replace(/<!--[\s\S]*?-->/g, …)` is quadratic on an UNCLOSED comment:
 * every `<!--` with no `-->` after it rescans to the end of the file. Measured
 * by the security audit through the Overview tab, which runs on launch with no
 * click at all: 160 KB → 2.7 s, 320 KB → 10.1 s, 640 KB → 37.3 s, and the same
 * regex sits in `proseOf`, which is on nearly every path in the app. A closed
 * comment costs 1 ms, so it is purely the unclosed case — i.e. a single stray
 * `<!--` typed into a chapter.
 *
 * Byte-for-byte identical to the regex it replaces, including the unterminated
 * case — pinned by a property test over random comment soup.
 */
export function stripComments(text: string, replacement = ''): string {
  if (!text.includes('<!--')) return text;
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('<!--', at);
    if (open === -1) return out + text.slice(at);
    const close = text.indexOf('-->', open + 4);
    // An UNTERMINATED `<!--` is not a comment: it stays as text, exactly as the
    // regex left it. Dropping the remainder instead would make a scene holding
    // one stray `<!--` look EMPTY to `proseOf` — and an empty scene is a stub
    // that autowrite may target and the never-overwrite guard will not defend.
    if (close === -1) return out + text.slice(at);
    out += text.slice(at, open) + replacement;
    at = close + 3;
  }
}

export interface SplitComments {
  /** comment blocks that lead the file, with their trailing blank line */
  leading: string[];
  /** every other comment block, in document order */
  interior: string[];
  /** the prose with all comments removed */
  prose: string;
}

/**
 * Every TERMINATED comment block, as [start, endExclusive] — linearly.
 *
 * The same shape `stripComments` fixed two functions above, left behind here:
 * `rest.match(COMMENT)` and `rest.replace(COMMENT, '')` each rescan to the end
 * of the file for every unclosed `<!--`. Measured end-to-end through
 * `pendingDiff`, which runs when a folder is adopted: a 320 KB scene holding
 * stray `<!--` took 19.8 s of frozen main process, against 0.00 s for the fixed
 * sibling on the same bytes.
 */
function commentSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  if (!text.includes('<!--')) return spans;
  let at = 0;
  for (;;) {
    const open = text.indexOf('<!--', at);
    if (open === -1) return spans;
    const close = text.indexOf('-->', open + 4);
    // Unterminated: not a comment. It stays as prose, exactly as the regex left
    // it — see `stripComments` for why dropping the remainder is dangerous.
    if (close === -1) return spans;
    spans.push([open, close + 3]);
    at = close + 3;
  }
}

export function splitComments(text: string): SplitComments {
  const spans = commentSpans(text);
  const leading: string[] = [];
  // Peel comment blocks off the top while nothing but whitespace precedes them.
  let cut = 0;
  let first = 0;
  for (; first < spans.length; first++) {
    const [start, end] = spans[first]!;
    if (text.slice(cut, start).trim() !== '') break;
    leading.push(text.slice(start, end));
    cut = end;
  }
  const interior: string[] = [];
  let prose = '';
  let at = cut;
  for (const [start, end] of spans.slice(first)) {
    interior.push(text.slice(start, end));
    prose += text.slice(at, start);
    at = end;
  }
  prose += text.slice(at);
  return { leading, interior, prose: prose.trim() };
}

/**
 * Re-attach `original`'s comments to rewritten prose.
 *
 * Leading blocks (the conventional place for a beat note) go back at the top.
 * Interior blocks cannot be re-anchored — the prose they sat inside no longer
 * exists — so they are appended at the end rather than dropped, which is the
 * honest trade: a relocated note is recoverable, a deleted one is not.
 * Blocks the rewrite already reproduced are not duplicated.
 */
export function reattachComments(original: string, rewritten: string): string {
  const { leading, interior } = splitComments(original);
  if (!leading.length && !interior.length) return rewritten;
  const body = rewritten.trim();
  const head = leading.filter((c) => !body.includes(c));
  const tail = interior.filter((c) => !body.includes(c));
  const parts: string[] = [];
  if (head.length) parts.push(head.join('\n'));
  parts.push(body);
  if (tail.length) parts.push(tail.join('\n'));
  const out = parts.join('\n\n');
  return out.endsWith('\n') ? out : out + '\n';
}
