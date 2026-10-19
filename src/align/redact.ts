import os from 'node:os';

export interface Redaction {
  rule: string;
  count: number;
}

export interface RedactResult {
  text: string;
  redactions: Redaction[];
  /** True when something was removed — the caller may want to drop the sample. */
  changed: boolean;
}

interface Rule {
  name: string;
  pattern: RegExp;
  replace: string | ((m: string) => string);
}

/**
 * Session transcripts contain secrets by nature. This pass is a hard
 * dependency of the alignment pipeline, not a nicety: nothing reaches a
 * dataset without going through it, and its tests gate the pipeline.
 *
 * Order matters — the specific, high-confidence patterns run before the
 * entropy sweep, so a known key shape is labelled rather than blurred.
 */
const RULES: Rule[] = [
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: '[REDACTED_PRIVATE_KEY]' },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_\-]{16,}/g, replace: '[REDACTED_API_KEY]' },
  { name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}/g, replace: '[REDACTED_API_KEY]' },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, replace: '[REDACTED_TOKEN]' },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_\-]{16,}/g, replace: '[REDACTED_TOKEN]' },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: '[REDACTED_TOKEN]' },
  { name: 'aws-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: '[REDACTED_AWS_KEY_ID]' },
  { name: 'google-key', pattern: /\bAIza[0-9A-Za-z_\-]{30,}/g, replace: '[REDACTED_API_KEY]' },
  { name: 'google-oauth', pattern: /\bya29\.[0-9A-Za-z_\-]{20,}/g, replace: '[REDACTED_TOKEN]' },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}/g, replace: '[REDACTED_TOKEN]' },
  { name: 'stripe-key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: '[REDACTED_API_KEY]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, replace: '[REDACTED_JWT]' },
  { name: 'bearer', pattern: /\b(Authorization|Bearer)\s*:?\s+[A-Za-z0-9_\-.=]{16,}/gi, replace: '$1 [REDACTED_TOKEN]' },
  {
    name: 'assigned-secret',
    // KEY=value, "key": "value", key: value — wherever the NAME says the value
    // is a credential. The name is kept: it is context, not a secret.
    pattern: /(["']?)([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\1(\s*[:=]\s*)(["']?)([^\s"',;}]{6,})\4/gi,
    replace: '$1$2$1$3$4[REDACTED]$4',
  },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, replace: '[REDACTED_EMAIL]' },
];

const HOME = os.homedir();
const USER = HOME.split('/').filter(Boolean).pop() ?? '';

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Words that look random enough to be a credential even without a known shape. */
const CANDIDATE = /\b[A-Za-z0-9+/=_\-]{28,}\b/g;
const ENTROPY_THRESHOLD = Number(process.env['FOREMAN_ENTROPY_THRESHOLD'] ?? 3.6);

/**
 * A path is not a secret, and a corpus of engineering work is mostly paths.
 * `src/align/personas.ts` and `Chapters/The_Harbour_at_Low_Tide_Chapter_09.md`
 * both clear the length and entropy bars, and blurring them teaches a persona
 * to write `[REDACTED_HIGH_ENTROPY]` where a filename belongs.
 *
 * The test is structural, not lexical: every segment between the separators
 * must itself read as a word rather than as noise. A base64 blob also contains
 * slashes, but its segments are random, so it still falls through to the sweep.
 */
function looksLikePath(word: string): boolean {
  if (/[+=]/.test(word)) return false; // base64 padding and alphabet
  // No separator requirement: the CANDIDATE pattern does not include `.`, so
  // `The_Harbour_at_Low_Tide_Chapter_06.md` reaches here as its stem alone, with
  // nothing but underscores in it. What makes it a name is the shape of its
  // parts, not the presence of a slash.
  const segments = word.split(/[/.]/).filter(Boolean);
  if (!segments.length) return false;
  return segments.every(isWordish);
}

/**
 * Whether one path segment reads as something a person named.
 *
 * Entropy cannot make this call: `nightly-build-summary` scores 3.82 and the
 * AWS example secret `bPxRfiCYEXAMPLEKEY` scores 3.68. The separable structure
 * can. A name is word-shaped pieces joined by `_` or `-`, each piece uniform in
 * case; a secret is one long run of mixed case and digits with nothing to split
 * on. `Chapter_09` passes, `wJalrXUtnFEMI` does not.
 */
function isWordish(segment: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  const parts = segment.split(/[_-]/).filter(Boolean);
  if (!parts.length) return false;
  return parts.every(
    (part) =>
      part.length <= 20 &&
      (/^[a-z]+$/.test(part) || // lower
        /^[A-Z][a-z]*$/.test(part) || // Capitalized
        /^[A-Z0-9]+$/.test(part) || // ALLCAPS, optionally with digits
        /^[0-9]+$/.test(part) || // a number
        (part.length <= 4 && /^[A-Za-z0-9]+$/.test(part))), // v2, ts, 09b
  );
}

/**
 * Anything that reads as random is treated as a secret. This over-redacts —
 * a long hash or a base64 blob in a transcript is also removed — which is the
 * right trade: a lost training sample costs nothing, a leaked key costs a lot.
 */
function sweepHighEntropy(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(CANDIDATE, (word) => {
    if (/^[A-Za-z]+$/.test(word)) return word; // a long word is just a long word
    if (/^(?:[A-Za-z]+[_-])+[A-Za-z]+$/.test(word)) return word; // snake/kebab identifiers
    if (looksLikePath(word)) return word;
    if (entropy(word) < ENTROPY_THRESHOLD) return word;
    count++;
    return '[REDACTED_HIGH_ENTROPY]';
  });
  return { text: out, count };
}

export interface RedactOptions {
  /** Replace the user's home path and username. On by default. */
  scrubPaths?: boolean;
  highEntropy?: boolean;
}

export function redact(input: string, opts: RedactOptions = {}): RedactResult {
  let text = input;
  const redactions: Redaction[] = [];
  const note = (rule: string, count: number): void => {
    if (count > 0) redactions.push({ rule, count });
  };

  for (const rule of RULES) {
    let count = 0;
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      count++;
      if (typeof rule.replace === 'function') return rule.replace(String(args[0]));
      // Support $1..$3 backreferences without re-running the regex.
      return String(rule.replace).replace(/\$(\d)/g, (_, d: string) => String(args[Number(d)] ?? ''));
    });
    note(rule.name, count);
  }

  if (opts.scrubPaths !== false) {
    let paths = 0;
    text = text.split(HOME).join('~');
    paths = input.split(HOME).length - 1;
    note('home-path', paths);
    if (USER.length > 2) {
      const userRe = new RegExp(`\\b${USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      let users = 0;
      text = text.replace(userRe, () => {
        users++;
        return '[USER]';
      });
      note('username', users);
    }
  }

  if (opts.highEntropy !== false) {
    const swept = sweepHighEntropy(text);
    text = swept.text;
    note('high-entropy', swept.count);
  }

  return { text, redactions, changed: redactions.length > 0 };
}

/** Anything still matching a known key shape after redaction is a leak. */
export function assertClean(text: string): void {
  const leaks: string[] = [];
  for (const rule of RULES) {
    if (rule.name === 'email' || rule.name === 'assigned-secret') continue; // replaced in place
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
    if (re.test(text)) leaks.push(rule.name);
  }
  if (leaks.length) throw new Error(`redaction failed, corpus still contains: ${leaks.join(', ')}`);
}
