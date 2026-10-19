// Ported from the author's earlier novel-writing app, trimmed to Foreman's zero-dep conventions.
/**
 * The AI-tics & prose gate — a de-AI pass distilled from the user's portable
 * gate ("AI Tics & Prose Gate"). Two layers: HARD BANS (cut on sight) and
 * JUDGEMENT TELLS (cap and recast), plus cadence/burstiness checks that word
 * lists can't catch.
 *
 * The golden rule: don't just DELETE a tic — replace it with something truer,
 * more specific, or more lyrical. Sterile, hedge-free, perfectly-even prose is
 * ALSO an AI tell. The goal is aliveness, not compliance.
 *
 * Used three ways: `ticsInstruction()` is injected into every generation prompt
 * so the model avoids these up front; `scanTics()` flags what slips through; in
 * hard mode the engine re-prompts a cheap model to recast the flagged bits.
 * A project can drop an `ai-tics.local.json` to extend/override the lists.
 */

export interface TicFinding {
  kind: 'word' | 'phrase' | 'pattern' | 'density';
  match: string;
  index: number;
  note: string;
}

export interface TicOverrides {
  words?: string[];
  phrases?: string[];
  allow?: string[];
}

// --- overused single words (essay-flavoured + purple-prose tells) ------------
const WORD_TICS: string[] = [
  'delve', 'delved', 'delving', 'tapestry', 'testament', 'realm', 'landscape',
  'underscore', 'underscores', 'underscored', 'showcase', 'showcases', 'showcasing',
  'leverage', 'utilize', 'myriad', 'plethora', 'boasts', 'nestled', 'bustling',
  'vibrant', 'poignant', 'evocative', 'resonate', 'resonated', 'resonates',
  'profound', 'pivotal', 'seamless', 'seamlessly', 'robust', 'palpable',
  'ever-evolving', 'symphony', 'cacophony', 'maelstrom', 'whirlwind',
  'ministrations', 'orbs', 'newfound', 'inexorably', 'inexplicably',
  'undoubtedly', 'meticulous', 'meticulously', 'ethereal', 'liminal',
];

// --- clichéd multi-word phrases + summary caps -------------------------------
const PHRASE_TICS: string[] = [
  'a testament to', 'rich tapestry', 'tapestry of', 'a symphony of', 'a dance of',
  'a mixture of', 'a blend of', 'a myriad of', 'sent a shiver', 'shiver down',
  'shiver ran down', 'chill ran down', 'down her spine', 'down his spine',
  'barely above a whisper', 'voice barely above', 'the air was thick',
  'heart hammered', 'heart pounded', 'heart raced', 'breath hitched',
  "breath she didn't know", "didn't know she was holding", 'knuckles white',
  'white-knuckled', 'a wave of', 'washed over her', 'a ghost of a smile',
  'ghost of a', 'unshed tears', 'the weight of the world', 'time seemed to',
  'the tension was palpable', 'in the depths of', 'a beacon of', 'navigating the',
  'in the realm of', 'a treasure trove', 'game changer', 'game-changer',
  // summary caps (over-explaining — Trust the reader)
  'which was to say', 'in other words', 'and that changed everything',
  'which was her way of saying', 'which was his way of saying', 'needless to say',
];

// --- structural patterns -----------------------------------------------------
interface Pattern {
  /** P3.6(a): vocabulary, not structure — police the narrator, not the cast */
  narrationOnly?: boolean;
  re: RegExp;
  note: string;
}
const PATTERN_TICS: Pattern[] = [
  // ---- HARD BANS (cut on sight) ----
  { re: /\bnot (just|only|merely)\b[^.?!]{1,60}?\bbut\b/gi, note: 'HARD BAN: the "not just X, but Y" contrast formula' },
  { re: /\bit (wasn't|was not|isn't|is not)\b[^.?!]{1,60}?\bit (was|is)\b/gi, note: 'HARD BAN: the "it wasn\'t X, it was Y" contrast formula' },
  { re: /\bmore than (a |an )?[^.?!,—-]{1,40}[—-][^.?!]{0,20}\bit (was|is)\b/gi, note: 'HARD BAN: the "more than a X — it was Y" formula' },
  { re: /\bnot-[a-z]+/g, note: 'HARD BAN: coined "not-X" word — say the true thing' },
  { re: /\bNot [A-Z][a-z]+\.\s+Not\b/g, note: 'HARD BAN: negation catalogue ("Not this. Not that.")' },
  { re: /\bNo [A-Za-z]+\.\s+No [A-Za-z]+\.\s+No\b/g, note: 'HARD BAN: negation catalogue ("No X. No Y. No Z.")' },
  // NARRATION-ONLY: these are vocabulary, and vocabulary is how people talk.
  // "It was kind of a mess," in a character's mouth is dialogue doing its job.
  { re: /\b(the kind of|sort of|type of)\b/gi, note: 'HARD BAN: pseudo-profound wrapper ("the kind of… that") — cut the wrapper', narrationOnly: true },
  // P3.6(g): this used to be a HARD BAN while the creed's central value is "the
  // exact, particular detail" — the gate and the intent were telling the model
  // opposite things about the same word, and in hard mode the gate always won.
  // The tell is the EMPTY qualifier ("the specific way in which"), not the word:
  // "the particular blue of that door" is the creed working.
  { re: /\bthe (particular|specific|precise) (way|manner|kind|sort|nature|sense) (in which|that|of)\b/gi, note: 'HARD BAN: empty qualifier ("the specific way in which") — name the thing' },
  // ---- JUDGEMENT TELLS ----
  { re: /\bin a way that\b/gi, note: 'tell: "in a way that" — recast concrete', narrationOnly: true },
  { re: /\b(as though|almost as if)\b/gi, note: 'tell: "as though / almost as if" — use a concrete image' },
  { re: /\bthere was something\b[^.?!]{0,30}\babout\b/gi, note: 'tell: "there was something … about" — name it' },
  { re: /\bthe (sitting|leaving|counting|seeing|carrying|striking|holding|making|weeping|watching|waiting|knowing|breathing|hurting) of\b/gi, note: 'tell: nominalized gerund-as-noun — recast to a concrete action' },
  { re: /\b(began|started|proceeded) to\b/gi, note: 'tell: filter verb "began/started to" — use the direct verb', narrationOnly: true },
  { re: /,\s+(sending|leaving|making|highlighting|underscoring|showcasing|reminding|serving as|marking|cementing|solidifying|painting|casting)\b/gi, note: 'tell: trailing "-ing" summary clause' },
];

/** How many `and`s in one sentence reads as polysyndeton. */
const POLYSYNDETON_ANDS = 3;

// --- density caps (per ~1000 words) ------------------------------------------
const DENSITY_CHECKS: { re: RegExp; per: number; note: string }[] = [
  { re: /—|--/g, per: 167, note: 'em-dash overuse — keep ≤ 6 per 1,000 words' },
  { re: /\bthe way\b/gi, per: 333, note: '"the way …" manner-simile overuse — cap ~2-3/chapter, recast' },
  { re: /\bthings?\b/gi, per: 125, note: '"thing(s)" vagueness — use the concrete noun' },
  { re: /\bbecause\b/gi, per: 167, note: '"because" overuse / chains — vary how you carry cause' },
  { re: /\b(just|very|quite|really|rather|almost|somehow|suddenly)\b/gi, per: 60, note: 'intensifiers/hedges (just, very, really, somehow…) — cut or strengthen' },
  { re: /\b(felt|saw|watched|heard|noticed|realized|realised|seemed|wondered)\b/gi, per: 100, note: 'filter words — cut the pane of glass; let the image stand' },
  { re: /\bas if\b/gi, per: 300, note: '"as if" simile overuse' },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * P1.3 — score prose the same whichever quote style it is written in.
 *
 * Every apostrophe in the lists above is a straight `'`, so imported .docx and
 * most model output (which is typographically curly) sailed through the gate:
 * a probe found 3 findings in straight-quoted prose and 0 in the identical
 * curly-quoted text. This is SCAN-SIDE ONLY — the prose's own punctuation is
 * never rewritten. Each replacement is one BMP character for one, so match
 * indexes into the normalised text still address the original exactly.
 */
export function normalizeForScan(text: string): string {
  return text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
}

/** Caps for an override file that came out of an opened project folder. */
export const OVERRIDE_LIMITS = { entries: 300, chars: 64 } as const;

export interface SanitizedOverrides {
  overrides?: TicOverrides;
  /** what was thrown away, for the panel — a silent drop is a silent misconfig */
  warnings: string[];
}

/**
 * Make an `ai-tics.local.json` safe to use.
 *
 * Two confirmed problems, both from a file the author hand-edits and a hostile
 * project can ship:
 *
 * 1. Only `Array.isArray` was checked, never the ELEMENTS. `{"allow":[1]}` threw
 *    `s.toLowerCase is not a function` out of `mergeOverrides` — before the
 *    model call, inside the IPC catch — so every generation op, the sweep,
 *    recast and red-team-all were permanently dead for that folder, with an
 *    opaque error.
 * 2. The list was unbounded and `ticsInstruction` inlines it into EVERY system
 *    prompt: 50,000 override words measured at 1.48 MB of prompt per op (118×
 *    the normal 12.5 KB), on every call of every run.
 */
export function sanitizeOverrides(raw: unknown): SanitizedOverrides {
  if (!raw || typeof raw !== 'object') return { warnings: [] };
  const warnings: string[] = [];
  const clean = (key: 'words' | 'phrases' | 'allow'): string[] | undefined => {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      warnings.push(`ai-tics.local.json: "${key}" is not a list — ignored`);
      return undefined;
    }
    const strings = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    const dropped = v.length - strings.length;
    if (dropped) warnings.push(`ai-tics.local.json: ${dropped} non-text entr(ies) in "${key}" ignored`);
    const short = strings.filter((x) => x.length <= OVERRIDE_LIMITS.chars);
    if (short.length !== strings.length) {
      warnings.push(`ai-tics.local.json: ${strings.length - short.length} over-long entr(ies) in "${key}" ignored`);
    }
    const capped = short.slice(0, OVERRIDE_LIMITS.entries);
    if (capped.length < short.length) {
      warnings.push(`ai-tics.local.json: "${key}" capped at ${OVERRIDE_LIMITS.entries} entries (${short.length} given)`);
    }
    return capped;
  };
  const overrides: TicOverrides = { words: clean('words'), phrases: clean('phrases'), allow: clean('allow') };
  const any = overrides.words?.length || overrides.phrases?.length || overrides.allow?.length;
  return { overrides: any ? overrides : undefined, warnings };
}

export function mergeOverrides(
  base: { words: string[]; phrases: string[] },
  ov?: TicOverrides,
): { words: string[]; phrases: string[] } {
  if (!ov) return base;
  // Defensive: `sanitizeOverrides` is the gate, but this is where a stray
  // non-string used to take down every op in the project, so it does not assume.
  const str = (xs?: unknown[]): string[] => (xs ?? []).filter((x): x is string => typeof x === 'string');
  const allow = new Set(str(ov.allow).map((s) => s.toLowerCase()));
  const words = [...base.words, ...str(ov.words)].filter((w) => !allow.has(w.toLowerCase()));
  const phrases = [...base.phrases, ...str(ov.phrases)].filter((p) => !allow.has(p.toLowerCase()));
  return { words: [...new Set(words)], phrases: [...new Set(phrases)] };
}

/** Cadence & rhythm tells (the deeper ones — even pacing, fragment stacks, on-ramps). */
function cadenceFindings(text: string): TicFinding[] {
  const out: TicFinding[] = [];
  // P3.6(e): `"Stop." He turned.` used to glue into ONE sentence here, because
  // the terminator is followed by a quote and this split needs whitespace right
  // after it — so every exchange skewed the cadence it is measured by. The fix
  // is upstream: this now receives NARRATION, where dialogue has already been
  // blanked, so a closing quote can no longer reach the splitter at all. Handled
  // by construction rather than by a wider regex that nothing could exercise.
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const lens = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  if (lens.length >= 6) {
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    const hasShort = lens.some((l) => l <= 6);
    const hasLong = lens.some((l) => l >= 25);
    if (sd < 4 && !(hasShort && hasLong)) {
      out.push({ kind: 'density', match: `σ≈${sd.toFixed(1)}`, index: 0, note: 'even, machine-timed cadence — swing sentence length (a 4-word sentence beside a 35-word one)' });
    }
  }
  let run = 0;
  for (const l of lens) {
    if (l <= 4) {
      if (++run >= 3) {
        out.push({ kind: 'density', match: 'fragment stack', index: 0, note: 'fragment stack (Short. Short. Short.) — one deliberate fragment per beat' });
        break;
      }
    } else run = 0;
  }
  let orRun = 1;
  for (let i = 1; i < sentences.length; i++) {
    const a = (sentences[i - 1]!.split(/\s+/)[0] || '').toLowerCase();
    const b = (sentences[i]!.split(/\s+/)[0] || '').toLowerCase();
    if (a && a === b) {
      if (++orRun >= 3) {
        out.push({ kind: 'density', match: `opens with "${b}"`, index: 0, note: 'three sentences opening on the same subject — vary the on-ramp' });
        break;
      }
    } else orRun = 1;
  }
  return out;
}

/**
 * P1.5 — per-category budgets, structural patterns first.
 *
 * There used to be one shared 300-finding budget consumed in list order, so on
 * genuinely tic-heavy prose the word loop exhausted it before PATTERN_TICS ran
 * at all: a probe returned 302 findings and not one of kind 'pattern', meaning
 * the HARD BANS — the tells that matter most — were never reported. Each
 * category now gets its own budget and the hard bans are scanned first.
 */
const BUDGET = { pattern: 120, word: 120, phrase: 80 } as const;

/**
 * The AUTHOR'S bytes for a match found in the normalised text.
 *
 * Normalisation is length-preserving, so the same offsets address the original —
 * and they must, because the reviser and the red-team fixer are handed `match`
 * as an EXACT quote to find in the real prose. Reporting the normalised form
 * meant a curly-quoted sentence could never be located again.
 */
function original(text: string, m: RegExpExecArray): string {
  return text.slice(m.index, m.index + m[0].length);
}

/**
 * Structural checks that cannot be written as a SAFE regex.
 *
 * Polysyndeton used to be
 *   /[A-Z][^.!?]*\band\b[^.!?]*\band\b[^.!?]*\band\b[^.!?]*[.!?]/g
 * — three unbounded gaps between literal anchors, so a sentence with many
 * "and"s and no terminator made the engine enumerate every way of assigning
 * them. Measured through `scanTics`: 0.9 KB → 0.6 s, 1.8 KB → 0.8 s, 3.6 KB →
 * 13 s, and (by the security audit) 4 KB → 245 s. A hostile scene file in an
 * opened folder reached it with no model call and no button press, and it
 * blocks the main process — the window, all IPC, the locks and every unsaved
 * buffer — for the duration, where `signal.aborted` is only read BETWEEN scenes
 * so Cancel cannot interrupt it.
 *
 * Counting is linear and says what the regex was trying to say.
 */
function structuralFindings(scanText: string, text: string, budget: number): TicFinding[] {
  const out: TicFinding[] = [];
  let at = 0;
  for (const sentence of scanText.split(/(?<=[.!?])/)) {
    if (out.length >= budget) break;
    const ands = sentence.match(/\band\b/g);
    if (ands && ands.length >= POLYSYNDETON_ANDS) {
      const start = at + (sentence.length - sentence.trimStart().length);
      out.push({
        kind: 'pattern',
        match: text.slice(start, start + 60),
        index: start,
        note: 'tell: polysyndeton (and…and…and) — break it up or vary',
      });
    }
    at += sentence.length;
  }
  return out;
}

/**
 * P3.6 — what the gate needs to know about the book it is policing.
 */
export interface ScanOptions {
  /** the active tone id, so a tone's own signature is not flagged as a tic */
  toneId?: string;
  /**
   * P7.1 — nonfiction is allowed to TELL.
   *
   * "Show, don't tell" is a fiction rule. Explaining a concept directly is a
   * how-to book doing its job, and the telling-emotion and filter-verb flags
   * turn that into a violation the hard-mode loop then edits out.
   */
  allowTelling?: boolean;
}

/**
 * P3.6(a) — narration only, with dialogue blanked out.
 *
 * `scanTics` ran on the raw text, so a HARD BAN on "kind of" or an intensifier
 * cap was enforced inside characters' mouths: the gate quietly rewrote how
 * people speak, which is the one place a novel is allowed to be colloquial.
 * Blanking is length-PRESERVING (spaces, same count) because every finding's
 * `index` addresses the author's original bytes, and `original()` depends on it.
 */
export function narrationOnly(text: string): string {
  let out = '';
  // TWO states, not one. A single flag made a quote nested inside speech — a
  // character quoting someone, which is ordinary novel punctuation — CLOSE the
  // speech, so the rest of the line inverted: the narration went unpoliced and
  // the gate started rewriting the next character's mouth. Both failures the
  // dialogue exemption exists to prevent, from one shared boolean.
  let inDouble = false;
  let inSingle = false;
  // Indexed over UTF-16 CODE UNITS, not `for…of`, which iterates code POINTS:
  // an emoji inside dialogue is one iteration but two units, so the output came
  // out shorter than the input and every later finding's index — and therefore
  // the `match` quote handed to the reviser — pointed at the wrong span.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    // British and typographic single quotes delimit speech too; leaving them
    // out meant the gate went on policing characters' mouths in exactly the
    // books that punctuate that way.
    // Double quotes always delimit speech. SINGLE quotes only do when they are
    // not inside a word: `’` is the standard typographic apostrophe (don’t,
    // Juniper’s), so treating it as a delimiter unconditionally blanked half the
    // narration — caught by the P1.3 suite, which is exactly what it is for.
    // The curly pair is DIRECTIONAL: reading `”` as an opener is one more way
    // an unbalanced line inverts.
    if (ch === '"' || ch === '“' || ch === '”') {
      inDouble = ch === '"' ? !inDouble : ch === '“';
      out += ' ';
      continue;
    }
    if (ch === '‘' || ch === '’' || ch === "'") {
      // Inside double-quoted speech a single quote is a NESTED quote — a
      // character quoting someone — and the text is speech on both sides of it,
      // so it must not toggle anything.
      if (inDouble) {
        out += ' ';
        continue;
      }
      if (isSpeechQuote(text, i, inSingle, ch)) {
        inSingle = !inSingle;
        out += ' ';
        continue;
      }
    }
    if (ch === '\n') {
      inDouble = false; // an unclosed quote must not swallow the rest
      inSingle = false;
      out += ch;
      continue;
    }
    out += inDouble || inSingle ? ' ' : ch;
  }
  return out;
}

/**
 * A single quote that opens or closes SPEECH, rather than an apostrophe.
 *
 * The three cases that have to come apart:
 *   - `don’t`, `Juniper’s` — letters both sides: a contraction or possessive.
 *   - `the Whitlocks’ house` — a letter before, a space after: a PLURAL possessive,
 *     which looks exactly like a closing quote and is the case a both-sides
 *     test gets wrong. Outside speech it cannot be a close, because there is
 *     nothing open.
 *   - `‘It was…’` — speech.
 *
 * So opening requires a word to start right after it, and closing is only
 * possible when something is actually open. Erring toward "apostrophe" leaves
 * narration policed; erring the other way blanks the author's prose.
 *
 * And `’` may CLOSE but never OPEN: the right single quote at the start of a
 * word is the elision apostrophe (’tis, ’90s, ’round), so letting it open
 * blanked everything after it to the end of the line.
 */
function isSpeechQuote(text: string, i: number, inSingle: boolean, ch: string): boolean {
  const before = i > 0 ? text[i - 1]! : ' ';
  const after = i + 1 < text.length ? text[i + 1]! : ' ';
  const letter = /[A-Za-zÀ-ÿ]/;
  if (letter.test(before) && letter.test(after)) return false; // contraction
  if (inSingle) return true;
  if (ch === '’') return false;
  return !letter.test(before) && letter.test(after);
}

/**
 * Tones whose SIGNATURE the cadence rules would otherwise flag.
 *
 * P3.6(b): the σ<4 even-cadence rule and the fragment-stack flag directly
 * contradict Minimalist ("short declarative sentences"), and the polysyndeton
 * rule contradicts Stark/elemental, whose whole music is and…and…and. In hard
 * mode the gate loops until the regex passes, so the tone could never win:
 * choosing it produced prose that was then edited out of it. Compliance by
 * construction is worse than no gate at all.
 */
const CADENCE_EXEMPT = new Set(['minimalist', 'mccarthy']);
const POLYSYNDETON_EXEMPT = new Set(['mccarthy', 'epic']);

export function scanTics(text: string, ov?: TicOverrides, opts: ScanOptions = {}): TicFinding[] {
  const { words, phrases } = mergeOverrides({ words: WORD_TICS, phrases: PHRASE_TICS }, ov);
  const scanText = normalizeForScan(text);
  // Word and phrase bans police the NARRATOR. Structural patterns stay
  // book-wide: "not just X but Y" is a machine tell in anyone's mouth.
  const narration = normalizeForScan(narrationOnly(text));
  const tone = opts.toneId ?? '';
  const allowTelling = !!opts.allowTelling;
  const findings: TicFinding[] = [];

  // HARD BANS and structural patterns first — they can no longer be crowded out.
  const structural = POLYSYNDETON_EXEMPT.has(tone) ? [] : structuralFindings(scanText, text, BUDGET.pattern);
  findings.push(...structural);
  let patternFound = structural.length;
  for (const { re, note, narrationOnly: narrOnly } of PATTERN_TICS) {
    re.lastIndex = 0;
    const against = narrOnly ? narration : scanText;
    let m: RegExpExecArray | null;
    while ((m = re.exec(against)) && patternFound < BUDGET.pattern) {
      // P7.1: a nonfiction book states things; the "tell" flags are fiction's.
      if (allowTelling && /^tell:/.test(note)) break;
      findings.push({ kind: 'pattern', match: original(text, m).slice(0, 60), index: m.index, note });
      patternFound++;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (patternFound >= BUDGET.pattern) break;
  }
  let wordFound = 0;
  for (const w of words) {
    const re = new RegExp(`\\b${escapeRe(w)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(narration)) && wordFound < BUDGET.word) {
      findings.push({ kind: 'word', match: original(text, m), index: m.index, note: `overused word: "${w}"` });
      wordFound++;
    }
    if (wordFound >= BUDGET.word) break;
  }
  let phraseFound = 0;
  for (const p of phrases) {
    // P3.6(f): bounded, or "heart raced" fires inside "sweetheart raced".
    const re = new RegExp(`\\b${escapeRe(p)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(narration)) && phraseFound < BUDGET.phrase) {
      findings.push({ kind: 'phrase', match: original(text, m), index: m.index, note: `cliché phrase: "${p}"` });
      phraseFound++;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (phraseFound >= BUDGET.phrase) break;
  }

  // Density is a NARRATOR property too: an intensifier cap enforced across
  // dialogue counts how the characters talk, and "Because." as a line of speech
  // is not a "because"-chain in the prose.
  const wordCount = Math.max(1, narration.split(/\s+/).filter(Boolean).length);
  for (const { re, per, note } of DENSITY_CHECKS) {
    const count = (narration.match(re) ?? []).length;
    if (count > 0 && count / wordCount > 1 / per) {
      findings.push({ kind: 'density', match: `${count}×`, index: 0, note });
    }
  }
  // P3.6(b): a tone's own music is not a tic.
  // …and so is cadence. Dialogue is SUPPOSED to be short and bursty, so an
  // exchange dragged the sentence-length statistics of the narration around it.
  if (!CADENCE_EXEMPT.has(tone)) findings.push(...cadenceFindings(narration));
  return findings.sort((a, b) => a.index - b.index);
}

/** Compact instruction injected into generation prompts. */
export function ticsInstruction(ov?: TicOverrides): string {
  const { words, phrases } = mergeOverrides({ words: WORD_TICS, phrases: PHRASE_TICS }, ov);
  return [
    'STYLE GATE — de-AI the prose. GOLDEN RULE: never write sterile, even, hedge-free prose;',
    'replace every tic with something truer, more specific, or more lyrical. Aliveness, not compliance.',
    'HARD BANS (never): "not just X but Y" / "it wasn\'t X, it was Y" / "more than a X — it was Y";',
    'coined "not-X" words; negation catalogues ("Not this. Not that."); "the kind of / sort of / type of… that";',
    '"the particular/specific/precise X". Do NOT use these words:',
    // Capped like the phrase list beside it: this string ships in the system
    // prompt of EVERY op, so an over-long override list is paid for on every
    // call of every run, not once.
    words.slice(0, OVERRIDE_LIMITS.entries).join(', ') + '.',
    'Or these clichés:',
    phrases.slice(0, 30).join('; ') + '.',
    'CAP & RECAST: "the way…", "in a way that", "as if/as though", "for a moment/in that moment",',
    '"there was something … about"; nominalized gerunds ("the counting of it"); filter words',
    '(felt, saw, watched, heard, noticed, realized, seemed, wondered) — cut them and let the image stand;',
    'telling emotion ("she felt betrayed") — dramatize in body/action/dialogue; polysyndeton (and…and…and);',
    'em-dashes ≤ 6 per 1,000 words; "thing(s)"; intensifiers (just, very, really, somehow).',
    'CADENCE: be bursty — swing sentence length hard (a 4-word sentence beside a 35-word one); no fragment',
    // P3.6(g): "leave some beats unresolved" is about PARAGRAPHS not buttoning
    // themselves shut, not about scene endings — the op guidance owns those, and
    // the two used to contradict each other.
    'stacks; don\'t button every paragraph on an epigram; vary the on-ramp.',
    'TRUST THE READER: never restate dialogue or explain a silence; say a point once, well.',
  ].join(' ');
}

/** Prompt for a model to recast prose removing the flagged tics. */
export function reviseInstruction(findings: TicFinding[]): string {
  // P3.6(c): the reviser used to receive `f.match` alone, so a density or
  // cadence finding arrived as "12×" or "σ≈2.4" — gibberish it could not act
  // on, for exactly the findings that need explaining. The note IS the
  // instruction; the match is only where to look.
  const seen = new Set<string>();
  const items: string[] = [];
  for (const f of findings) {
    const key = `${f.kind}:${f.note}:${f.match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(f.kind === 'density' || f.kind === 'pattern' ? `${f.note} (${f.match})` : `"${f.match}" — ${f.note}`);
    if (items.length >= 30) break;
  }
  return [
    'Recast the following prose to remove these AI tells while preserving the exact meaning,',
    'plot, voice, POV, and tense. Do NOT merely delete — replace each with something truer,',
    'more specific, or more lyrical, and vary the sentence rhythm (burstiness).',
    'Flagged:\n' + items.map((i) => `- ${i}`).join('\n'),
    '\nDo not add new clichés or flatten the prose. Return only the revised prose.',
  ].join(' ');
}
