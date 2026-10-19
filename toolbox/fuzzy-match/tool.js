#!/usr/bin/env node
// Inspired by fzf's fuzzy algorithm (MIT) and Fuse.js (Apache-2.0);
// reimplemented from the published algorithm description — no vendored
// code from either. A query matches a candidate only if every query
// character appears in the candidate IN ORDER (a subsequence match; there
// is no edit-distance/typo tolerance). Among all subsequences that satisfy
// that, an O(n*m) dynamic program picks the highest-scoring alignment:
// +bonus for starting at a word boundary or a camelCase hump, +bonus for
// runs of consecutive matched characters, -penalty per skipped character
// between two matches.
//
// stdin: { query: string, candidates: array, limit?: integer, key?: string }
// stdout: { matches: [{value, index, score, positions, valueOmitted}], truncated: boolean }
//
// `limit` defaults to DEFAULT_LIMIT and is hard-capped at MAX_LIMIT
// regardless of what is requested, and any candidate whose serialized value
// is bigger than MAX_ECHOED_VALUE_CHARS has its `value` omitted (null, with
// valueOmitted:true) and only its `index` returned — so a huge candidate
// list or huge candidate objects can't blow the runner's 1MB stdout cap.
'use strict';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_ECHOED_VALUE_CHARS = 200;

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

// --- scoring constants ------------------------------------------------
const MATCH_SCORE = 16;
const CONSECUTIVE_BONUS = 12;
const BOUNDARY_BONUS = 10;
const CAMEL_BONUS = 8;
const GAP_START_PENALTY = 3;
const GAP_PER_CHAR_PENALTY = 1;
// Derived constant used by the O(n*m) DP below (see the long comment on
// `matchOne` for the algebra that produces it).
const GAP_LINEAR_CONST = 2 * GAP_PER_CHAR_PENALTY - GAP_START_PENALTY;

function isAlnum(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}
function isLower(c) {
  return c >= 'a' && c <= 'z';
}
function isUpper(c) {
  return c >= 'A' && c <= 'Z';
}

/** bonus[i]: extra score for a match landing at text position i — the
 * start of the string, right after a separator (word boundary), or a
 * camelCase hump (lowercase followed by uppercase). */
function computeBonus(text) {
  const n = text.length;
  const bonus = new Float64Array(n);
  if (n === 0) return bonus;
  bonus[0] = BOUNDARY_BONUS;
  for (let i = 1; i < n; i += 1) {
    const prev = text[i - 1];
    const cur = text[i];
    if (!isAlnum(prev) && isAlnum(cur)) bonus[i] = BOUNDARY_BONUS;
    else if (isLower(prev) && isUpper(cur)) bonus[i] = CAMEL_BONUS;
  }
  return bonus;
}

/**
 * Best-scoring subsequence alignment of `query` inside `text`, or null if
 * query is not a subsequence of text at all.
 *
 * dp[j][i] = best score of matching query[0..j) with query[j-1] landing
 * exactly at text position i. For j==1 there's no predecessor, so the
 * first match is always free (no gap penalty before it — only gaps
 * BETWEEN matched characters cost anything). For j>1:
 *
 *   dp[j][i] = MATCH + bonus[i] + max over i' < i of:
 *     - dp[j-1][i-1] + CONSECUTIVE_BONUS               (i' == i-1, adjacent)
 *     - dp[j-1][i']  - gapPenalty(i - i' - 1)           (i' <= i-2, a real gap)
 *
 * gapPenalty(g) = GAP_START + GAP_PER_CHAR*(g-1) for g>=1 is linear in g,
 * so -gapPenalty(i-i'-1) expands to a term that separates into "a function
 * of i' alone" minus "GAP_PER_CHAR * i": g(i') = dp[j-1][i'] +
 * (2*GAP_PER_CHAR - GAP_START) + GAP_PER_CHAR*i'. That means
 * max_{i'<=i-2} [dp[j-1][i'] - gapPenalty(...)] equals (max_{i'<=i-2}
 * g(i')) - GAP_PER_CHAR*i, and the running max over a growing prefix of
 * i' can be maintained in O(1) amortized per step — turning what looks
 * like an O(n) inner search per (i, j) into a single left-to-right pass,
 * so the whole DP is O(n*m) instead of O(n^2*m).
 */
function matchOne(text, query) {
  const n = text.length;
  const m = query.length;
  if (m === 0) return { score: 0, positions: [] };
  if (n < m) return null;

  const caseSensitive = /[A-Z]/.test(query);
  const textCmp = caseSensitive ? text : lowerPerUnit(text);
  const queryCmp = caseSensitive ? query : lowerPerUnit(query);
  const bonus = computeBonus(text);

  let dpPrev = new Float64Array(n).fill(-Infinity);
  const backRows = [null]; // backRows[j-1] holds row j's backpointers (row 1 has none)

  for (let i = 0; i < n; i += 1) {
    if (textCmp[i] === queryCmp[0]) dpPrev[i] = MATCH_SCORE + bonus[i];
  }

  for (let j = 2; j <= m; j += 1) {
    const dpCur = new Float64Array(n).fill(-Infinity);
    const backCur = new Int32Array(n).fill(-1);
    const qc = queryCmp[j - 1];
    let maxG = -Infinity;
    let maxGArg = -1;

    for (let i = 0; i < n; i += 1) {
      const eligible = i - 2; // newly eligible predecessor for the "real gap" branch at this i
      if (eligible >= 0 && dpPrev[eligible] !== -Infinity) {
        const g = dpPrev[eligible] + GAP_LINEAR_CONST + GAP_PER_CHAR_PENALTY * eligible;
        if (g > maxG) { maxG = g; maxGArg = eligible; }
      }

      let pred = -Infinity;
      let predArg = -1;
      if (i >= 1 && dpPrev[i - 1] !== -Infinity) {
        const consecVal = dpPrev[i - 1] + CONSECUTIVE_BONUS;
        if (consecVal > pred) { pred = consecVal; predArg = i - 1; }
      }
      if (maxG !== -Infinity) {
        const gapVal = maxG - GAP_PER_CHAR_PENALTY * i;
        if (gapVal > pred) { pred = gapVal; predArg = maxGArg; }
      }

      if (textCmp[i] === qc && pred !== -Infinity) {
        dpCur[i] = MATCH_SCORE + bonus[i] + pred;
        backCur[i] = predArg;
      }
    }
    backRows.push(backCur);
    dpPrev = dpCur;
  }

  let bestI = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < n; i += 1) {
    if (dpPrev[i] > bestScore) { bestScore = dpPrev[i]; bestI = i; }
  }
  if (bestI === -1) return null;

  const positions = new Array(m);
  let i = bestI;
  for (let j = m; j >= 1; j -= 1) {
    positions[j - 1] = i;
    if (j > 1) i = backRows[j - 1][i];
  }
  return { score: bestScore, positions };
}

/**
 * Lowercases one UTF-16 code unit at a time, keeping any unit whose
 * lowercase form is not a single unit (e.g. "İ" -> "i̇") unchanged. A plain
 * String#toLowerCase can change the string's length, which would shift
 * every index after that character and report the wrong `positions`.
 */
function lowerPerUnit(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const lower = s[i].toLowerCase();
    out += lower.length === 1 ? lower : s[i];
  }
  return out;
}

function getPath(obj, dottedKey) {
  const parts = dottedKey.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function fuzzyMatch(query, candidates, key, limit) {
  const results = [];
  candidates.forEach((c, index) => {
    const text = typeof c === 'string' ? c : (typeof key === 'string' ? getPath(c, key) : undefined);
    if (typeof text !== 'string') return;
    const m = matchOne(text, query);
    if (m) results.push({ value: c, index, score: m.score, positions: m.positions });
  });
  results.sort((a, b) => b.score - a.score || a.index - b.index);
  return typeof limit === 'number' ? results.slice(0, limit) : results;
}

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    return fail(`invalid JSON on stdin: ${err.message}`);
  }
  if (args === null || typeof args !== 'object') return fail('input must be a JSON object');

  const { query, candidates } = args;
  if (typeof query !== 'string') return fail('query must be a string');
  if (!Array.isArray(candidates)) return fail('candidates must be an array');
  if (args.key !== undefined && typeof args.key !== 'string') return fail('key must be a string');
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1) {
      return fail('limit must be a positive integer');
    }
  }
  if (args.key === undefined && candidates.some((c) => typeof c !== 'string')) {
    return fail('key is required when candidates are not all plain strings');
  }

  const limit = args.limit === undefined ? DEFAULT_LIMIT : Math.min(args.limit, MAX_LIMIT);
  const allMatches = fuzzyMatch(query, candidates, args.key, undefined);
  const matches = allMatches.slice(0, limit);
  const truncated = allMatches.length > matches.length;

  const out = matches.map((m) => {
    const serialized = JSON.stringify(m.value);
    const tooBig = serialized !== undefined && serialized.length > MAX_ECHOED_VALUE_CHARS;
    return {
      value: tooBig ? null : m.value,
      valueOmitted: tooBig,
      index: m.index,
      score: Math.round(m.score * 1000) / 1000,
      positions: m.positions,
    };
  });
  process.stdout.write(JSON.stringify({ matches: out, truncated }));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));
