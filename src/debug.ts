import fs from 'node:fs';
import { config } from './config.ts';

/**
 * Opt-in debug lines (FOREMAN_DEBUG=1): one `[foreman debug]` line per event on stderr, which the daemon already
 * sends to <home>/daemon.err.log under launchd. Off, nothing is written. Callers pass identifiers, sizes, codes and
 * timings only — never a prompt, a body, an argv, a URL query or an error message.
 */

// Case-insensitive; reviewed shapes: key=v, "api_key": "v", Authorization: Bearer X, sk-/ghp_/github_pat_ tokens,
// bare bearer, and URL userinfo.
const ASSIGNED = /((?:key|token|secret|password|authorization|cookie)\w*["']?\s*[=:]\s*["']?)(?:bearer\s+)?\S+/gi;
const TOKENS = /\b(?:sk|gh[pousr]|github_pat)[-_][A-Za-z0-9_-]+|\bbearer\s+\S+/gi;
const USERINFO = /(?<=:\/\/)[^\s/@]+(?=@)/g;

// A field whose key names a secret has its value replaced whole; token counts (tokens_in, tok_out) are numbers.
const SECRET_KEY = /key|token|secret|password|authorization|cookie/i;
const COUNT_KEY = /^tok(?:ens?)?_(?:in|out)$/i;

export function scrub(text: string): string {
  return text.replace(ASSIGNED, '$1[REDACTED]').replace(TOKENS, '[REDACTED]').replace(USERINFO, '[REDACTED]');
}

/** The kind of an error, never its message: a code (ENOENT) or the class name. */
export function errType(err: unknown): string {
  // A DOMException's numeric code is a legacy number (23 for a timeout); its name (TimeoutError) says more.
  if (err instanceof DOMException) return err.name;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  return err instanceof Error ? err.constructor.name : typeof err;
}

export function debug(scope: string, msg: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  if (!config.debug) return;
  try {
    // One line of plain text: whitespace and control characters become one space, so a value (a model-chosen tool
    // name) can neither start a forged line nor send a terminal escape to whoever tails daemon.err.log.
    // Scrub each text part on its own, so a key name like tokens_in is not mistaken for a secret assignment.
    const flat = (v: unknown): string => scrub(String(v).replace(/[\s\p{Cc}]+/gu, ' ').slice(0, 200));
    const kv = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${SECRET_KEY.test(k) && !COUNT_KEY.test(k) ? '[REDACTED]' : flat(v)}`);
    fs.writeSync(2, `${`[foreman debug] ${flat(scope)} ${flat(msg)} ${kv.join(' ')}`.trimEnd()}\n`);
  } catch {
    // A closed stderr (EPIPE, EBADF) must never take the daemon down.
  }
}

/** Log a swallowed error by type only. */
export function swallowed(scope: string, what: string, err: unknown, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  debug(scope, `swallowed ${what}`, { ...fields, error: errType(err) });
}
