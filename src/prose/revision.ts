// Ported from the author's earlier novel-writing app, trimmed to Foreman's zero-dep conventions.
/**
 * When a model's rewrite is allowed to replace the author's prose.
 *
 * Round 6, severity 4. Three places took ANY non-blank model output as the new
 * text — `if (out.trim()) prose = out.trim()` — and all three sat on a path
 * that then writes to disk:
 *
 *   - the hard-mode tics loop (engine.ts), which runs by DEFAULT and revises
 *     with the CHEAP model, the one most likely to refuse or stop short;
 *   - the red-team fixer, and its residual-tics pass (redteam.ts).
 *
 * A cheap model answering "I'm sorry, I can't help with rewriting that content."
 * replaced a whole scene with that sentence; autowrite then wrote it to disk,
 * where the never-overwrite guard made it permanent. A stream cut off by the
 * user pressing Stop froze the scene at "The cold got into the roo".
 *
 * The rule that catches all of those without judging prose: a revision may not
 * be a fraction of what it replaced, and nothing that arrived after a cancel is
 * accepted at all. Everything else is the author's business, not the gate's.
 */

/**
 * How `runNovelOp` says "there is no model" — a string it hands to `onDone` in
 * the same argument that otherwise carries the author's new prose. Exported so
 * the sentinel is written down once instead of quoted at each call site.
 */
export const NO_MODEL_SENTINEL = '⚠️ No model available';

/** Below this the text is a selection, not a scene, and 60% is too strict. */
const SHORT_TEXT_WORDS = 40;
/**
 * The floor for a short selection. Chosen so the two cases stay apart: a genuine
 * tightening of a 16-word line to 8 words survives (50%), while a refusal or a
 * cut-off stream — which is a handful of words whatever it replaced — does not
 * (8 words for 28 is 29%). Dropping the test entirely below 40 words, as first
 * tried, let a refusal replace a short scene, which is the severity-4 this
 * module exists to stop.
 */
const SHORT_MIN_RATIO = 0.4;

/** Words, cheaply — this is a ratio test, not a statistic. */
function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export interface RevisionVerdict {
  ok: boolean;
  /** why it was refused, in the words the author sees in the run log */
  reason?: string;
}

/**
 * `minRatio` is deliberately generous: a line-edit that legitimately tightens
 * prose loses a few percent, never a third. Condensing ops do not come through
 * here — they generate, they do not revise-in-place.
 */
export function acceptableRevision(
  original: string,
  revised: string,
  opts: { aborted?: boolean; minRatio?: number } = {},
): RevisionVerdict {
  if (opts.aborted) return { ok: false, reason: 'cancelled mid-revision — keeping the original' };
  const text = revised.trim();
  if (!text) return { ok: false, reason: 'the reviser returned nothing — keeping the original' };
  // THE APP'S OWN WARNINGS ARE NOT PROSE. `runNovelOp` reports "no model
  // available" by calling `onDone` with the message as the text, so every caller
  // that treats `onDone`'s argument as the rewrite will stage a warning as the
  // author's chapter. Round 22 measured it: with zero providers configured,
  // "recast the book" staged `⚠️ No model available…` for every scene, reported
  // "2 of 2 scene(s) rewritten", and one click of Accept All reduced the book to
  // eighteen words. `novel:run` and autowrite each check this sentinel at their
  // own call site; three other paths did not, which is why the check belongs
  // HERE — in the one policy every rewrite path already goes through.
  if (text.startsWith(NO_MODEL_SENTINEL)) {
    return { ok: false, reason: `${text.replace(/^⚠️\s*/, '')} — nothing was rewritten` };
  }
  const before = words(original);
  const after = words(text);
  // A ratio test needs something to be a ratio OF: on a two-sentence selection a
  // legitimate tightening can lose half the words, and refusing it — with a
  // message accusing the model of refusing — is worse than the loss the floor
  // exists to prevent. So the floor relaxes for short text rather than lifting.
  const min = opts.minRatio ?? (before >= SHORT_TEXT_WORDS ? 0.6 : SHORT_MIN_RATIO);
  if (before > 0 && after < before * min) {
    return {
      ok: false,
      reason: `the reviser returned ${after} words for ${before} — keeping the original (it came back unexpectedly short)`,
    };
  }
  return { ok: true };
}
