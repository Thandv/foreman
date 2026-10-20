/**
 * How long `foreman doctor`'s model checks may take. The daemon's /api/doctor
 * enforces these, and the CLI prints them before it asks, so the two cannot
 * drift apart. The README's Quick start states the same figures and a test
 * pins it to these values.
 */

/** One deadline for every model check in /api/doctor (the CLI's request itself gives up at 300s). */
export const DOCTOR_DEADLINE_MS = 240_000;

/** The longest a single model's liveness ping waits for an answer. */
export const DOCTOR_PING_TIMEOUT_MS = 45_000;

/** The line `foreman doctor` prints before the model checks start. */
export function doctorTimingLine(): string {
  return `checking models: up to ${DOCTOR_PING_TIMEOUT_MS / 1000}s for each one that does not answer, ` +
    `${DOCTOR_DEADLINE_MS / 60_000} minutes in all…`;
}
