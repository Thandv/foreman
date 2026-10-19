import type { Tier } from './roles.ts';
import type { Task } from './types.ts';

/**
 * `FOREMAN_LOCAL_ONLY=1` — the mode Foreman runs in once there is no cloud.
 *
 * This is the enforcement half of the operator's local-only policy. The policy's own
 * summary of what the flag does and does not do:
 *
 *   Local-only loosens capability, never safety.
 *
 * Everything here therefore either *routes* work to a local model or *refuses*
 * work no local model should be trusted with. Nothing here relaxes a guardrail:
 * admission BLOCK, the jail, PROTECTED_PATHS, the human gate, merge-only-on-
 * approval, split-never-passes, deterministic seeds and redaction are all
 * untouched by this file, on purpose.
 *
 * The flag is read lazily on every call, never captured at module load, so a
 * test can flip it per case and an operator can flip it without a rebuild —
 * the same contract `tierModel` and `effectiveGate` keep.
 */
export function localOnly(): boolean {
  return localOnlyMode() === 'on';
}

/**
 * How the operator set FOREMAN_LOCAL_ONLY. `on` is the strict promise —
 * nothing leaves the machine, every refusal in this file applies. `off` is
 * mixed, always. `auto` (the default when unset) is mixed while the Claude CLI
 * works, and falls back to the local plane for Claude-dependent work while it
 * does not — see `cloudFallback`.
 */
export function localOnlyMode(): 'on' | 'off' | 'auto' {
  const raw = (process.env['FOREMAN_LOCAL_ONLY'] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return 'on';
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return 'off';
  return 'auto';
}

let cloudDownReason: string | null = null;

/** Why the Claude CLI is believed unreachable, or null when it is not known to be. */
export function cloudDown(): string | null {
  return cloudDownReason;
}

/**
 * Record the Claude CLI's state. Returns true when up/down changed, so callers
 * can re-resolve the alias registry. Only a call that works may clear it — see
 * probeCloud — because `claude auth status` reports `loggedIn:true` for
 * credentials that are present but invalid (measured with a garbage key and a
 * garbage OAuth token).
 */
export function setCloudDown(reason: string | null): boolean {
  const changed = (cloudDownReason === null) !== (reason === null);
  cloudDownReason = reason;
  return changed;
}

/**
 * Auto mode with the Claude CLI known to be down: Claude-dependent work falls
 * back to the local plane instead of failing.
 *
 * This is deliberately NOT `localOnly()`. Local-only is the operator's promise
 * that nothing leaves the machine; it refuses codex, the gateway and every
 * hosted runner, and its admission refusals fail a ticket for good. None of
 * that is what a lapsed `claude` sign-in means — an operator using codex or a
 * gateway has lost nothing, and a ticket written for claude-code should wait
 * for the CLI to come back rather than be failed by a five-minute lapse. So
 * this reroutes exactly what depended on Claude: the default tiers, the crew
 * runner, the owner and router calls, and the owner gate.
 */
export function cloudFallback(): boolean {
  return localOnlyMode() === 'auto' && cloudDownReason !== null;
}

/** Short subject for a refusal under strict local-only. */
export function localOnlyLabel(): string {
  return 'FOREMAN_LOCAL_ONLY is set';
}

/** One line for status output: what mode the model plane is in, and why. */
export function modeSummary(): string {
  if (localOnly()) return 'LOCAL-ONLY (FOREMAN_LOCAL_ONLY is set)';
  if (cloudFallback()) {
    return `LOCAL FALLBACK — the Claude CLI is unreachable (${cloudDownReason}); Claude-dependent work runs ` +
      'locally or waits. Sign the CLI in, or set FOREMAN_LOCAL_ONLY=0 to stop falling back';
  }
  return `mixed (cloud allowed; FOREMAN_LOCAL_ONLY=${localOnlyMode()})`;
}

/**
 * The tier→alias map after the collapse (local-only policy).
 *
 * The owner tier does not survive as a model tier: what is left of it here is
 * *chairing and schema-bound classification only*, which `qwen3.5:9b` benched
 * 1.00 on and has done correctly in a live run. Everything the owner tier used
 * to do that needed open-ended judgment is refused (see `assertSchemaBound` and `refuseWholeSpanReview`) or
 * handed to the operator (see the `assignee` mechanism) — it is not quietly
 * served by a smaller model.
 *
 * `llama3.1:8b` (`local-general`) is deliberately absent from every seat here:
 * it benched 0.25 on reasoning and misread a diff twice in a live run. The local-only
 * policy pins it out of advisor, chair and judge seats.
 */
const LOCAL_TIERS: Record<Tier, string> = {
  owner: 'local-reason',
  senior: 'local-reason',
  worker: 'local-reason',
};

/**
 * Code work has a genuinely better local model than prose does, and the tier
 * map alone cannot see that — a `senior` reviewing a diff and a `senior`
 * reading a chapter want different weights. Callers that know the task's kind
 * pass it; callers that do not get the text-shaped default.
 */
export function localAliasFor(tier: Tier, kind?: Task['kind'] | null): string {
  // Every tier gets the same code model, because the roster only has one that
  // benched well on code (`qwen2.5-coder:14b` at 1.00). The tier argument is
  // still taken so a second code model — the 32B, if `doctor --bench` proves it
  // fits inference on this machine — can be given the senior seat without
  // changing a call site.
  if (kind === 'code') return 'local-code';
  return LOCAL_TIERS[tier];
}

/**
 * Output ceiling for one model call, by tier and kind (local-only policy).
 *
 * The default 1024 is the single worst failure mode in local-only mode: a
 * 3,700-word chapter is roughly 5,000 tokens, so a drafting call under the
 * default does not fail — it returns a chapter that stops mid-scene, and every
 * downstream stage treats that as the work. Drafting therefore gets room, and
 * a review (which must be terse and schema-bound anyway) does not.
 */
export function maxOutputTokensFor(kind: Task['kind'] | null | undefined, role: string | null): number {
  const env = Number(process.env['FOREMAN_LOCAL_MAX_OUTPUT_TOKENS']);
  if (Number.isFinite(env) && env > 0) return Math.trunc(env);
  // Roles whose deliverable IS long prose. A line-editor rewrites a whole
  // chapter too, so it belongs here as much as the author does.
  const drafting = new Set(['author', 'line-editor', 'copyeditor', 'proofreader', 'researcher']);
  if (role && drafting.has(role)) return 8192;
  if (kind === 'writing') return 8192;
  return 2048;
}

/**
 * Context window for one model call (local-only policy).
 *
 * Ollama defaults to roughly 4k, which cannot hold an outline plus a style
 * sheet plus the previous chapter plus the draft being written. Like the output
 * ceiling, exceeding it does not error — it silently drops the front of the
 * prompt, so the model writes without the brief it was given.
 */
export function contextTokensFor(kind: Task['kind'] | null | undefined, role: string | null): number {
  const env = Number(process.env['FOREMAN_LOCAL_NUM_CTX']);
  if (Number.isFinite(env) && env > 0) return Math.trunc(env);
  if (kind === 'writing' || (role && role !== 'dev')) return 16384;
  return 8192;
}

/**
 * The runner a crew ticket uses (local-only policy).
 *
 * `roleAgent()` hardcoded `claude-code`, which dies with the subscription. In
 * local-only mode every crew ticket runs on `api` — the one runner that speaks
 * the local model plane, and the only one verified live for jail containment
 * and destructive-command refusal.
 */
export function crewRunner(): 'claude-code' | 'api' {
  return localOnly() || cloudFallback() ? 'api' : 'claude-code';
}

export class LocalOnlyRefusal extends Error {}

/**
 * The local-only policy — no open-ended judgment on a ≤14B model.
 *
 * The measured failure this prevents: asked to "read this and say what is
 * wrong", a 9B writes a literary appreciation essay; asked for four claim
 * kinds at once it returns a thin sample of each and misses the error a
 * targeted prompt finds instantly. So a review call in local-only mode must
 * carry a JSON schema — a shape to fill in, not an invitation to opine.
 *
 * `json: true` is NOT enough and is refused here on purpose: it asks for "some
 * JSON", which a local model satisfies with a well-formed object of its own
 * invention. The schema is the constraint; `true` is a suggestion.
 */
export function assertSchemaBound(json: boolean | Record<string, unknown> | undefined, what: string): void {
  if (!localOnly()) return;
  if (typeof json === 'object' && json !== null) return;
  throw new LocalOnlyRefusal(
    `local-only: ${what} must carry a JSON schema. An unconstrained "say what is wrong" prompt to a ` +
    `local model returns an essay, not a verdict.`,
  );
}

/**
 * The local-only policy — no whole-span read-throughs on a local model.
 *
 * A per-chapter review is a job a local model can do. A twelve-chapter seam
 * read-through is the job it demonstrably cannot: the errors live in the
 * arithmetic *between* chapters, and judging that is what the operator is for.
 * The ticket parks rather than being answered badly.
 */
export const MAX_LOCAL_REVIEW_SPAN = 2;

export function refuseWholeSpanReview(chapters: number): void {
  if (!localOnly()) return;
  if (chapters > MAX_LOCAL_REVIEW_SPAN) {
    throw new LocalOnlyRefusal(
      `local-only: a ${chapters}-chapter read-through is not a local job. Park it for the operator with ` +
      `the seam-differ output attached.`,
    );
  }
}
