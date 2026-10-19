#!/usr/bin/env node
// Inspired by minimatch and picomatch (ISC/MIT); reimplemented from the
// shell-glob spec (POSIX glob + the common **, {a,b}, and gitignore-style
// leading-! extensions most tools layer on top), not from either library's
// source.
//
// ReDoS-conscious by construction: this does NOT compile any part of a
// pattern into a backtracking regex, and does NOT use RegExp at all for
// segment matching. `**` (which crosses path segments) is matched with an
// explicit, iterative two-pointer segment scanner (the classic linear
// "wildcard matching" algorithm, generalised from characters to path
// segments). Within a single path segment, `*`/`?`/`[...]` are tokenized
// once and then matched against the segment's characters with the SAME
// classic two-pointer, backtrack-to-last-star algorithm (no recursion, no
// regex engine, no exponential worst case) — sequences of `*` like
// `a*a*a*a*a*b` are O(pattern length * segment length), not exponential.
//
// stdin:  { patterns: string[], paths: string[], dot?: boolean }
// stdout: { matches: { [pattern]: string[] }, unmatched: string[] }
'use strict';

import { fileURLToPath } from 'node:url';

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

// --- brace expansion -------------------------------------------------------

const MAX_BRACE_EXPANSIONS = 1024;
const MAX_BRACE_DEPTH = 64;

/**
 * Expands the first top-level {a,b,c} group in `pattern` into one pattern
 * per alternative, then recurses on each result to expand any remaining
 * groups (handles simple nesting like "{a,{b,c}}"). No braces -> [pattern].
 *
 * Capped at MAX_BRACE_EXPANSIONS total patterns and MAX_BRACE_DEPTH nesting
 * depth, both refused with a clean error rather than blowing the call stack
 * (e.g. via `out.push(...hugeArray)` spread, which V8 stack-overflows on).
 */
export function expandBraces(pattern) {
  return expandBracesInner(pattern, 0);
}

function expandBracesInner(pattern, depth) {
  if (depth > MAX_BRACE_DEPTH) {
    throw new Error(`brace nesting exceeds ${MAX_BRACE_DEPTH} levels`);
  }
  // Find the first '{' that opens a real group (a matching '}' and at least
  // one top-level comma). A '{' that doesn't — unmatched, or "{abc}" with no
  // comma — stays a literal character, and the search moves on past it, so
  // a later real group (as in "{abc}{x,y}") is still expanded.
  let open = -1;
  let close = -1;
  let parts = null;
  for (let from = 0; ; from = open + 1) {
    open = pattern.indexOf('{', from);
    if (open === -1) return [pattern];
    close = -1;
    let depthCount = 0;
    for (let i = open; i < pattern.length; i += 1) {
      if (pattern[i] === '{') depthCount += 1;
      else if (pattern[i] === '}') {
        depthCount -= 1;
        if (depthCount === 0) { close = i; break; }
      }
    }
    if (close === -1) continue; // unmatched '{' — literal

    const body = pattern.slice(open + 1, close);
    const found = [];
    let start = 0;
    let d = 0;
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === '{') d += 1;
      else if (body[i] === '}') d -= 1;
      else if (body[i] === ',' && d === 0) {
        found.push(body.slice(start, i));
        start = i + 1;
      }
    }
    found.push(body.slice(start));
    if (found.length >= 2) { parts = found; break; }
  }

  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const out = [];
  for (const part of parts) {
    const expanded = expandBracesInner(prefix + part + suffix, depth + 1);
    for (const e of expanded) {
      out.push(e);
      if (out.length > MAX_BRACE_EXPANSIONS) {
        throw new Error(`brace expansion produced more than ${MAX_BRACE_EXPANSIONS} patterns`);
      }
    }
  }
  return out;
}

const EXPAND_CACHE = new Map();

function expandBracesCached(pattern) {
  const cached = EXPAND_CACHE.get(pattern);
  if (cached) return cached;
  const expanded = expandBraces(pattern);
  EXPAND_CACHE.set(pattern, expanded);
  return expanded;
}

// --- single-segment tokenizer (no RegExp) ---------------------------------

const SEGMENT_TOKEN_CACHE = new Map();

/**
 * Parses the body of a `[...]` character class (already stripped of the
 * enclosing brackets, possibly starting with `!`/`^` for negation) into a
 * negate flag plus a set of single characters and char-code ranges. Throws
 * a clean error on an invalid range such as `[z-a]` (start > end).
 */
function parseClassBody(body) {
  let negate = false;
  let i = 0;
  if (body[0] === '!' || body[0] === '^') {
    negate = true;
    i = 1;
  }
  const ranges = [];
  const singles = new Set();
  while (i < body.length) {
    const c = body[i];
    if (body[i + 1] === '-' && i + 2 < body.length) {
      const from = c.charCodeAt(0);
      const to = body.charCodeAt(i + 2);
      if (from > to) throw new Error('invalid glob pattern');
      ranges.push([from, to]);
      i += 3;
    } else {
      singles.add(c);
      i += 1;
    }
  }
  return { type: 'class', negate, ranges, singles };
}

/** Translates one glob path-segment (no '/') into a flat token list. */
function tokenizeSegment(segment) {
  const cached = SEGMENT_TOKEN_CACHE.get(segment);
  if (cached) return cached;

  const tokens = [];
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    if (c === '*') {
      tokens.push({ type: 'star' });
      i += 1;
    } else if (c === '?') {
      tokens.push({ type: 'any' });
      i += 1;
    } else if (c === '[') {
      // POSIX: a ']' right after '[' (or after '[!' / '[^') is a literal
      // member of the class, not its end — "[]a]" matches ']' or 'a'.
      let bodyStart = i + 1;
      if (segment[bodyStart] === '!' || segment[bodyStart] === '^') bodyStart += 1;
      const close = segment.indexOf(']', bodyStart + 1);
      if (close === -1) {
        tokens.push({ type: 'literal', ch: c });
        i += 1;
      } else {
        const body = segment.slice(i + 1, close);
        tokens.push(parseClassBody(body));
        i = close + 1;
      }
    } else {
      tokens.push({ type: 'literal', ch: c });
      i += 1;
    }
  }
  SEGMENT_TOKEN_CACHE.set(segment, tokens);
  return tokens;
}

function classMatches(tok, ch) {
  const code = ch.charCodeAt(0);
  const hit = tok.singles.has(ch) || tok.ranges.some(([f, t]) => code >= f && code <= t);
  return tok.negate ? !hit : hit;
}

function tokenMatches(tok, ch) {
  if (tok.type === 'literal') return ch === tok.ch;
  if (tok.type === 'any') return true;
  if (tok.type === 'class') return classMatches(tok, ch);
  return false;
}

/**
 * Classic O(pattern * text) two-pointer wildcard matcher (the standard "*"
 * string-matching algorithm) with backtrack-to-last-star — no recursion, no
 * regex, no exponential worst case even for patterns like `a*a*a*a*a*b`.
 */
function wildcardMatch(tokens, text) {
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = 0;

  while (si < text.length) {
    const tok = tokens[pi];
    if (tok && tok.type === 'star') {
      starPi = pi;
      starSi = si;
      pi += 1; // tentatively: * matches zero characters
    } else if (tok && tokenMatches(tok, text[si])) {
      pi += 1;
      si += 1;
    } else if (starPi !== -1) {
      // Backtrack: the most recent * swallows one more character.
      starSi += 1;
      pi = starPi + 1;
      si = starSi;
    } else {
      return false;
    }
  }
  while (tokens[pi] && tokens[pi].type === 'star') pi += 1;
  return pi === tokens.length;
}

function segmentMatches(patternSeg, pathSeg, dot) {
  if (!dot && pathSeg.startsWith('.') && !patternSeg.startsWith('.')) return false;
  return wildcardMatch(tokenizeSegment(patternSeg), pathSeg);
}

// --- segment-level ** scanner (linear, no regex backtracking) ------------

/**
 * Classic O(n*m) two-pointer wildcard matcher (the standard "*"
 * string-matching algorithm), applied to path SEGMENTS instead of
 * characters so that "**" — the only token allowed to cross "/" — never
 * needs to become part of a regex.
 */
function matchSegments(patSegs, pathSegs, dot) {
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = 0;

  while (si < pathSegs.length) {
    if (pi < patSegs.length && patSegs[pi] !== '**' && segmentMatches(patSegs[pi], pathSegs[si], dot)) {
      pi += 1;
      si += 1;
    } else if (pi < patSegs.length && patSegs[pi] === '**') {
      starPi = pi;
      starSi = si;
      pi += 1; // tentatively: ** matches zero segments
    } else if (starPi !== -1) {
      // Backtrack: the most recent ** swallows one more path segment.
      const swallowed = pathSegs[starSi];
      if (!dot && swallowed !== undefined && swallowed.startsWith('.')) return false;
      starSi += 1;
      pi = starPi + 1;
      si = starSi;
    } else {
      return false;
    }
  }
  while (pi < patSegs.length && patSegs[pi] === '**') pi += 1;
  return pi === patSegs.length;
}

/** Does `pattern` (already stripped of any leading "!") match `path`? */
export function matchOne(pattern, path, dot) {
  const pathSegs = path.split('/');
  for (const alt of expandBracesCached(pattern)) {
    const patSegs = alt.split('/');
    if (matchSegments(patSegs, pathSegs, dot)) return true;
  }
  return false;
}

export function matchAll(patterns, paths, dot) {
  const positive = patterns.filter((p) => !p.startsWith('!'));
  const negative = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

  // Null prototype: a pattern literally named "__proto__" must stay a key.
  const matches = Object.create(null);
  const matchedAny = new Set();
  for (const pat of positive) {
    const hits = [];
    for (const p of paths) {
      if (!matchOne(pat, p, dot)) continue;
      if (negative.some((neg) => matchOne(neg, p, dot))) continue;
      hits.push(p);
      matchedAny.add(p);
    }
    matches[pat] = hits;
  }
  const unmatched = paths.filter((p) => !matchedAny.has(p));
  return { matches, unmatched };
}

// --- main ----------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    return fail(`invalid JSON on stdin: ${err.message}`);
  }
  if (args === null || typeof args !== 'object') return fail('input must be a JSON object');

  const patterns = args.patterns;
  const paths = args.paths;
  if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every((p) => typeof p === 'string')) {
    return fail('patterns must be a non-empty array of strings');
  }
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string')) {
    return fail('paths must be a non-empty array of strings');
  }
  const dot = Boolean(args.dot);

  let result;
  try {
    result = matchAll(patterns, paths, dot);
  } catch (err) {
    return fail(err.message);
  }
  process.stdout.write(JSON.stringify(result));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => fail(`unexpected error: ${err.message}`));
}
