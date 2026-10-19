import { pathsInDiff } from '../improve.ts';

export type VerifyTier = 'fast' | 'full';

export interface Triage {
  tier: VerifyTier;
  reason: string;
  changedLines: number;
  paths: string[];
}

/** Extensions that carry executable behaviour. */
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|pl|lua|scala|ex|exs)$/i;

/**
 * Paths where a mistake is expensive enough that a cheap review is the wrong
 * economy, whatever the diff looks like. Deliberately broad: the cost of a
 * false positive here is one extra review.
 */
const SENSITIVE = [
  /(^|\/)\.env/i, /(^|\/)dockerfile/i, /(^|\/)\.github\//i, /(^|\/)\.gitlab-ci/i,
  /(^|\/)(package|package-lock|npm-shrinkwrap|yarn|pnpm-lock)\.(json|lock|yaml)$/i,
  /(^|\/)(requirements|pyproject|poetry\.lock|cargo|go)\.(txt|toml|lock|mod|sum)$/i,
  /auth|login|session|token|secret|credential|password|passwd|crypto|cipher|hash|jwt|oauth|permission|acl|rbac|policy|security|admit|sandbox|jail|sudo/i,
  /(^|\/)(terraform|k8s|kubernetes|helm|ansible)\//i,
  /\.(pem|key|crt|p12|keystore)$/i,
];

const isCode = (p: string): boolean => CODE_EXT.test(p);
const isSensitive = (p: string): boolean => SENSITIVE.some((re) => re.test(p));

/** Content lines the diff adds or removes, ignoring file headers and hunks. */
function bodyLines(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

/** True when the change alters nothing but spacing. */
export function isWhitespaceOnly(diff: string): boolean {
  const { added, removed } = bodyLines(diff);
  if (!added.length && !removed.length) return false;
  const squash = (lines: string[]): string => lines.join('\n').replace(/\s+/g, '');
  return squash(added) === squash(removed);
}

export function fastVerifyEnabled(): boolean {
  return process.env['FOREMAN_FAST_VERIFY'] === '1' || process.env['FOREMAN_FAST_VERIFY'] === 'on';
}

/**
 * Decide whether a diff has earned the cheap review.
 *
 * This is the one change in PLAN v3 that trades thoroughness for speed, so it
 * is off unless the operator turns it on, and even then anything code-bearing
 * or security-adjacent gets the full council regardless. A fast review is also
 * only ever a floor: a `fail` from it escalates rather than ending the task.
 */
export function triageDiff(diff: string, opts: { enabled?: boolean; maxLines?: number } = {}): Triage {
  const paths = pathsInDiff(diff);
  const { added, removed } = bodyLines(diff);
  const changedLines = added.length + removed.length;
  const maxLines = opts.maxLines ?? Number(process.env['FOREMAN_FAST_VERIFY_MAX_LINES'] ?? 20);
  const enabled = opts.enabled ?? fastVerifyEnabled();

  const full = (reason: string): Triage => ({ tier: 'full', reason, changedLines, paths });
  if (!enabled) return full('fast-verify is off');
  if (!paths.length || !changedLines) return full('nothing identifiable to triage');

  const sensitive = paths.filter(isSensitive);
  if (sensitive.length) return full(`security-adjacent path: ${sensitive.join(', ')}`);

  if (isWhitespaceOnly(diff)) {
    return { tier: 'fast', reason: 'whitespace-only change', changedLines, paths };
  }

  const code = paths.filter(isCode);
  if (code.length) return full(`code-bearing: ${code.join(', ')}`);

  if (changedLines > maxLines) return full(`${changedLines} changed lines is above the ${maxLines}-line fast threshold`);
  return { tier: 'fast', reason: `${changedLines} line(s) in docs/config only`, changedLines, paths };
}
