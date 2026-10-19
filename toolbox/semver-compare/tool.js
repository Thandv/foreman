#!/usr/bin/env node
// Inspired by node-semver (ISC); reimplemented from the SemVer 2.0.0 spec
// (https://semver.org) and node-semver's documented range grammar (README),
// not from its source.
//
// stdin:  { mode: "compare", a, b } -> { result: -1|0|1 }
//         { mode: "satisfies", version, range } -> { satisfies: bool }
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

// --- SemVer 2.0.0 parsing & precedence (spec sections 2 and 11) ----------

const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/;

/**
 * Spec item 9: numeric prerelease identifiers MUST NOT include leading
 * zeros ("01", "007" are invalid; "0" alone, and non-numeric identifiers
 * like "0alpha", are fine). Returns false if any identifier violates this.
 */
function prereleaseIdentifiersValid(parts) {
  return parts.every((p) => !(/^\d+$/.test(p) && p.length > 1 && p[0] === '0'));
}

/** Parses a strict "X.Y.Z[-pre][+build]" string, or returns null. */
function parseVersion(str) {
  if (typeof str !== 'string') return null;
  const m = VERSION_RE.exec(str.trim());
  if (!m) return null;
  const prerelease = m[4] ? m[4].split('.') : [];
  if (!prereleaseIdentifiersValid(prerelease)) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
    build: m[5] ? m[5].split('.') : [],
  };
}

/** Spec 11.4: numeric identifiers compare numerically, others lexically (ASCII); numeric < alphanumeric. */
function compareIdentifiers(a, b) {
  const aIsNum = /^\d+$/.test(a);
  const bIsNum = /^\d+$/.test(b);
  if (aIsNum && bIsNum) {
    const an = Number(a);
    const bn = Number(b);
    return an === bn ? 0 : an < bn ? -1 : 1;
  }
  if (aIsNum !== bIsNum) return aIsNum ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Spec 11.4: compare prerelease identifier arrays; a shorter equal-prefix array has lower precedence. */
function comparePrereleaseArrays(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const c = compareIdentifiers(a[i], b[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** Full SemVer precedence: core (major.minor.patch), then prerelease (spec 11.2-11.4). */
function compareVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const aHasPre = a.prerelease.length > 0;
  const bHasPre = b.prerelease.length > 0;
  if (!aHasPre && !bHasPre) return 0;
  if (!aHasPre) return 1; // a is a release, b is a prerelease of the same core -> a has higher precedence
  if (!bHasPre) return -1;
  return comparePrereleaseArrays(a.prerelease, b.prerelease);
}

// --- Range grammar: comparator sets joined by "||" ------------------------
//
// Each comparator set is whitespace-separated tokens ANDed together, plus
// one special two-token form. A token is one of:
//   ^X.Y.Z    caret range (major/minor/patch may be x/X/*, npm caret rules)
//   ~X.Y.Z    tilde range
//   >=X.Y.Z, <=X.Y.Z, >X.Y.Z, <X.Y.Z, =X.Y.Z   plain comparator (whitespace
//             between the operator and the version is allowed, e.g. ">= 1.2.0")
//   X.Y.Z / X.Y.x / X.Y / X / * / ""    bare version or x-range
//   X.Y.Z - A.B.C   hyphen range (both sides bare versions, REQUIRES
//             whitespace on both sides of the "-" so it isn't confused with
//             a prerelease tag's own hyphen, e.g. "1.0.0-alpha")
// Each token expands to zero or more resolved {op, version} comparators
// (x-ranges, caret/tilde, and hyphen ranges expand to a lower+upper pair).

const OPERATORS = ['>=', '<=', '^', '~', '>', '<', '='];
// The version-shape part of a token, without an operator prefix (that's
// handled separately by the manual tokenizer below so an operator can be
// followed by any amount of whitespace before the version starts).
const VERSION_PART_RE = /^v?(x|X|\*|\d+)(?:\.(x|X|\*|\d+))?(?:\.(x|X|\*|\d+))?(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/;

function isWild(part) {
  return part === undefined || part === 'x' || part === 'X' || part === '*';
}

function makeVersion(major, minor, patch, pre) {
  return { major, minor, patch, prerelease: pre ? pre.split('.') : [], build: [] };
}

/**
 * Manual scanner (not a single big regex) for one comparator set: splits on
 * whitespace, but treats an operator immediately followed by whitespace and
 * then a version (e.g. ">=" then " " then "1.2.0") as ONE token, so
 * ">= 1.2.0" parses the same as ">=1.2.0".
 */
function tokenizeComparators(str) {
  const tokens = [];
  const n = str.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(str[i])) i += 1;
    if (i >= n) break;
    let op;
    for (const candidate of OPERATORS) {
      if (str.startsWith(candidate, i)) { op = candidate; break; }
    }
    if (op) i += op.length;
    while (i < n && /\s/.test(str[i])) i += 1; // whitespace after the operator is allowed
    const start = i;
    while (i < n && !/\s/.test(str[i])) i += 1;
    const versionRaw = str.slice(start, i);
    if (versionRaw === '') throw new Error(`invalid range token: dangling operator "${op}" in "${str}"`);
    tokens.push({ op, versionRaw });
  }
  return tokens;
}

/**
 * Detects the hyphen-range form "A - B": both sides must be bare version
 * tokens (no operator) with no internal whitespace, separated by a "-" that
 * has whitespace on both sides (so "1.0.0-alpha" — no surrounding spaces —
 * is never mistaken for a hyphen range). Returns [left, right] or null.
 */
function splitHyphenRange(trimmed) {
  const m = /\s-\s/.exec(trimmed);
  if (!m) return null;
  const left = trimmed.slice(0, m.index).trim();
  const right = trimmed.slice(m.index + m[0].length).trim();
  if (!left || !right || /\s/.test(left) || /\s/.test(right)) return null;
  if (OPERATORS.some((op) => left.startsWith(op) || right.startsWith(op))) return null;
  return [left, right];
}

/** Expands one bare-version-shaped string (no operator) into {major,minor,patch,pre} parts, or throws. */
function parseVersionPart(versionRaw) {
  const m = VERSION_PART_RE.exec(versionRaw);
  if (!m) throw new Error(`invalid range token: "${versionRaw}"`);
  return { majorRaw: m[1], minorRaw: m[2], patchRaw: m[3], pre: m[4] };
}

/** Hyphen range lower bound: ">=" the version with missing parts defaulted to 0. */
function hyphenLowerBound(versionRaw) {
  const { majorRaw, minorRaw, patchRaw, pre } = parseVersionPart(versionRaw);
  if (isWild(majorRaw)) return []; // "*" as the lower bound — no constraint
  const major = Number(majorRaw);
  const minor = isWild(minorRaw) ? 0 : Number(minorRaw);
  const patch = isWild(patchRaw) ? 0 : Number(patchRaw);
  return [{ op: '>=', version: makeVersion(major, minor, patch, pre) }];
}

/** Hyphen range upper bound: a partial version becomes an exclusive "<" of the next part up; a full version becomes "<=" itself. */
function hyphenUpperBound(versionRaw) {
  const { majorRaw, minorRaw, patchRaw, pre } = parseVersionPart(versionRaw);
  if (isWild(majorRaw)) return []; // "*" as the upper bound — no constraint
  const major = Number(majorRaw);
  if (isWild(minorRaw)) return [{ op: '<', version: makeVersion(major + 1, 0, 0) }];
  const minor = Number(minorRaw);
  if (isWild(patchRaw)) return [{ op: '<', version: makeVersion(major, minor + 1, 0) }];
  const patch = Number(patchRaw);
  return [{ op: '<=', version: makeVersion(major, minor, patch, pre) }];
}

/** Expands one range token (operator + version-shaped string) into resolved {op, version} comparators (ANDed). */
function expandToken(op, versionRaw) {
  const { majorRaw, minorRaw, patchRaw, pre } = parseVersionPart(versionRaw);

  if (isWild(majorRaw)) return []; // "*" / "" — matches any core version

  const major = Number(majorRaw);

  if (op === '^') {
    if (isWild(minorRaw)) return [{ op: '>=', version: makeVersion(major, 0, 0) }, { op: '<', version: makeVersion(major + 1, 0, 0) }];
    const minor = Number(minorRaw);
    if (isWild(patchRaw)) {
      return major > 0
        ? [{ op: '>=', version: makeVersion(major, minor, 0) }, { op: '<', version: makeVersion(major + 1, 0, 0) }]
        : [{ op: '>=', version: makeVersion(major, minor, 0) }, { op: '<', version: makeVersion(major, minor + 1, 0) }];
    }
    const patch = Number(patchRaw);
    const lower = makeVersion(major, minor, patch, pre);
    let upper;
    if (major > 0) upper = makeVersion(major + 1, 0, 0);
    else if (minor > 0) upper = makeVersion(major, minor + 1, 0);
    else upper = makeVersion(major, minor, patch + 1);
    return [{ op: '>=', version: lower }, { op: '<', version: upper }];
  }

  if (op === '~') {
    if (isWild(minorRaw)) return [{ op: '>=', version: makeVersion(major, 0, 0) }, { op: '<', version: makeVersion(major + 1, 0, 0) }];
    const minor = Number(minorRaw);
    const patch = isWild(patchRaw) ? 0 : Number(patchRaw);
    return [{ op: '>=', version: makeVersion(major, minor, patch, isWild(patchRaw) ? undefined : pre) }, { op: '<', version: makeVersion(major, minor + 1, 0) }];
  }

  if (op === '>=' || op === '<=' || op === '>' || op === '<' || op === '=') {
    // A partial version names a whole span (node-semver's x-range rules):
    // ">1.2" means "above all of 1.2.x" (>=1.3.0), "<=1.2" means "up to and
    // including all of 1.2.x" (<1.3.0), and "=1.2" is the x-range 1.2.x.
    // ">=" and "<" only need the missing parts defaulted to 0.
    if (isWild(minorRaw) || isWild(patchRaw)) {
      const minor0 = isWild(minorRaw) ? 0 : Number(minorRaw);
      const next = isWild(minorRaw) ? makeVersion(major + 1, 0, 0) : makeVersion(major, minor0 + 1, 0);
      const floor = makeVersion(major, minor0, 0);
      if (op === '>') return [{ op: '>=', version: next }];
      if (op === '<=') return [{ op: '<', version: next }];
      if (op === '=') return [{ op: '>=', version: floor }, { op: '<', version: next }];
      return [{ op, version: floor }];
    }
    const minor = isWild(minorRaw) ? 0 : Number(minorRaw);
    const patch = isWild(patchRaw) ? 0 : Number(patchRaw);
    return [{ op, version: makeVersion(major, minor, patch, pre) }];
  }

  // No operator: bare version, or an x-range.
  if (isWild(minorRaw)) return [{ op: '>=', version: makeVersion(major, 0, 0) }, { op: '<', version: makeVersion(major + 1, 0, 0) }];
  const minor = Number(minorRaw);
  if (isWild(patchRaw)) return [{ op: '>=', version: makeVersion(major, minor, 0) }, { op: '<', version: makeVersion(major, minor + 1, 0) }];
  const patch = Number(patchRaw);
  return [{ op: '=', version: makeVersion(major, minor, patch, pre) }];
}

function satisfiesComparator(v, comparator) {
  const c = compareVersions(v, comparator.version);
  switch (comparator.op) {
    case '=': return c === 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    default: throw new Error(`unknown comparator operator: ${comparator.op}`);
  }
}

/**
 * A prerelease version only satisfies a comparator set if that set contains
 * at least one comparator bound with the same [major,minor,patch] AND its
 * own prerelease tag — otherwise a version like "2.0.0-alpha" would slip
 * through a plain ">=1.0.0" range. This mirrors node-semver's documented
 * "prerelease tag" range-matching rule, not core SemVer 2.0.0 itself.
 */
function satisfiesSet(v, comparators) {
  if (!comparators.every((c) => satisfiesComparator(v, c))) return false;
  if (v.prerelease.length === 0) return true;
  return comparators.some(
    (c) => c.version.prerelease.length > 0 && c.version.major === v.major && c.version.minor === v.minor && c.version.patch === v.patch,
  );
}

/** Expands one whitespace-ANDed comparator-set string into resolved {op, version} comparators. */
function expandGroup(group) {
  const trimmed = group.trim();
  if (trimmed === '') return [];

  const hyphenParts = splitHyphenRange(trimmed);
  if (hyphenParts) {
    return [...hyphenLowerBound(hyphenParts[0]), ...hyphenUpperBound(hyphenParts[1])];
  }

  return tokenizeComparators(trimmed).flatMap(({ op, versionRaw }) => expandToken(op, versionRaw));
}

function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (!v) throw new Error(`not a valid version: "${version}"`);
  const orGroups = range.split('||').map((s) => s.trim());
  for (const group of orGroups) {
    const comparators = expandGroup(group);
    if (satisfiesSet(v, comparators)) return true;
  }
  return false;
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

  if (args.mode === 'compare') {
    const a = parseVersion(args.a);
    const b = parseVersion(args.b);
    if (!a) return fail(`"a" is not a valid semver version: ${JSON.stringify(args.a)}`);
    if (!b) return fail(`"b" is not a valid semver version: ${JSON.stringify(args.b)}`);
    process.stdout.write(JSON.stringify({ result: compareVersions(a, b) }));
    return;
  }

  if (args.mode === 'satisfies') {
    if (typeof args.version !== 'string') return fail('version must be a string for mode "satisfies"');
    if (typeof args.range !== 'string' || args.range.length === 0) return fail('range must be a non-empty string for mode "satisfies"');
    let result;
    try {
      result = satisfiesRange(args.version, args.range);
    } catch (err) {
      return fail(err.message);
    }
    process.stdout.write(JSON.stringify({ satisfies: result }));
    return;
  }

  return fail('mode must be "compare" or "satisfies"');
}

main().catch((err) => fail(`unexpected error: ${err.message}`));
