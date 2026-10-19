// Ported from the author's earlier tools.
//
// Zero-token detector for draft-merge damage: paragraphs that survived a copy
// of one draft pasted over another. It only ever proposes CANDIDATES — a
// human or model still has to judge each one, because a short line repeated
// far apart in the manuscript is very often an intentional refrain, not
// damage.
//
// SUBSTITUTION FROM THE ORIGINAL: the Python source ranks near-duplicate
// paragraphs with difflib.SequenceMatcher.ratio() (a longest-matching-blocks,
// order-sensitive ratio). Node's standard library has no equivalent, and this
// toolbox is zero-dependency, so near-duplicate scoring here uses a bigram
// Dice coefficient instead, at the same 0.82 threshold the original used.
// Dice compares character-bigram multisets — order-insensitive within a
// bigram window — so it will occasionally disagree with SequenceMatcher at
// the margins (e.g. a paragraph with two clauses swapped scores higher under
// Dice than under SequenceMatcher's LCS-style walk). For the "variant draft
// pasted back in" case this tool targets, both measures track the same
// signal: two paragraphs that are mostly the same words in mostly the same
// order.
//
// Paragraph model (unchanged from the original): one non-empty, non-heading
// line of input text is one paragraph.

// Words in any script (an ASCII-only class reduced a Cyrillic or Greek
// paragraph to nothing, so it was never checked at all). Curly apostrophes
// are folded to straight ones in norm(), so "don’t" and "don't" agree.
const WORD_RE = /[\p{L}\p{M}\p{N}']+/gu;
const HEAD_RE = /^\s*#{0,6}\s*\*?\s*(PART|MOVEMENT|CHAPTER|INTERLUDE|PROLOGUE|EPILOGUE|BOOK)\b/i;
// Acceptable sentence/paragraph-ending characters.
const TERMINAL = new Set(['.', '!', '?', '…', '"', '”', "'", '’', '*', '—', '-', ')', ':', ']']);

function norm(line) {
  const words = line.normalize('NFC').toLowerCase().replace(/[\u2018\u2019]/g, "'").match(WORD_RE) ?? [];
  return words.join(' ');
}

function loadParagraphs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const paras = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || HEAD_RE.test(line)) continue;
    const n = norm(line);
    if (n) {
      const wc = n.split(' ').filter(Boolean).length;
      paras.push({ line: i + 1, raw: line.trim(), norm: n, words: wc });
    }
  }
  return paras;
}

function snippet(s, n = 90) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function bigramMultiset(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    m.set(bg, (m.get(bg) ?? 0) + 1);
  }
  return m;
}

/** Bigram Dice coefficient — see the file header for why this replaces SequenceMatcher. */
function diceCoefficient(a, b) {
  if (a === b) return 1;
  const ba = bigramMultiset(a);
  const bb = bigramMultiset(b);
  let countA = 0;
  for (const v of ba.values()) countA += v;
  let countB = 0;
  for (const v of bb.values()) countB += v;
  if (countA === 0 || countB === 0) return 0;
  let overlap = 0;
  for (const [bg, ca] of ba) {
    const cb = bb.get(bg);
    if (cb) overlap += Math.min(ca, cb);
  }
  return (2 * overlap) / (countA + countB);
}

function detect(text, window = 10, near = 0.82) {
  const paras = loadParagraphs(text);
  const cands = [];

  // 1) exact duplicates (group by normalized text).
  const seen = new Map();
  for (const p of paras) {
    if (!seen.has(p.norm)) seen.set(p.norm, []);
    seen.get(p.norm).push(p);
  }
  for (const occ of seen.values()) {
    if (occ.length <= 1) continue;
    const lines = occ.map((o) => o.line);
    const wc = occ[0].words;
    let dist = Infinity;
    for (let i = 0; i < lines.length - 1; i++) dist = Math.min(dist, lines[i + 1] - lines[i]);
    // Skip short repeats spread far apart — dialogue echoes / refrains, not artifacts.
    if (dist > 4 && wc < 12) continue;
    cands.push({
      type: 'exact-duplicate',
      lines,
      min_distance: dist,
      words: wc,
      tag: wc < 9 && dist > 4 ? 'maybe-refrain' : 'likely-artifact',
      snippet: snippet(occ[0].raw),
    });
  }

  // 2) near-duplicates within a sliding window (variant drafts).
  for (let i = 0; i < paras.length; i++) {
    const a = paras[i];
    if (a.words < 6) continue;
    for (let j = i + 1; j < Math.min(i + 1 + window, paras.length); j++) {
      const b = paras[j];
      if (b.words < 6 || a.norm === b.norm) continue;
      const ratio = diceCoefficient(a.norm, b.norm);
      if (ratio >= near) {
        cands.push({
          type: 'near-duplicate',
          lines: [a.line, b.line],
          similarity: Math.round(ratio * 1000) / 1000,
          tag: 'likely-artifact',
          snippet: snippet(a.raw),
          snippet2: snippet(b.raw),
        });
      }
    }
  }

  // 2b) truncated false-start: paragraph A is an exact prefix of a nearby
  // longer paragraph B (A is a cut-off duplicate sitting just above its
  // completed version). Only immediately-adjacent neighbours are checked.
  for (let i = 0; i < paras.length; i++) {
    const a = paras[i];
    if (a.words < 4) continue;
    for (let j = i + 1; j < Math.min(i + 1 + 3, paras.length); j++) {
      const b = paras[j];
      if (b.norm.startsWith(`${a.norm} `) && b.words > a.words + 2) {
        cands.push({
          type: 'truncated-false-start',
          lines: [a.line, b.line],
          words: a.words,
          tag: 'likely-artifact',
          snippet: snippet(a.raw),
          snippet2: snippet(b.raw),
        });
        break;
      }
    }
  }

  // 3) truncation / unbalanced markers.
  for (const p of paras) {
    if (p.words < 3) continue;
    const last = p.raw.length ? p.raw[p.raw.length - 1] : '';
    const flags = [];
    // Only a real prose paragraph (not a short title/dateline) counts as truncated.
    if (!TERMINAL.has(last) && p.words >= 12) flags.push('no-terminal-punctuation');
    const stars = (p.raw.match(/\*/g) ?? []).length;
    if (stars % 2 === 1) flags.push('unbalanced-italic-asterisk');
    if (flags.length) {
      cands.push({
        type: 'truncation-or-unbalanced',
        lines: [p.line],
        flags,
        tag: 'likely-artifact',
        snippet: snippet(p.raw, 110),
      });
    }
  }

  // Rank: artifacts before maybe-refrain; nearer exact duplicates first.
  cands.sort((x, y) => {
    const ax = x.tag === 'likely-artifact' ? 0 : 1;
    const ay = y.tag === 'likely-artifact' ? 0 : 1;
    if (ax !== ay) return ax - ay;
    const dx = x.type === 'exact-duplicate' ? x.min_distance : 0;
    const dy = y.type === 'exact-duplicate' ? y.min_distance : 0;
    return dx - dy;
  });

  return { paragraphs: paras.length, candidates: cands };
}

function toOutput(result) {
  const candidates = result.candidates.map((c, index) => {
    const { type, lines, snippet: snip, ...rest } = c;
    return { kind: type, index, line: lines[0], snippet: snip, detail: { lines, ...rest } };
  });
  return { paragraphs: result.paragraphs, candidates };
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
  const window = Number.isInteger(args.window) && args.window > 0 ? args.window : 10;
  const result = detect(args.text, window);
  process.stdout.write(JSON.stringify(toOutput(result)));
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
