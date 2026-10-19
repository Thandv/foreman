import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import type { Store } from '../queue.ts';
import type { Run, Task } from '../types.ts';
import { FILED_PREFIX } from './followUpChain.ts';
import { readJailFile } from './jailRead.ts';
import { isTestPath } from './literals.ts';

/**
 * Pre-existing assertions a diff removed or changed.
 *
 * On the Kiln trial a worker whose own change tripped an assertion in a test
 * file outside its ticket narrowed the assertion instead of fixing the change
 * (test/preview.test.ts: the value checked went from the whole saved record to
 * its `steps`), and nothing flagged it. This is the deterministic half: for
 * every test file that existed before the run and is modified by its diff,
 * list what a reader would want a reason for — an assertion line removed or
 * changed, a value an assertion checks redefined, a test declaration removed,
 * a skip added. A line that only moved, or changed only in its whitespace, is
 * not listed, and neither is anything in a new test file.
 *
 * Nothing here demands a repair: a ticket may change behaviour on purpose.
 * The whole list always goes to the reviewer. Onto the run as a hold for a
 * person goes only what the ticket gives no sign of having asked for: a
 * finding in a test file the ticket's own text does not name (scopeHolds). On
 * the ledger the wider hold — every finding — would have stopped 122 of 444
 * code tickets, and of 25 read, 18 were changes the ticket required: an
 * operator shown that waves it through. Naming leaves 97 (67 with a reviewer-filed follow-up read too, 90 before a
 * file named only where the ticket says to leave it alone was held). New tests the
 * diff adds to the file release nothing: the one unexplained weakening in
 * those 25 that its ticket did not name (Kiln r_798fb7beb9) sat beside five.
 */

/** What makes a line an assertion, a skip or a test declaration. One table; extend it here. */
const PATTERNS = {
  assertion: [
    /\bassert\s*[.(]/, // node:assert, chai assert, assert(...)
    /^\s*assert\s+\S/, // python
    /\bexpect\s*\(/, // jest, vitest, chai expect
    /\.(rejects|throws|toThrow\w*)\b/,
    /\bt\.(is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|throws|throwsAsync|notThrows|regex|notRegex|like|assert|snapshot|equal|notEqual|same|ok|notOk|strictEqual|match)\s*\(/, // ava, tap
    /\bt\.(Error|Fatal|Fail)\w*\(|\brequire\.\w+\(/, // go
    /\.should\b|\bshould\s*[.(]/,
  ],
  skip: [
    /\.(skip|only|todo)\b/,
    /\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/,
    /\b(skip|todo)\s*:\s*(true|['"`])/, // node:test options
    /@pytest\.mark\.(skip|xfail)|@unittest\.skip|\bt\.Skip\w*\(/,
  ],
  test: [
    /^\s*(?:await\s+)?(?:test|it|describe|suite|context|specify)(?:\.\w+)*\s*\(\s*['"`]/,
    /^\s*(?:async\s+)?def\s+test_\w+/,
    /^\s*func\s+Test\w+\s*\(/,
  ],
} as const;

const matches = (kind: keyof typeof PATTERNS, text: string): boolean => PATTERNS[kind].some((re) => re.test(text));
const isComment = (text: string): boolean => /^\s*(\/\/|\/\*|\*|#(?!\w+\s*[=(]))/.test(text);
/** A line as compared: no whitespace anywhere, no trailing `;` or `,`. A reformatted line is the same line. */
const norm = (text: string): string => text.replace(/\s+/g, '').replace(/[;,]+$/, '');

export interface AssertionFinding {
  file: string;
  /** The line in the file before the run; for an added skip, the line after it. */
  line: number;
  /**
   * `asserted-value`: a redefined name an assertion checks directly (`assert.doesNotMatch(saved, …)`).
   * `asserted-input`: a redefined name an assertion only passes on to a call (`assert.deepEqual(f(root), [])`) —
   * a fixture: told to the reviewer, not a hold for a person on its own (see holds).
   */
  kind: 'assertion' | 'asserted-value' | 'asserted-input' | 'test' | 'skip' | 'file';
  old: string | null;
  /** What stands in its place, when the same change put a line there. */
  new: string | null;
  /** For an asserted value: the assertion that checks it. For a later line of a multi-line assertion: its first line. */
  detail?: string;
  /**
   * Whether this finding holds the gate for a person, as decided when it was recorded (scopeHolds) and kept with it.
   * `held`: the ticket does not name the file. `held-unread`: something the decision needs could not be read, so
   * nothing was released. `held-filed`: the ticket's text is a model's, written from what earlier runs produced (a
   * follow-up a reviewer filed, an `improve:` proposal), and releases nothing. `held-kept`: the ticket names the file
   * only where it says to leave something as it is. `named`: not a hold, the ticket names the file. Absent on a finding that was never recorded
   * (and on every finding recorded before this was decided per finding) and on an `asserted-input`, which is never a hold.
   */
  hold?: 'held' | 'held-unread' | 'held-filed' | 'held-kept' | 'named';
}

interface Line {
  no: number;
  text: string;
  /** For a removed line that is a later line of an assertion written over several lines: the line that opens it. */
  within?: string;
}

/**
 * Brackets a line leaves open (or closes, when negative), not counting what is inside a string, after `//`, or
 * escaped (the `\(` of a regular expression).
 */
function openBrackets(text: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') i++;
    else if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '/' && text[i + 1] === '/') break;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  return depth;
}
/** The most lines after its first that one assertion is followed over; past it the bracket count is not trusted. */
const MAX_ASSERTION_LINES = 30;
interface Group { removed: Line[]; added: Line[] }
interface Block {
  oldPath: string | null;
  newPath: string | null;
  groups: Group[];
  /** Post-image lines the diff shows for this file: context and added. */
  after: string[];
}

function blocks(diff: string): Block[] {
  const out: Block[] = [];
  for (const text of diff.split(/^(?=diff --git )/m)) {
    if (!text.startsWith('diff --git ')) continue;
    const lines = text.split(/\r?\n/);
    const minus = /^--- (?:a\/)?(.+?)\s*$/m.exec(text)?.[1];
    const plus = /^\+\+\+ (?:b\/)?(.+?)\s*$/m.exec(text)?.[1];
    const head = /^diff --git a\/(.+?) b\/(.+?)$/.exec(lines[0]!);
    const isNew = /^new file mode/m.test(text) || minus === '/dev/null';
    const gone = /^deleted file mode/m.test(text) || plus === '/dev/null';
    const block: Block = {
      oldPath: isNew ? null : (/^rename from (.+?)\s*$/m.exec(text)?.[1] ?? (minus && minus !== '/dev/null' ? minus : head?.[1]) ?? null),
      newPath: gone ? null : (/^rename to (.+?)\s*$/m.exec(text)?.[1] ?? (plus && plus !== '/dev/null' ? plus : head?.[2]) ?? null),
      groups: [],
      after: [],
    };
    let oldNo = 0;
    let newNo = 0;
    let group: Group | null = null;
    let inHunk = false;
    // The assertion the file's OLD lines are inside, when one was opened on an earlier line of this hunk and its
    // brackets are not closed yet: `assert.equal(` / `second.err(),` / the expected text on a line of its own. A
    // removed line there is a changed assertion although the line itself has no assertion word in it.
    let open: { first: string; depth: number; left: number } | null = null;
    const oldLine = (text: string): string | undefined => {
      const within = open?.first;
      if (open) {
        open.depth += openBrackets(text);
        if (open.depth <= 0 || --open.left <= 0) open = null;
      } else if (!isComment(text) && matches('assertion', text)) {
        const depth = openBrackets(text);
        // A statement that ends on this line is not continued on the next, whatever the count says (a bracket in a
        // regular expression's character class is counted and is no bracket).
        if (depth > 0 && !/[;)]\s*(?:\/\/.*)?$/.test(text)) open = { first: text.trim(), depth, left: MAX_ASSERTION_LINES };
      }
      return within;
    };
    for (const l of lines) {
      const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (at) {
        oldNo = Number(at[1]);
        newNo = Number(at[2]);
        group = null;
        inHunk = true;
        open = null;
      } else if (!inHunk) {
        continue;
      } else if (l.startsWith('-')) {
        if (!group) block.groups.push((group = { removed: [], added: [] }));
        const within = oldLine(l.slice(1));
        group.removed.push({ no: oldNo++, text: l.slice(1), ...(within ? { within } : {}) });
      } else if (l.startsWith('+')) {
        if (!group) block.groups.push((group = { removed: [], added: [] }));
        group.added.push({ no: newNo++, text: l.slice(1) });
        block.after.push(l.slice(1));
      } else if (l.startsWith(' ')) {
        group = null;
        oldLine(l.slice(1));
        oldNo++;
        newNo++;
        block.after.push(l.slice(1));
      }
    }
    out.push(block);
  }
  return out;
}

/**
 * The comparisons one diff may spend on each search here that grows with the square of what the worker wrote: which
 * added file a deleted one became, and which new line a removed line became. The diff is the worker's to write and
 * this runs in the daemon: one block of 4 000 removed and 4 000 added lines in a test file (a regenerated snapshot,
 * 215 KB of diff) took five seconds, and the time went up fourfold with every doubling. Past the bound the answer
 * is the careful one — the file is listed as deleted, the line as removed with nothing in its place — so a finding
 * is never lost to it. No diff in the ledger comes within a factor of 500 of it.
 */
const MAX_COMPARISONS = 500_000;

/** Share of a deleted file's lines an added file must hold to be the same file under a new name (git's own default). */
const RENAME_SIMILARITY = 0.5;

/**
 * A deleted file and an added file that are one file renamed, as a single
 * modified block. git prints a rename as such only when its rename detection
 * is on, which a repo's config decides; this does not depend on it.
 */
function pairRenames(all: Block[]): Block[] {
  const added = all.filter((b) => b.oldPath === null && b.newPath !== null);
  const used = new Set<Block>();
  const out: Block[] = [];
  // Each added file's lines, collected once; and a bound on the looking-up (see MAX_COMPARISONS): past it a deleted
  // file is not paired with anything and is listed as deleted.
  const lines = new Map<Block, Set<string>>();
  const linesOf = (b: Block): Set<string> => {
    let have = lines.get(b);
    if (!have) lines.set(b, (have = new Set(b.groups.flatMap((g) => g.added).map((l) => norm(l.text)))));
    return have;
  };
  let spent = 0;
  for (const b of all) {
    if (used.has(b)) continue;
    if (b.newPath !== null || b.oldPath === null) {
      out.push(b);
      continue;
    }
    const gone = b.groups.flatMap((g) => g.removed).map((l) => norm(l.text)).filter(Boolean);
    let best: Block | null = null;
    let bestShare = 0;
    for (const cand of added) {
      if (used.has(cand)) continue;
      if ((spent += gone.length) > MAX_COMPARISONS) break;
      const have = linesOf(cand);
      const share = gone.length ? gone.filter((l) => have.has(l)).length / gone.length : 0;
      if (share > bestShare) [best, bestShare] = [cand, share];
    }
    if (best && bestShare >= RENAME_SIMILARITY) {
      used.add(best);
      out.push({ oldPath: b.oldPath, newPath: best.newPath, groups: [{ removed: b.groups.flatMap((g) => g.removed), added: best.groups.flatMap((g) => g.added) }], after: best.after });
    } else {
      out.push(b);
    }
  }
  return out.filter((b) => !used.has(b));
}

/** A modified test file as a finding names it: its path, or `old → new` when the diff also renames it. */
const fileLabel = (b: Block): string => (b.newPath && b.oldPath && b.newPath !== b.oldPath ? `${b.oldPath} → ${b.newPath}` : (b.oldPath ?? b.newPath ?? ''));

/** The names a line declares or assigns: `const saved = …`, `let { a, b: c } = …`, `x = …`. */
function declared(text: string): string[] {
  const m = /^\s*(?:(?:export\s+)?(?:const|let|var)\s+)?(\{[^=]*\}|\[[^=]*\]|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!=|>)/.exec(text);
  if (!m) return [];
  return [...m[1]!.matchAll(/(?:[\w$]+\s*:\s*)?([A-Za-z_$][\w$]*)/g)].map((x) => x[1]!).filter((n) => !/^(const|let|var)$/.test(n));
}

/** How alike two lines are: the share of their words (identifiers and numbers) they have in common. */
function alike(a: string, b: string): number {
  const words = (s: string): Set<string> => new Set(s.match(/[A-Za-z_$][\w$]*|\d+/g) ?? []);
  const x = words(a);
  const y = words(b);
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.max(1, x.size + y.size - both);
}
/** Below this a new line is not what a removed line became; the removed line is listed as removed. */
const REPLACEMENT_LIKENESS = 0.3;

/** The largest test file read from the tree to find the assertion that checks a redefined value. */
const MAX_TEST_FILE_BYTES = 2 * 1024 * 1024;
/** Findings kept; past it the run is flagged with the count and the first of them. */
const MAX_FINDINGS = 200;

/**
 * Everything in `diff` that removes or changes a pre-existing assertion. With
 * `treeDir` a redefined value's assertion is looked for in the whole file as
 * the work left it; without it, only in the lines the diff shows.
 */
export function changedAssertions(diff: string, treeDir: string | null = null): AssertionFinding[] {
  const out: AssertionFinding[] = [];
  let likened = 0;
  for (const b of pairRenames(blocks(diff))) {
    if (b.oldPath === null || !(isTestPath(b.oldPath) || (b.newPath !== null && isTestPath(b.newPath)))) continue;
    const file = fileLabel(b);
    const allRemoved = b.groups.flatMap((g) => g.removed);
    if (b.newPath === null) {
      const lost = allRemoved.filter((l) => !isComment(l.text));
      out.push({
        file, line: 1, kind: 'file', new: null,
        old: `the whole file: ${lost.filter((l) => matches('assertion', l.text)).length} assertion line(s), ${lost.filter((l) => matches('test', l.text)).length} test declaration(s)`,
      });
      continue;
    }
    // A line that is on both sides is a line that moved (or was reformatted): matched one for one, however far.
    const count = (lines: Line[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const l of lines) if (norm(l.text)) m.set(norm(l.text), (m.get(norm(l.text)) ?? 0) + 1);
      return m;
    };
    const addedLeft = count(b.groups.flatMap((g) => g.added));
    const removedLeft = count(allRemoved);
    const take = (left: Map<string, number>, text: string): boolean => {
      const n = left.get(norm(text)) ?? 0;
      if (n > 0) left.set(norm(text), n - 1);
      return n > 0;
    };
    // The first assertion line that uses each name (as a name of its own: not `x.name`, not part of a longer one),
    // read off once for the lines the diff shows and once for the file — not searched for again for every redefined
    // name, which cost the square of the file on a diff that redefines many.
    const firstUses = (lines: string[]): Map<string, string> => {
      const first = new Map<string, string>();
      for (const l of lines) {
        if (isComment(l) || !matches('assertion', l)) continue;
        for (const m of l.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) if (!first.has(m[0])) first.set(m[0], l);
      }
      return first;
    };
    let shown: Map<string, string> | undefined;
    let whole: Map<string, string> | null | undefined;
    const assertionOn = (name: string): string | null => {
      shown ??= firstUses(b.after);
      const use = shown.get(name);
      if (use !== undefined) return use;
      if (whole === undefined) {
        const text = treeDir ? readJailFile(treeDir, b.newPath!, MAX_TEST_FILE_BYTES) : null;
        whole = text === null ? null : firstUses(text.split(/\r?\n/));
      }
      return whole?.get(name) ?? null;
    };
    for (const g of b.groups) {
      const gone = g.removed.filter((l) => norm(l.text) && !take(addedLeft, l.text));
      const fresh = g.added.filter((l) => norm(l.text) && !take(removedLeft, l.text));
      // What stands where a removed line stood: the new line of the same change most like it, each used once.
      const stand = fresh.filter((l) => !isComment(l.text));
      for (const l of gone) {
        if (isComment(l.text)) continue;
        const like = (likened += stand.length) <= MAX_COMPARISONS ? stand.map((c) => alike(l.text, c.text)) : [];
        const best = like.indexOf(Math.max(-1, ...like));
        const replacement = best >= 0 && like[best]! >= REPLACEMENT_LIKENESS ? stand.splice(best, 1)[0]!.text.trim() : null;
        if (matches('assertion', l.text)) {
          out.push({ file, line: l.no, kind: 'assertion', old: l.text.trim(), new: replacement });
        } else if (l.within && /[\w'"`]/.test(l.text)) {
          // A later line of an assertion written over several lines (not its closing bracket alone).
          out.push({ file, line: l.no, kind: 'assertion', old: l.text.trim(), new: replacement, detail: l.within });
        } else if (matches('test', l.text)) {
          out.push({ file, line: l.no, kind: 'test', old: l.text.trim(), new: replacement });
        } else {
          const hit = declared(l.text).map((name) => ({ name, by: assertionOn(name) })).find((x) => x.by);
          if (hit?.by) {
            out.push({ file, line: l.no, kind: checksDirectly(hit.by, hit.name) ? 'asserted-value' : 'asserted-input', old: l.text.trim(), new: replacement, detail: hit.by.trim() });
          }
        }
      }
      for (const l of fresh) {
        if (!isComment(l.text) && matches('skip', l.text)) out.push({ file, line: l.no, kind: 'skip', old: null, new: l.text.trim() });
      }
    }
  }
  return out.slice(0, MAX_FINDINGS);
}

/**
 * Is `name` what the assertion on this line checks, or only something it hands to a call? Checked directly: the name
 * is an argument of the assertion itself (`assert.equal(saved, x)`, `expect(saved.steps)`, `assert.ok(saved.includes(…))`,
 * python's `assert saved == x`). Handed on: it sits inside a call inside the assertion (`assert.deepEqual(declared(root), [])`),
 * where what is checked is the call's result and the name is the fixture it was given. Kiln's narrowed
 * `const saved = …` is the first kind; the three fixtures a later Kiln ticket extended (`const root = project({…})`)
 * are the second, and holding the gate for those would teach the operator to wave the hold through.
 */
function checksDirectly(assertion: string, name: string): boolean {
  const word = new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`, 'g');
  // `saved.should.equal(…)` names its subject before the assertion word; every other style names it after.
  const start = /\.should\b/.test(assertion) ? 0 : Math.max(0, assertion.search(/\b(?:assert|expect|should)\b|\bt\.\w+\s*\(|\brequire\.\w+\(/));
  for (const m of assertion.matchAll(word)) {
    if (m.index < start) continue;
    let depth = 0;
    for (const ch of assertion.slice(start, m.index)) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
    }
    if (depth <= 1) return true;
  }
  return false;
}

/**
 * The findings of a kind that can hold the gate for a person: everything but a redefined fixture. Which of them DO
 * hold it on a given run is scopeHolds' to say, from the ticket and the diff.
 */
export const holds = (findings: AssertionFinding[]): AssertionFinding[] => findings.filter((f) => f.kind !== 'asserted-input');

/** What a ticket's text is read as naming: paths with a directory in them, and bare file names. */
interface Named { paths: Set<string>; bare: Set<string> }

/**
 * The files a text names. A word here is a whole run of path characters (letters, digits, `_ . - / ~`), so
 * `data.test.ts` is one word and is not `a.test.ts`, and neither is `a.test.ts.bak`; a sentence's closing full stop
 * and a leading `./` are dropped. A word with a directory in it is kept WITH its directories and is never read as its
 * last part — `src/x.test.ts` does not name `test/x.test.ts` — and one that is an absolute path counts only when it is
 * under the ticket's own repo, as the path below it. A word with no directory is a bare file name.
 */
function namedIn(text: string, repo: string | null): Named {
  const out: Named = { paths: new Set(), bare: new Set() };
  const roots = [repo, repo?.startsWith(`${os.homedir()}/`) ? `~${repo.slice(os.homedir().length)}` : null]
    .filter((r): r is string => Boolean(r))
    .map((r) => (r.endsWith('/') ? r : `${r}/`));
  for (const m of text.matchAll(/[\w.~/-]+/g)) {
    let w = m[0];
    let end = w.length;
    while (end > 0 && w[end - 1] === '.') end--;
    w = w.slice(0, end);
    const root = roots.find((r) => w.startsWith(r));
    if (root) w = w.slice(root.length);
    let start = 0;
    while (w.startsWith('./', start)) start += 2;
    w = w.slice(start);
    if (!w || w.startsWith('/') || w.startsWith('~')) continue;
    (w.includes('/') ? out.paths : out.bare).add(w);
  }
  return out;
}

/**
 * Is this repo-relative path one the text names? By its bare file name; by the path itself; or by the end of the path
 * from a directory boundary, with at least one directory (`verify/x.test.ts` names `test/verify/x.test.ts`). Exact
 * case, whole parts only. Shared with every matcher on file names (wave-3 review, F-7): a bare `index.test.ts` names
 * every file called that. Not shared: a path is never cut down to its last part, and an ordinary word (`node.js`)
 * counts for nothing unless a changed test file is called exactly that.
 */
function names(named: Named, file: string): boolean {
  if (!file) return false;
  if (named.bare.has(file.slice(file.lastIndexOf('/') + 1)) || named.paths.has(file)) return true;
  // Every entry of `paths` has a directory in it, so a tail that is the bare file name finds nothing there.
  for (let i = file.indexOf('/'); i >= 0; i = file.indexOf('/', i + 1)) if (named.paths.has(file.slice(i + 1))) return true;
  return false;
}

/**
 * A sentence that says to leave something as it is, or that something has to go on passing. A test file named in one
 * is not named as a file to change: `Do not change: test/sea.test.ts:263` and `the existing tests in test/ui.test.ts
 * pass unchanged` each released that file's findings (Kiln t_96e23dc2f3, t_4e32137aa4). Word tests only, no reading
 * of what the sentence is about: `in test/a.test.ts, don't pre-create b.txt` is held too, and a person is asked.
 */
const KEEP = /\b(?:do not|don['’]?t|never|must not|unchanged|unmodified|untouched|must (?:still )?pass|without (?:changing|touching|modifying|editing))\b/i;

/**
 * The text with every such sentence taken out: what the ticket asks to be changed. A sentence runs to the end of its
 * line, or to a `.`, `!` or `?` followed by a space and then anything but a small letter (`e.g. test/a.test.ts` stays
 * in its sentence; a `;` or a `:` does not end one). A line with such words that ends in a colon heads a list: the
 * lines up to the next blank one go with it. Whatever is in doubt is taken out — taking text out can only hold more.
 */
function asked(text: string): string {
  const out: string[] = [];
  let list = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) list = false;
    if (list) continue;
    out.push(line.split(/[.!?]\s+(?![a-z\s])/).filter((sentence) => !KEEP.test(sentence)).join('\n'));
    list = KEEP.test(line) && line.trimEnd().endsWith(':');
  }
  return out.join('\n');
}

/**
 * What a hold is decided against: text written before the run, and the repo its absolute paths are under. `filed`:
 * the ticket's words are a model's, written from what earlier runs produced, so `text` is empty.
 */
export interface TicketText { text: string; repo: string | null; filed?: boolean }

/** How an `improve:` ticket's title starts (improve.ts queueImprovement — core-guarded, so the words are repeated here; a test queues one). */
const IMPROVE_TITLE = 'improve: ';

/**
 * Whether the ticket's words were written by a model from what earlier runs produced, by any of the three marks such
 * a ticket carries. A follow-up a reviewer filed (crewReview fileIssues): its prompt starts with FILED_PREFIX, and
 * nothing rewrites a prompt. The same follow-up, and a ticket a worker queued from inside its run (the scheduler's
 * `enqueue`), by the column: its parent is a work ticket, where a planned ticket's parent is its epic and an
 * operator's ticket has none — on the ledger the prefix and the column agree on all 618 tasks. An `improve:`
 * proposal (improve.ts), written by a proposer model from the ledger's own error and review text. An operator's
 * ticket that happens to start with these words is held with them; that is the safe side. Throws when the parent
 * cannot be read (ticketText then releases nothing).
 */
function modelWritten(store: Store, task: Pick<Task, 'title' | 'prompt' | 'parentId'>): boolean {
  if (task.prompt.startsWith(FILED_PREFIX) || task.title.startsWith(IMPROVE_TITLE)) return true;
  if (task.parentId == null) return false;
  return store.getTask(task.parentId)?.isEpic !== true;
}

/**
 * The ticket's own words, for scopeHolds: the task row's title, prompt and acceptance, written before the run starts
 * and never rewritten. Nothing the worker writes is read — not its report, its commit message or its diff — and
 * neither are the repair notes or the standing operator demands, which carry a reviewer's or the owner model's words
 * about the worker's output. For the same reason a ticket a model wrote from run output (modelWritten) is not read
 * at all: on the ledger 37 of the 105 runs that naming released were on reviewer-filed follow-ups
 * (assertion-hold-scope review r1). Nor is a note given on a retry: the `decisions` row says `human` for any process
 * that calls the route (it has no credential; a worker is not sandboxed and can reach it), and the note an operator
 * pastes there is as often a reviewer's "ready-to-paste retry note" as their own words. Null when the task cannot be
 * read: then nothing is released.
 */
export function ticketText(store: Store, taskId: string): TicketText | null {
  try {
    const task = store.getTask(taskId);
    if (!task || typeof task.title !== 'string' || typeof task.prompt !== 'string') return null;
    if (task.acceptance != null && typeof task.acceptance !== 'string') return null;
    const filed = modelWritten(store, task);
    // A blank line between the three, so a title or a prompt that ends in a colon heads no list in the next (asked).
    return { filed, text: filed ? '' : [task.title, task.prompt, task.acceptance ?? ''].join('\n\n'), repo: typeof task.repo === 'string' && task.repo ? task.repo : null };
  } catch {
    return null;
  }
}

/**
 * The findings, each marked with whether it holds the gate for a person (AssertionFinding.hold). A finding of a kind
 * that can hold is released only when the ticket names its file in a sentence that does not say to leave something as
 * it is (asked) — for a renamed file, the name it had before the run,
 * where the assertions were (read from the diff, not out of the finding's label). Nothing the diff does releases one:
 * not a new test beside it. Everything else is held, and so is everything when in doubt: no ticket text, a finding with no file, a list cut at MAX_FINDINGS (what was cut is in
 * files nobody looked at), or a failure in here.
 */
export function scopeHolds(findings: AssertionFinding[], diff: string, ticket: TicketText | null): AssertionFinding[] {
  const mark = (f: AssertionFinding, hold: NonNullable<AssertionFinding['hold']>): AssertionFinding => (f.kind === 'asserted-input' ? f : { ...f, hold });
  if (!ticket || typeof ticket.text !== 'string' || findings.length >= MAX_FINDINGS) return findings.map((f) => mark(f, 'held-unread'));
  try {
    const named = namedIn(asked(ticket.text), ticket.repo);
    const mentioned = namedIn(ticket.text, ticket.repo);
    const files = new Map<string, Block>();
    for (const b of pairRenames(blocks(diff))) if (b.oldPath !== null && b.newPath !== null) files.set(fileLabel(b), b);
    return findings.map((f) => {
      if (typeof f.file !== 'string' || !f.file) return mark(f, 'held-unread');
      const b = files.get(f.file);
      // A deleted file has no block here and its label is its path; a modified one is named by its old path.
      const was = b ? b.oldPath! : f.file;
      return mark(f, ticket.filed ? 'held-filed' : names(named, was) ? 'named' : names(mentioned, was) ? 'held-kept' : 'held');
    });
  } catch {
    return findings.map((f) => mark(f, 'held-unread'));
  }
}

/** The findings that hold the gate on the run they were recorded for. */
export const heldFor = (findings: AssertionFinding[]): AssertionFinding[] => findings.filter((f) => f.hold === 'held' || f.hold === 'held-unread' || f.hold === 'held-filed' || f.hold === 'held-kept');

/** "the diff changes pre-existing assertions: 2 in test/a.test.ts, test/b.test.ts" — the hold a person sees. */
export function assertionFlag(findings: AssertionFinding[]): string {
  const files = [...new Set(findings.map((f) => f.file))];
  const shown = files.slice(0, 4).join(', ') + (files.length > 4 ? ` and ${files.length - 4} more` : '');
  return `the diff changes pre-existing assertions: ${findings.length}${findings.length >= MAX_FINDINGS ? ' or more' : ''} in ${shown}`;
}

const KIND: Record<AssertionFinding['kind'], string> = {
  assertion: 'assertion removed or changed',
  'asserted-value': 'the value an assertion checks was redefined',
  'asserted-input': 'a value handed to an asserted call was redefined (a fixture: for the reviewer to read, not a hold on its own)',
  test: 'test declaration removed or changed',
  skip: 'skip, only or todo added',
  file: 'test file deleted',
};

/** What the reviewer is told of a recorded finding's hold; nothing for a finding that carries none. */
const HOLD: Record<NonNullable<AssertionFinding['hold']>, string> = {
  held: 'held for a person — the ticket does not name this file',
  'held-unread': 'held for a person — the ticket, the diff or the whole list of findings could not be read, so nothing is released',
  'held-filed': 'held for a person — this ticket was written by a model from what earlier runs produced (a reviewer\'s follow-up, an improvement proposal): its words release nothing',
  'held-kept': 'held for a person — the ticket names this file only where it says to leave something as it is or that it has to pass',
  named: 'not held for a person — the ticket names this file',
};

const short = (text: string, max = 240): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The block a reviewer is given, at most `maxBytes`; the count of what did not fit is said. */
export function assertionNote(findings: AssertionFinding[], maxBytes = 6_000): string {
  if (!findings.length) return '';
  const head =
    'FOREMAN CHECK (deterministic): pre-existing assertions this diff removed or changed — each needs a reason the ticket gives; ' +
    'a narrowed assertion with no such reason is a blocker. (Lines that only moved or were reformatted are not listed.)';
  const lines: string[] = [];
  let used = head.length + 80;
  let shown = 0;
  for (const f of findings) {
    const entry =
      `- ${f.file}:${f.line} — ${KIND[f.kind]}\n` +
      (f.old ? `    was: ${short(f.old)}\n` : '') +
      `    now: ${f.new ? short(f.new) : '(removed)'}` +
      (f.detail ? `\n    ${f.kind === 'assertion' ? 'a line of' : 'checked by'}: ${short(f.detail)}` : '') +
      (f.hold && Object.hasOwn(HOLD, f.hold) ? `\n    gate: ${HOLD[f.hold]}` : '');
    if (used + entry.length + 1 > maxBytes) break;
    lines.push(entry);
    used += entry.length + 1;
    shown++;
  }
  const rest = findings.length - shown;
  return [head, ...lines, rest > 0 ? `… and ${rest} more, in ${[...new Set(findings.slice(shown).map((f) => f.file))].slice(0, 6).join(', ')}` : ''].filter(Boolean).join('\n');
}

/**
 * Run the check on a run's diff and record what it finds: the findings as a
 * JSON file under the artifact root and an `assertions` artifact row whose
 * summary is the hold (gate.ts reviewHolds reads the row). Returns the note
 * for the reviewers, or null when the diff changes no pre-existing assertion.
 *
 * Which findings hold is decided HERE, once, against the ticket as it reads
 * now, and stored: the row's summary names the held findings' files (or is
 * null), and each finding in the JSON file carries its own `hold`. Nothing
 * later re-decides it — no later step that rewrites task text can release
 * this run's hold.
 */
export function recordAssertionChanges(store: Store, runId: string, taskId: string, diff: string, treeDir: string | null): string | null {
  const found = changedAssertions(diff, treeDir);
  if (!found.length) return null;
  const findings = scopeHolds(found, diff, ticketText(store, taskId));
  const file = path.join(config.artifactRoot, `${runId}.assertions.json`);
  fs.mkdirSync(config.artifactRoot, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(findings, null, 2)}\n`);
  // The row's summary IS the hold (assertionHold). Null when nothing found holds — a redefined fixture, a file the
  // ticket names: the reviewer is still given the whole list, and the file is still kept, but nothing is held for a
  // person.
  const holding = heldFor(findings);
  store.addArtifact({ runId, taskId, type: 'assertions', path: file, summary: holding.length ? assertionFlag(holding) : null });
  return assertionNote(findings);
}

/**
 * The hold recorded for a run by recordAssertionChanges, or null. Keyed on the run's artifact row — Foreman's own
 * record, which nothing rewrites — not on a status note: a row with a summary is a hold, a row without one is a
 * list that was only for the reviewer.
 */
export function assertionHold(store: Store, run: Run | null): string | null {
  if (!run) return null;
  const row = store.artifactsForTask(run.taskId).filter((a) => a.type === 'assertions' && a.runId === run.id).at(-1);
  return row?.summary?.trim() ? row.summary : null;
}

/** The reviewer note for a run whose findings were recorded earlier (a re-review); null when there are none to read. */
export function storedAssertionNote(store: Store, run: Run): string | null {
  const row = store.artifactsForTask(run.taskId).filter((a) => a.type === 'assertions' && a.runId === run.id).at(-1);
  if (!row) return null;
  try {
    const st = fs.lstatSync(row.path);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    const findings = JSON.parse(fs.readFileSync(row.path, 'utf8')) as AssertionFinding[];
    return Array.isArray(findings) ? assertionNote(findings) || null : null;
  } catch {
    return null;
  }
}
