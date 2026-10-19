#!/usr/bin/env node
// Ported from the author's earlier tools (embed, cosine, Memory.retrieve).
//
// Honesty check, up front: this is KEYWORD-GRADE relevance, not semantic
// search. Documents are embedded as a hashed bag-of-words vector (no
// meaning, no synonyms, no word order) and ranked by cosine similarity
// against the query's own hashed bag-of-words vector. It costs nothing,
// needs no model or network call, and is fully offline and deterministic —
// but it will miss a paraphrase and can be fooled by keyword overlap that
// isn't actually relevant. Use it for "find documents sharing vocabulary
// with this query" over a small local set, not for real semantic retrieval.
//
// Reproducibility: the original used a 64-bit FNV-1a hash (for Python
// cross-process stability). This port deliberately uses the classic 32-bit
// FNV-1a instead, computed with Math.imul so the multiply stays a correct
// 32-bit operation despite JS numbers being doubles — the exact numbers will
// therefore differ from the Python version, but within this tool the same
// {query, documents, k} always produces the same {hits}, in this process or
// any other, forever (no floating hash-seed, no Math.random()).
//
// stdin: { query: string, documents: string[], k?: number }
// stdout: { hits: [{index, score, text}] }
'use strict';

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

/** Runs of letters/digits in any script (an ASCII-only class would drop
 * Cyrillic, Greek, CJK... entirely and split "café" into "caf"). NFKC folds
 * compatibility forms (full-width letters, ligatures) onto their plain ones. */
function tokenize(text) {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

/** Classic 32-bit FNV-1a. Math.imul keeps the multiply a true 32-bit op. */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const DIM = 96;

function embed(text) {
  const vec = new Array(DIM).fill(0);
  for (const tok of tokenize(text)) {
    vec[fnv1a32(tok) % DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
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

  const { query, documents } = args;
  if (typeof query !== 'string' || query.length === 0) return fail('query must be a non-empty string');
  if (!Array.isArray(documents) || !documents.every((d) => typeof d === 'string')) {
    return fail('documents must be an array of strings');
  }
  const k = args.k === undefined ? 5 : args.k;
  if (!Number.isInteger(k) || k < 1) return fail('k must be a positive integer');

  const qVec = embed(query);
  const scored = documents.map((text, index) => ({ index, score: cosine(qVec, embed(text)), text }));
  scored.sort((a, b) => b.score - a.score);

  process.stdout.write(JSON.stringify({ hits: scored.slice(0, k) }));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));
