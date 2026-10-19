// Ported from the author's earlier tools.
//
// Markdown manuscript parser. Produces a structured Book of Chapters ->
// Scenes -> Paragraphs -> Spans, preserving italics and scene boundaries the
// way the original did for downstream audiobook staging. This port takes
// manuscript text directly (the original took a file path) and returns the
// title only when the same top-of-file heuristic that found it in the
// original finds one — it does not fall back to a filename, since a
// stdin/stdout tool has no filename to fall back to.

// Headings that begin a new top-level chapter entry. The chapter number may
// be digits, a Roman numeral, or spelled out ("Chapter Twenty-One") — a
// manuscript headed "# Chapter One" would otherwise yield no chapters at all.
const NUM_UNITS = 'one|two|three|four|five|six|seven|eight|nine';
const NUM_TEENS = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const NUM_TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const NUM_WORDS = `(?:(?:${NUM_TENS})(?:[- ](?:${NUM_UNITS}))?|${NUM_TEENS}|${NUM_UNITS})`;
const CHAPTER_HEAD_RE = new RegExp(
  `^# +(PROLOGUE|CHAPTER +(?:\\d+|[IVXLCDM]+|${NUM_WORDS})|INTERLUDE|CODA|PART +[A-Z]+|EPILOGUE)\\b`,
  'i',
);
// Book title / appendix-style top headings to skip.
const SKIP_HEAD_RE = /^# +(THE +.+|A +NOTE +ON|END +OF +BOOK|FROM +.+JOURNAL)/i;
// Sub-heading lines treated as a chapter's subtitle / dateline.
const SUBHEAD_RE = /^#{2,4} +(.+)/;
// Horizontal rule scene break.
const SCENE_BREAK_RE = /^-{3,}\s*$/;
// Markdown italic spans: `*...*` or `_..._`, but not bold `**...**`.
const ITALIC_RE = /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)|(?<!_)_(?!_)([^_\n]+?)_(?!_)/g;

function stripMdInline(text) {
  // Bold ** ** -> just the inner text.
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  // Inline code `...` -> drop backticks.
  text = text.replace(/`([^`]+)`/g, '$1');
  // Markdown links [text](url) -> text.
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return text;
}

function spansFromLine(line) {
  line = stripMdInline(line);
  const spans = [];
  let last = 0;
  ITALIC_RE.lastIndex = 0;
  let m;
  while ((m = ITALIC_RE.exec(line)) !== null) {
    if (m.index > last) spans.push({ text: line.slice(last, m.index), italic: false });
    const inner = m[1] ?? m[2] ?? '';
    if (inner) spans.push({ text: inner, italic: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) ITALIC_RE.lastIndex++; // guard against a zero-width match
  }
  if (last < line.length) spans.push({ text: line.slice(last), italic: false });
  return spans.filter((s) => s.text);
}

function normalizeParagraphText(buf) {
  return buf.map((s) => s.trim()).filter(Boolean).join(' ');
}

/** Python's str.title(): capitalize the first letter of every run of
 *  letters and lowercase the rest — including its well-known apostrophe
 *  quirk ("don't" -> "Don'T"), preserved here for faithfulness. */
function pyTitleCase(raw) {
  return raw.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

const ROMAN_RE = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

/** The Roman numeral in a "CHAPTER <x>" heading match, or null. A numeral
 * counts only when it is all upper or all lower case and well-formed, so a
 * word like "Mix" or "Did" is not mistaken for one. */
function chapterRoman(headMatch) {
  const m = /^CHAPTER +([IVXLCDM]+)$/i.exec(headMatch);
  if (!m) return null;
  const tok = m[1];
  if (tok !== tok.toUpperCase() && tok !== tok.toLowerCase()) return null;
  return ROMAN_RE.test(tok.toUpperCase()) ? tok.toUpperCase() : null;
}

function isChapterHeadMatch(headMatch) {
  return !/^CHAPTER +[IVXLCDM]+$/i.test(headMatch) || chapterRoman(headMatch) !== null;
}

function classifyChapterTitle(raw) {
  raw = raw.trim();
  const roman = chapterRoman(raw);
  if (roman) return `Chapter ${roman}`; // not title-cased to "Chapter Iv"
  return pyTitleCase(raw).replace(/\s+/g, ' ');
}

function parseManuscript(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Extract book title from the very top of the file — the first "# " line
  // that isn't itself a chapter heading, within the first 15 lines.
  let bookTitle;
  for (const raw of lines.slice(0, 15)) {
    const ln = raw.trim();
    const head = CHAPTER_HEAD_RE.exec(ln);
    if (ln.startsWith('# ') && !(head && isChapterHeadMatch(head[1]))) {
      bookTitle = stripMdInline(ln.slice(2)).trim();
      break;
    }
  }

  const chapters = [];
  let current = null;
  let currentScene = null;
  let paraBuf = [];
  let expectSubtitle = false;
  let expectDateline = false;

  function flushParagraph() {
    if (!paraBuf.length || current === null || currentScene === null) {
      paraBuf = [];
      return;
    }
    const text2 = normalizeParagraphText(paraBuf);
    if (text2) currentScene.paragraphs.push({ spans: spansFromLine(text2) });
    paraBuf = [];
  }

  function newScene() {
    if (current === null) return;
    flushParagraph();
    currentScene = { paragraphs: [] };
    current.scenes.push(currentScene);
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    const mChap = CHAPTER_HEAD_RE.exec(line);
    if (mChap && isChapterHeadMatch(mChap[1])) {
      flushParagraph();
      current = { number: chapters.length + 1, title: classifyChapterTitle(mChap[1]), scenes: [] };
      chapters.push(current);
      currentScene = { paragraphs: [] };
      current.scenes.push(currentScene);
      expectSubtitle = true;
      expectDateline = false;
      continue;
    }

    if (line.startsWith('# ') && SKIP_HEAD_RE.test(line)) {
      current = null;
      currentScene = null;
      continue;
    }

    if (current !== null && expectSubtitle) {
      const mSub = SUBHEAD_RE.exec(line);
      if (mSub) {
        current.subtitle = stripMdInline(mSub[1]).trim();
        expectSubtitle = false;
        expectDateline = true;
        continue;
      }
      if (line.trim() === '') continue;
      expectSubtitle = false;
      expectDateline = true;
    }

    if (current !== null && expectDateline) {
      const stripped = line.trim();
      if (stripped.startsWith('*') && stripped.endsWith('*') && (stripped.match(/\*/g) ?? []).length === 2) {
        current.dateline = stripped.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').trim();
        expectDateline = false;
        continue;
      }
      if (stripped === '' || SCENE_BREAK_RE.test(stripped)) continue;
      expectDateline = false;
    }

    if (current === null) continue;

    if (SCENE_BREAK_RE.test(line)) {
      newScene();
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    if (line.startsWith('#')) {
      flushParagraph();
      continue;
    }

    paraBuf.push(line);
  }
  flushParagraph();

  // Drop empty scenes (back-to-back breaks) and then empty chapters.
  for (const ch of chapters) {
    ch.scenes = ch.scenes.filter((s) => s.paragraphs.length);
  }
  const nonEmptyChapters = chapters.filter((c) => c.scenes.length);

  const result = { chapters: nonEmptyChapters };
  if (bookTitle) result.title = bookTitle;
  return result;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    process.stderr.write(`stdin was not valid JSON: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (!args || typeof args !== 'object' || typeof args.text !== 'string') {
    process.stderr.write('input must be a JSON object with a string "text" field\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(parseManuscript(args.text)));
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
