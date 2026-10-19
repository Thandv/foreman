// Ported from the author's earlier tools.
//
// Rule-based dialogue speaker attribution. For every paragraph: split it into
// narration / quoted-dialogue segments, then for each dialogue segment —
//   1. look for an explicit tag ("...," X said. / X said, "...")
//   2. otherwise, if this paragraph is pure back-and-forth dialogue and the
//      previous paragraph ended on a known speaker, alternate between the
//      two most recent named speakers in the scene
//   3. otherwise, carry the last-named speaker forward
//   4. otherwise, NARRATOR
// Attribution state (named speakers, pronoun map, alternation history) resets
// at every scene break, exactly as in the original.
//
// TWO DELIBERATE DEVIATIONS FROM THE ORIGINAL, both required by this tool's
// stdin/stdout contract (text in, no side-channel cast list):
//
//  1. `attribute_book()` in the original takes a pre-supplied `cast: set[str]`
//     of known character names. This tool has no such input, so it runs a
//     preliminary pass over the whole manuscript (`discoverCast`) looking for
//     capitalized names adjacent to a dialogue verb, and uses that as the
//     book's cast. This is strictly weaker than a curated cast (it can miss a
//     character who is never explicitly tagged, or mis-admit a proper noun
//     that happens to sit next to "said"), but it needs no external data.
//
//  2. The original's `DEFAULT_PRONOUNS` was a hand-built he/she/they map for
//     one specific manuscript's cast — it does not generalize. It is dropped
//     here rather than ported; `pronoun_to_speaker` is still threaded through
//     exactly as in the original; it simply never gets seeded (no gender
//     data), so pronoun-tag resolution ("she said" with no name in sight)
//     falls through to carry-forward/alternation like any other unattributed
//     line, rather than resolving directly. The state machine shape — and
//     its confidence levels — are otherwise unchanged.
//
// This port also records, per utterance, *how* its speaker was decided
// (explicit / carry / alternation / narrator) — the original discarded that
// distinction. And it keeps each line's originating scene, rather than
// flattening a chapter's scenes together as `attribute_book()` did, because
// the alternation window is a per-scene concept and a caller inspecting the
// output needs to know where a scene boundary reset it.

// --- Minimal manuscript splitter, duplicated from parse-manuscript/tool.js ---
// Toolbox tools are self-contained and may not import each other (see
// toolbox/README.md), so the slice of the parser this needs — chapter/scene/
// paragraph boundaries reduced to plain text, dropping spans/subtitle/title —
// is duplicated here rather than shared. See parse-manuscript/tool.js for the
// full port (and its own header, which credits the original parser.py).
// Chapter numbers may be digits, a Roman numeral, or spelled out, exactly as
// in parse-manuscript (a book headed "# Chapter One" must not come back empty).
const NUM_UNITS = 'one|two|three|four|five|six|seven|eight|nine';
const NUM_TEENS = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const NUM_TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const NUM_WORDS = `(?:(?:${NUM_TENS})(?:[- ](?:${NUM_UNITS}))?|${NUM_TEENS}|${NUM_UNITS})`;
const CHAPTER_HEAD_RE = new RegExp(
  `^# +(PROLOGUE|CHAPTER +(?:\\d+|[IVXLCDM]+|${NUM_WORDS})|INTERLUDE|CODA|PART +[A-Z]+|EPILOGUE)\\b`,
  'i',
);
const ROMAN_RE = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
/** A "CHAPTER <romanish>" match counts only for a well-formed numeral in one
 * case ("IV"/"iv"), so "Chapter Mix" is not a chapter heading. */
function isChapterHeadMatch(headMatch) {
  const m = /^CHAPTER +([IVXLCDM]+)$/i.exec(headMatch);
  if (!m) return true;
  const tok = m[1];
  if (tok !== tok.toUpperCase() && tok !== tok.toLowerCase()) return false;
  return ROMAN_RE.test(tok.toUpperCase());
}
const SKIP_HEAD_RE = /^# +(THE +.+|A +NOTE +ON|END +OF +BOOK|FROM +.+JOURNAL)/i;
const SUBHEAD_RE = /^#{2,4} +(.+)/;
const SCENE_BREAK_RE = /^-{3,}\s*$/;
const ITALIC_MARK_RE = /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)|(?<!_)_(?!_)([^_\n]+?)_(?!_)/g;

function stripMdInline(text) {
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return text;
}

function plainText(line) {
  line = stripMdInline(line);
  ITALIC_MARK_RE.lastIndex = 0;
  return line.replace(ITALIC_MARK_RE, (m, g1, g2) => g1 ?? g2 ?? '');
}

function normalizeParagraphText(buf) {
  return buf.map((s) => s.trim()).filter(Boolean).join(' ');
}

function parseChapters(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
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
    const t = plainText(normalizeParagraphText(paraBuf));
    if (t) currentScene.paragraphs.push(t);
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
      current = { number: chapters.length + 1, scenes: [] };
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
  for (const ch of chapters) ch.scenes = ch.scenes.filter((s) => s.paragraphs.length);
  return chapters.filter((c) => c.scenes.length);
}
// --- end duplicated parser slice ---

const QUOTE_PAIRS = [
  ['“', '"'],
  ['”', '"'],
  ['‘', "'"],
  ['’', "'"],
];

const DIALOGUE_VERBS = [
  'said', 'asked', 'replied', 'answered', 'whispered', 'muttered', 'shouted', 'called', 'cried',
  'yelled', 'breathed', 'murmured', 'snapped', 'told', 'sighed', 'grunted', 'hissed', 'added',
  'continued', 'began', 'barked', 'laughed', 'repeated', 'nodded', 'noted', 'admitted',
  'agreed', 'countered', 'insisted', 'interrupted', 'offered', 'warned', 'growled',
  'objected', 'prompted', 'drawled', 'conceded', 'observed', 'remarked', 'wondered',
];
const DV_RE = `(?:${DIALOGUE_VERBS.join('|')})`;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeQuotes(text) {
  for (const [a, b] of QUOTE_PAIRS) text = text.split(a).join(b);
  return text;
}

/** Split text into (segment, isQuoted) chunks — a naive double-quote tokenizer. */
function splitQuotedSegments(text) {
  const parts = [];
  let buf = [];
  let inside = false;
  for (const ch of text) {
    if (ch === '"') {
      if (buf.length) {
        parts.push([buf.join(''), inside]);
        buf = [];
      }
      inside = !inside;
    } else {
      buf.push(ch);
    }
  }
  if (buf.length) parts.push([buf.join(''), inside]);
  return parts;
}

function candidateSpeakersPattern(cast) {
  const names = [...cast].sort((a, b) => b.length - a.length);
  if (!names.length) return '_NEVER_';
  return names.map(escapeRegExp).join('|');
}

/** Find a speaker named in a dialogue-tag fragment adjacent to a quoted utterance. */
function findTagSpeaker(fragment, cast, pronounToSpeaker) {
  if (!fragment.trim()) return null;
  const names = candidateSpeakersPattern(cast);

  let m = fragment.match(new RegExp(`\\b(${names})\\b\\s+${DV_RE}\\b`));
  if (m) return m[1];
  m = fragment.match(new RegExp(`\\b${DV_RE}\\b\\s+(${names})\\b`));
  if (m) return m[1];

  m = fragment.match(new RegExp(`\\b(he|she|they)\\b\\s+${DV_RE}\\b`, 'i'));
  if (m) return pronounToSpeaker[m[1].toLowerCase()] ?? null;
  m = fragment.match(new RegExp(`\\b${DV_RE}\\b\\s+(he|she|they)\\b`, 'i'));
  if (m) return pronounToSpeaker[m[1].toLowerCase()] ?? null;

  // Bare named subject ("X frowned. ...") — only right at the start of the fragment.
  m = fragment.match(new RegExp(`^\\s*(?:,?\\s*)?\\b(${names})\\b`));
  if (m) return m[1];

  return null;
}

/** Alternation partner for an unattributed dialogue paragraph following another. */
function alternateSpeaker(state) {
  const last = state.lastParagraphDialogueSpeaker;
  const distinct = state.namedSpeakers.filter((s) => s !== '_OTHER');
  if (distinct.length >= 2) {
    const mostRecent = distinct.includes(last) ? last : distinct[distinct.length - 1];
    for (let i = distinct.length - 1; i >= 0; i--) {
      if (distinct[i] !== mostRecent) return distinct[i];
    }
    return mostRecent;
  }
  if (distinct.length === 1) {
    return last === distinct[0] ? '_OTHER' : distinct[0];
  }
  return null;
}

function freshSceneState() {
  return { lastSpeakerHistory: [], pronounToSpeaker: {}, namedSpeakers: [], lastParagraphDialogueSpeaker: null };
}

/** Attribute one paragraph's utterances, mutating `state`. See file header for the confidence levels. */
function attributeParagraph(text, cast, state, pronouns) {
  text = normalizeQuotes(text);
  const segments = splitQuotedSegments(text);

  if (!segments.some(([, q]) => q)) {
    const t = text.trim();
    return t ? [{ speaker: 'NARRATOR', text: t, isDialogue: false, confidence: 'narrator' }] : [];
  }

  const utterances = [];
  let lastDialogueSpeakerThisPara = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i][0].trim();
    const quoted = segments[i][1];
    if (!seg) continue;
    if (!quoted) {
      utterances.push({ speaker: 'NARRATOR', text: seg, isDialogue: false, confidence: 'narrator' });
      continue;
    }

    let speaker = null;
    let explicit = false;
    if (i + 1 < segments.length && !segments[i + 1][1]) {
      speaker = findTagSpeaker(segments[i + 1][0], cast, state.pronounToSpeaker);
      if (speaker !== null) explicit = true;
    }
    if (speaker === null && i > 0 && !segments[i - 1][1]) {
      speaker = findTagSpeaker(segments[i - 1][0], cast, state.pronounToSpeaker);
      if (speaker !== null) explicit = true;
    }

    let confidence;
    if (speaker !== null) {
      confidence = 'explicit';
    } else {
      const isPureDialogue = segments.every(([s, q]) => !s.trim() || q);
      if (isPureDialogue && state.lastParagraphDialogueSpeaker !== null) {
        speaker = alternateSpeaker(state);
        if (speaker !== null) confidence = 'alternation';
      }
      if (speaker === null) {
        if (state.lastSpeakerHistory.length) {
          speaker = state.lastSpeakerHistory[state.lastSpeakerHistory.length - 1];
          confidence = 'carry';
        } else {
          speaker = 'NARRATOR';
          confidence = 'narrator';
        }
      }
    }

    utterances.push({ speaker, text: seg, isDialogue: true, confidence });
    lastDialogueSpeakerThisPara = speaker;

    if (speaker !== 'NARRATOR') {
      state.lastSpeakerHistory.push(speaker);
      if (explicit && !state.namedSpeakers.includes(speaker)) state.namedSpeakers.push(speaker);
      const pronoun = pronouns[speaker];
      if (pronoun) {
        state.pronounToSpeaker[pronoun] = speaker;
        if (!('they' in state.pronounToSpeaker)) state.pronounToSpeaker.they = speaker;
      }
    }
  }

  state.lastParagraphDialogueSpeaker = lastDialogueSpeakerThisPara;
  return utterances;
}

const NAME_STOPWORDS = new Set([
  'He', 'She', 'They', 'It', 'I', 'We', 'You', 'The', 'A', 'An', 'This', 'That',
  'These', 'Those', 'His', 'Her', 'Their', 'Its', 'And', 'But', 'So', 'Then',
]);

/** No pre-supplied cast is available (see file header) — discover candidate
 *  names from capitalized words adjacent to a dialogue verb, across the whole
 *  manuscript. */
function discoverCast(text) {
  const cast = new Set();
  const nameToken = "[A-Z][a-zA-Z'’-]*";
  const patterns = [
    new RegExp(`\\b(${nameToken})\\b\\s+${DV_RE}\\b`, 'g'),
    new RegExp(`\\b${DV_RE}\\b\\s+(${nameToken})\\b`, 'g'),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!NAME_STOPWORDS.has(m[1])) cast.add(m[1]);
    }
  }
  return cast;
}

function attributeBook(text) {
  const chapters = parseChapters(text);
  const cast = discoverCast(text);
  // DEFAULT_PRONOUNS dropped — see file header. Left empty and threaded
  // through unchanged so the state machine shape matches the original.
  const pronouns = {};

  const lines = [];
  const speakers = [];
  const seenSpeakers = new Set();

  for (const ch of chapters) {
    ch.scenes.forEach((scene, sceneIdx) => {
      const state = freshSceneState();
      for (const paraText of scene.paragraphs) {
        const utterances = attributeParagraph(paraText, cast, state, pronouns);
        for (const u of utterances) {
          if (u.confidence === 'explicit' && u.speaker !== 'NARRATOR' && !seenSpeakers.has(u.speaker)) {
            seenSpeakers.add(u.speaker);
            speakers.push(u.speaker);
          }
          lines.push({ chapter: ch.number, scene: sceneIdx + 1, speaker: u.speaker, confidence: u.confidence, text: u.text });
        }
      }
    });
  }

  return { speakers, lines };
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
  process.stdout.write(JSON.stringify(attributeBook(args.text)));
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
