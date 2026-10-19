import { readJailFile } from './verify/jailRead.ts';
import { isTestPath } from './verify/literals.ts';
import { isDocPath } from './verify/revertCheck.ts';

/**
 * Acceptance coverage map: the worker ends its report with an `ACCEPTANCE MAP`
 * section, one line per numbered acceptance item, and this module checks that
 * map against the acceptance text and the diff. No model call; the only I/O is
 * reading a mapped test file from the work tree, when the caller gives one.
 */

export type Exempt = 'operator' | 'review' | 'gate' | null;

/**
 * "npm run verify passes" and "The gate passes: npx tsc --noEmit, then ..." are proven by the ticket's own gate run,
 * not by a test in the diff, so no map line can satisfy them: Kiln epic B's clang-tidy-profile ticket failed both
 * pre-review rounds on exactly that item. An item is a gate item only when it STARTS with the gate's subject, says it
 * passes, and is short, so a real behaviour cannot hide behind "... and npm run verify passes".
 */
const GATE_ITEM = /^\W*(?:the\s+)?(?:npm run verify|npm test|npx tsc|gate|test command|full (?:test )?suite)\b[^\n]*\bpass(?:es)?\b/i;
const GATE_ITEM_MAX = 160;
const isGateItem = (text: string): boolean => text.length <= GATE_ITEM_MAX && GATE_ITEM.test(text);
export interface AcceptanceItem {
  n: number;
  text: string;
  exempt: Exempt;
}
export interface MapGap {
  n: number;
  reason: string;
}
export type MapEntry =
  | { kind: 'test'; file: string; name: string }
  | { kind: 'diff'; path: string }
  | { kind: 'operator' | 'review' };

/**
 * Items written inline on one line ("1. a. 2. b."): `N. ` at the start or after whitespace, accepted
 * only while N runs 1, 2, 3, ... so "version 1.2" or "Node 24. Then" is never split.
 * Known limit: "1. Run step 2. Then 2. Check the log." splits at "step 2." (first consecutive match wins). Preferring
 * the split with the most even item lengths would pick "Then 2." here, but that is a heuristic not worth its
 * complexity.
 */
function inlineItems(text: string): { n: number; lines: string[] }[] {
  const marks: { n: number; start: number; end: number }[] = [];
  for (const m of text.matchAll(/(?<!\S)(\d+)\.(?=\s)\s*/g)) {
    if (Number(m[1]) === marks.length + 1) marks.push({ n: marks.length + 1, start: m.index, end: m.index + m[0].length });
  }
  return marks.map((k, i) => ({ n: k.n, lines: [text.slice(k.end, marks[i + 1]?.start ?? text.length)] }));
}

/** An explicit marker outside backticks, leading the item or ending it; an item that merely mentions one is not exempt. */
const exemptMarker = (text: string): 'operator' | 'review' | null => {
  const bare = text.replace(/`[^`]*`/g, '');
  const m = /^\((operator|review)\)/.exec(bare) ?? /\((operator|review)\)[\s.,;:!]*$/.exec(bare);
  return m ? (m[1] as 'operator' | 'review') : null;
};

/** Numbered items: a line starting `N.` plus its continuation lines. */
export function numberedItems(acceptance: string | null | undefined): AcceptanceItem[] {
  const items: { n: number; lines: string[] }[] = [];
  for (const line of (acceptance ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\.(?:\s+|$)(.*)$/.exec(line);
    if (m) items.push({ n: Number(m[1]), lines: [m[2]!] });
    else if (items.length) items[items.length - 1]!.lines.push(line);
  }
  if (items.length <= 1) {
    const inline = inlineItems((acceptance ?? '').trim());
    if (inline.length >= 2) items.splice(0, items.length, ...inline);
  }
  return items.map(({ n, lines }) => {
    const text = lines.join('\n').trim();
    const exempt: Exempt = exemptMarker(text) ?? (isGateItem(text) ? 'gate' : null);
    return { n, text, exempt };
  });
}

const clean = (s: string): string => s.trim().replace(/^`+|`+$/g, '').trim();
const normPath = (p: string): string => clean(p).replace(/^\.\//, '');

/** The entries of the report's `ACCEPTANCE MAP` section, by item number (first line per item wins). */
export function parseAcceptanceMap(report: string | null | undefined): Map<number, MapEntry> {
  const out = new Map<number, MapEntry>();
  const lines = (report ?? '').split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[\s#*_`>-]*ACCEPTANCE MAP\b[\s:*_`-]*$/i.test(lines[i]!)) {
      start = i;
      break;
    }
  }
  if (start < 0) return out;
  for (const line of lines.slice(start + 1)) {
    const m = /^[\s>*`-]*(\d+)\.\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (out.has(n)) continue;
    const rest = m[2]!;
    const flag = /^\(?(operator|review)\)?$/i.exec(clean(rest));
    const diff = /^\(diff\)\s*(.+)$/i.exec(rest);
    const sep = rest.indexOf('::');
    if (flag) out.set(n, { kind: flag[1]!.toLowerCase() as 'operator' | 'review' });
    else if (diff && clean(diff[1]!)) out.set(n, { kind: 'diff', path: normPath(diff[1]!) });
    else if (sep > 0 && clean(rest.slice(sep + 2))) {
      out.set(n, { kind: 'test', file: normPath(rest.slice(0, sep)), name: clean(rest.slice(sep + 2)) });
    }
  }
  return out;
}

interface DiffFile {
  /**
   * Where a test name may be found: the post-image of every hunk that adds a line (its added and context lines, plus
   * the function heading git prints after the hunk's @@), with escaped quotes unescaped. Never the path, the file
   * headers, an index line or a removed line. A test whose body a ticket changed is named only in its hunk's heading
   * or context, and a title written 'program\'s' in source is mapped as "program's": Kiln's raw-stdin ticket failed
   * both pre-review rounds on exactly those three items while its map was right.
   */
  changed: string;
  live: boolean; // added or modified, not deleted
}

const unescapeQuotes = (s: string): string => s.replace(/\\(['"`])/g, '$1');

function postImage(text: string): string {
  const out: string[] = [];
  let started = false; // past the first @@
  let hunk: string[] = [];
  let adds = false;
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith('@@')) {
      if (adds) out.push(...hunk);
      hunk = [l.replace(/^@@[^@]*@@ ?/, '')];
      adds = false;
      started = true;
    } else if (!started) {
      // Before the first @@ only the '+++ ' header is excluded (a diff fixture may carry bare '+' lines).
      if (l.startsWith('+') && !l.startsWith('+++ ')) out.push(l.slice(1));
    } else if (l.startsWith('+')) {
      hunk.push(l.slice(1));
      adds = true;
    } else if (l.startsWith(' ')) {
      hunk.push(l.slice(1));
    }
  }
  if (adds) out.push(...hunk);
  return unescapeQuotes(out.join('\n'));
}

function diffFiles(diff: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();
  const blocks = (diff ?? '').split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));
  for (const text of blocks) {
    const head = /^diff --git a\/(.+?) b\/(.+?)\r?$/m.exec(text);
    const plus = /^\+\+\+ (?:b\/)?(.+?)\s*$/m.exec(text);
    const deleted = /^deleted file mode/m.test(text) || /^\+\+\+ \/dev\/null/m.test(text);
    const p = plus && plus[1] !== '/dev/null' ? plus[1] : (head?.[2] ?? head?.[1]);
    if (p) files.set(p, { changed: postImage(text), live: !deleted });
  }
  return files;
}

/**
 * Whether an acceptance item names a file: its path, its base name, or — for a base name with an extension — its stem
 * as a whole word ("README's .kiln.json section" names README.md, "SPEC-CPP §1" names SPEC-CPP.md). Kiln's docs
 * ticket failed both pre-review rounds on four such items while its map was right. A stem shorter than 3 characters
 * (a.ts) or a common word stem would match too much, so only stems of 3+ characters with a capital, digit, '-' or '_'
 * count — and only for documents: a code file's stem is usually also the name of the thing it implements ("the App
 * shows…" is a behaviour item, not a mention of App.tsx), so code files need the base name or the path.
 */
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);

export function namesFile(text: string, path: string): boolean {
  const base = path.split('/').pop()!;
  if (text.includes(path) || text.includes(base)) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || !DOC_EXTENSIONS.has(base.slice(dot).toLowerCase())) return false;
  const stem = base.slice(0, dot);
  if (stem.length < 3 || !/[A-Z0-9_-]/.test(stem)) return false;
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w./-])${esc}(?![\\w-]|\\.\\w)`).test(text);
}

/** The largest mapped test file read from the tree; a larger one is judged from its diff hunks. */
const MAX_TEST_FILE_BYTES = 2 * 1024 * 1024;

/**
 * An item that asks for a test in so many words: "(test)", "(fixture test, fails without the change)", "A test pins
 * all three", "fails without the change". Such an item is proven by a test the diff adds or changes and by nothing
 * else: a `(diff)` line, or a test that was already there, cannot fail without the change.
 */
const DEMANDS_TEST = new RegExp(
  [
    String.raw`\((?:[a-z-]+ )?tests?(?:[,;:][^)]*)?\)`,
    String.raw`\b(?:a|one|each|every|new|regression|unit|fixture) tests?\b[^.;\n]*\b(?:pins?|asserts?|proves?|covers?|checks?|fail(?:s|ing)?)\b`,
    String.raw`\bfail(?:s|ing)? without (?:the|this|that) (?:change|fix|patch)\b`,
    String.raw`\b(?:pinned|covered|proven|asserted) by (?:a|the|its|their) (?:new |own )?tests?\b`,
    // The plainer ways a ticket asks for one: "Add a test for the 403 path", "A route test shows…", "the cap is
    // (unit-)tested", "Route tests: …". Never "the existing tests pass unchanged": that item is about tests that
    // were already there, and a test that was already there is what proves it.
    String.raw`\b(?:add|adds|adding|write|writes) (?:(?:a|an|one|the|new|[a-z-]+) ){1,3}tests?\b`,
    String.raw`\b(?:a|an|one|each|every|new) (?:(?!existing\b)[a-z-]+ ){1,3}tests? (?:pins?|asserts?|proves?|covers?|checks?|shows?|fails?)\b`,
    String.raw`\b(?:is|are) (?:unit[- ])?tested\b|\((?:unit[- ])?tested\)|\bunit-tested\b`,
    String.raw`^\W*(?:(?!existing\b)[A-Za-z-]+ ){0,2}tests(?: \([^)\n]*\))?:`,
  ].join('|'),
  'i',
);
export const demandsTest = (text: string): boolean => DEMANDS_TEST.test(text);

/** A path that is a test file by where it is or how it is named. */
const isTestFile = (rel: string): boolean => isTestPath(rel) || /(^|\/)(test_[^/]*|[^/]*_test)\.\w+$/.test(rel);

/**
 * Is `name` the title of a test in `text`? A whole string literal ('name', "name", `name`), or the name of a test
 * function (`def test_x`, `func TestX`). A word that merely occurs in the file ("assert", "function") is not a title.
 */
function declaresTest(text: string, name: string): boolean {
  const flat = unescapeQuotes(text);
  const want = unescapeQuotes(name);
  for (let at = flat.indexOf(want); at >= 0; at = flat.indexOf(want, at + 1)) {
    const before = flat[at - 1] ?? '';
    const after = flat[at + want.length] ?? '';
    if ((before === "'" || before === '"' || before === '`') && after === before) return true;
    if (/^[A-Za-z_][\w]*$/.test(want) && /(?:\bdef|\bfunc|\bfn|\bvoid)\s+$/.test(flat.slice(Math.max(0, at - 12), at)) && !/[\w]/.test(after)) return true;
  }
  return false;
}

/** A file whose change no test and no document is: code, config, a build file. Deleting one counts too. */
const isRuntimePath = (rel: string): boolean => !isDocPath(rel) && !isTestFile(rel);

/**
 * Items the worker's map fails to cover, with why. The line forms:
 *
 * - `<test file> :: <exact test title>`, a test of this change — the file is in the diff (not deleted) and the title
 *   is in the post-image of a hunk that adds a line. This is the form that shows new behaviour, and the only one an
 *   item that asks for a test accepts.
 * - `<test file> :: <exact test title>`, a test that was already there — the file is a test file in the work tree
 *   (in the diff or not) and the title is the title of a test in it, read from `treeDir`. For an item the change must
 *   NOT break ("the logic is unchanged"): Kiln's lock-message ticket spent a repair round on "test name not found"
 *   for exactly such a line. Any other file, or a word that merely occurs in the file, is still a gap.
 * - `(diff) <path>` — the path is in the diff. When the item names that file nothing more is asked (main's rule).
 *   When it does not, the line is accepted for an item the diff itself can show ("recognised through the existing
 *   helper", "every place that enumerates statuses handles the new value") — the Kiln trial's ten false flags were
 *   all "item does not name file" on such lines — but not for an item that asks for a test.
 * - `(operator)` / `(review)` — only for an item the acceptance text itself marks that way.
 *
 * And one rule for the map as a whole, so the two relaxed forms cannot carry a ticket alone: when the diff changes
 * code and NO item is mapped to a test of this change, every item accepted only by a relaxed form is a gap
 * ("no changed test"). Before, an item that did not name a file could only be mapped to a changed test, so a map
 * with no changed test in it never passed; `(diff) README.md` on every line must not pass now either.
 */
export function checkAcceptanceMap(args: {
  acceptance: string | null | undefined;
  report: string | null | undefined;
  diff: string;
  /** The tree the work was done in. Without it only a test of this change (in the diff's hunks) can be mapped. */
  treeDir?: string | null;
}): MapGap[] {
  const items = numberedItems(args.acceptance);
  if (!items.length) return [];
  const map = parseAcceptanceMap(args.report);
  const files = diffFiles(args.diff);
  const gaps: MapGap[] = [];
  /** Items accepted by a relaxed form only: a `(diff)` line the item does not name, or a test that was already there. */
  const relaxed: number[] = [];
  let changedTests = 0;
  for (const item of items) {
    if (item.exempt) continue;
    const e = map.get(item.n);
    if (!e) {
      gaps.push({ n: item.n, reason: 'unmapped' });
    } else if (e.kind === 'operator' || e.kind === 'review') {
      gaps.push({ n: item.n, reason: 'not exempt' });
    } else if (e.kind === 'test') {
      const f = files.get(e.file);
      if (f?.live && f.changed.includes(unescapeQuotes(e.name))) {
        // Main's rule for the item itself, whatever the file. But only a line into a TEST file is the "test of this
        // change" that lets the relaxed forms stand: `README.md :: 403` or `src/server.ts :: return` is no test.
        if (isTestFile(e.file)) changedTests++;
        continue;
      }
      // Not a test of this change. A test that was already in the tree, then — in a test file, and by its title.
      const whole = args.treeDir && f?.live !== false && isTestFile(e.file) ? readJailFile(args.treeDir, e.file, MAX_TEST_FILE_BYTES) : null;
      if (whole !== null && declaresTest(whole, e.name)) {
        if (demandsTest(item.text)) gaps.push({ n: item.n, reason: 'item asks for a test of this change; the named test is not in the diff' });
        else relaxed.push(item.n);
      } else if (f?.live || whole !== null) {
        gaps.push({ n: item.n, reason: 'test name not found' });
      } else {
        // Main's words when the diff has no such file; "or tree" only when the tree was looked in for a test file.
        gaps.push({ n: item.n, reason: args.treeDir && !f && isTestFile(e.file) ? 'test file not in diff or tree' : 'test file not in diff' });
      }
    } else if (e.kind === 'diff') {
      if (!files.has(e.path)) gaps.push({ n: item.n, reason: 'file not in diff' });
      else if (namesFile(item.text, e.path)) continue;
      else if (demandsTest(item.text)) gaps.push({ n: item.n, reason: 'item asks for a test; map it to <test file> :: <test name>' });
      else relaxed.push(item.n);
    }
  }
  if (relaxed.length && changedTests === 0 && [...files.keys()].some(isRuntimePath)) {
    for (const n of relaxed) gaps.push({ n, reason: 'no changed test is mapped to any item; (diff) or an existing test alone does not show a code change works' });
    gaps.sort((a, b) => a.n - b.n);
  }
  return gaps;
}

export function formatMapGaps(gaps: MapGap[]): string {
  return gaps.map((g) => `${g.n}. ${g.reason}`).join('\n');
}
