// Ported from the author's earlier novel-writing app, trimmed to Foreman's zero-dep conventions.
import { stripComments } from './comments.ts';

/**
 * THE app's answer to "how many words is this".
 *
 * Its own module because it must have exactly one definition. Round 22: the
 * Overview tab showed two different totals for the same book — `novel:stats`
 * said 1,509 and `novel:metrics` said 1,500 — because `metrics.ts` had its own
 * tokenizer for its own (legitimate) linguistic purposes and reported the result
 * as "words". `reader.ts` documents this exact class as a defect it fixed for
 * the exporter, where the two numbers picked different KDP binding margins.
 *
 * A leaf: it imports nothing but `comments`, so every module can use it without
 * dragging in the manifest — which is what kept `metrics.ts` (and the worker it
 * runs in) from sharing it in the first place.
 */
/** Word count, ignoring HTML beat comments and markdown noise. */
export function wordCount(text: string): number {
  const t = stripComments(text, ' ')
    .replace(/[#>*_`~]+/g, ' ')
    // A hyphen BETWEEN word characters is part of the word: stripping every `-`
    // counted "mother-in-law" as three. That was tolerable while this only fed a
    // status line; it now feeds `estimatePages` and therefore the KDP binding
    // margin, where a hyphen-dense book moved the gutter band by a quarter inch.
    //
    // Round 14, severity 3: round 13 said that with `/-+(\s|$)/`, whose `-+`
    // backtracks through the whole run once per start position when the run is
    // NOT followed by whitespace — measured 62 KB → 3.8 s, 250 KB → 54.6 s, and
    // `novel:stats` on one such scene blocked the MAIN process for 15.6 s. That
    // is reachable from a file in a folder the author merely opens, and Overview
    // is the default tab. Stated as the property instead — a hyphen survives
    // only between two word characters — both alternatives are bounded by a
    // single-character assertion, so nothing backtracks.
    .replace(/(?<![\p{L}\p{N}])-+|-+(?![\p{L}\p{N}])/gu, ' ')
    .trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}
