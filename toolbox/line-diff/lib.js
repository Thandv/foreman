// Ported from the author's earlier tools.

const MAX_LCS_CELLS = 250_000;
const MAX_DIFF_LINES = 4_000;

function boundedFallback(a, b) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - suffix - 1] === b[b.length - suffix - 1]
  ) suffix += 1;
  return [
    ...a.slice(0, prefix).map((text) => ({ kind: 'same', text })),
    ...a.slice(prefix, a.length - suffix).map((text) => ({ kind: 'remove', text })),
    ...b.slice(prefix, b.length - suffix).map((text) => ({ kind: 'add', text })),
    ...a.slice(a.length - suffix).map((text) => ({ kind: 'same', text })),
  ];
}

function capRenderedLines(lines) {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  const half = Math.floor((MAX_DIFF_LINES - 1) / 2);
  const omitted = lines.length - half * 2;
  return [
    ...lines.slice(0, half),
    { kind: 'note', text: `… ${omitted} diff lines omitted from this view; use Side by side to review the complete files …` },
    ...lines.slice(-half),
  ];
}

/**
 * Presentation-only line diff. Large inputs deliberately use a linear
 * prefix/suffix fallback: the reviewed `after` bytes remain authoritative
 * and the side-by-side view remains complete, while a line-dense proposal
 * cannot allocate an unbounded LCS matrix or mount tens of thousands of spans.
 */
export function unifiedDiff(before, after) {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  if (a.length + b.length > MAX_DIFF_LINES || a.length * b.length > MAX_LCS_CELLS) {
    return capRenderedLines(boundedFallback(a, b));
  }

  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: 'same', text: a[i] }); i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) { lines.push({ kind: 'remove', text: a[i] }); i += 1; }
    else { lines.push({ kind: 'add', text: b[j] }); j += 1; }
  }
  while (i < a.length) { lines.push({ kind: 'remove', text: a[i] }); i += 1; }
  while (j < b.length) { lines.push({ kind: 'add', text: b[j] }); j += 1; }
  return capRenderedLines(lines);
}
