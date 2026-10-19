/**
 * A provider usage limit is not a defect in the ticket.
 *
 * On Kiln phase 4a the account hit its session limit mid-epic: two workers
 * died with "You've hit your session limit", were recorded as failed review
 * verdicts, and their failure cascaded through eleven dependents — every one
 * of which then had to be retried by hand. The CLI said exactly what was wrong;
 * nothing listened. A run that ends this way is held instead: its attempt is
 * given back, it returns to the queue, and the scheduler stops claiming work
 * for that runner until a backoff passes, so the rest of the queue is not
 * burnt against the same wall one ticket at a time.
 */

export class ProviderLimited extends Error {}

const LIMIT = new RegExp(
  [
    "you'?ve hit your (?:\\w+ )?limit",
    'usage limit (?:reached|exceeded)',
    'rate[ -]limit(?:ed)? (?:reached|exceeded)',
    '\\b429 too many requests\\b',
    'overloaded_error',
  ].join('|'),
  'i',
);

/** True when a runner's failure text says the provider refused for quota, not for the work. */
export function isProviderLimit(text: string | null | undefined): boolean {
  return LIMIT.test(text ?? '');
}

/** How long to stop claiming work for a limited runner (FOREMAN_LIMIT_BACKOFF_MS, default 15 minutes). */
export function limitBackoffMs(): number {
  const raw = Number(process.env['FOREMAN_LIMIT_BACKOFF_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}
