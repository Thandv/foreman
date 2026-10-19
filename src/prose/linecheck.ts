// Ported from the author's earlier novel-writing app, trimmed to Foreman's zero-dep conventions.
/**
 * P4.4 — the deterministic half of the line-edit contract.
 *
 * A line edit promises one thing: the sentences change, the book does not. The
 * obvious way to check that is to ask a model whether the facts survived — but
 * a model asked to check a model is not a check, it is a second opinion with
 * the same failure modes, and the plan is explicit that it cannot be a
 * deterministic gate.
 *
 * What CAN be checked deterministically is what facts are made of: names,
 * numbers, and the entities the book keeps in its bible. If a proper noun or a
 * number present before the edit is gone after it, something other than a
 * sentence changed, and that scene does not get staged.
 */

/**
 * Names this text is evidence for.
 *
 * ONLY mid-sentence capitals, which is where a capital means something. The
 * first version also took sentence-initial capitals unless the word was on a
 * stop-list — and no stop-list is ever complete: "Perhaps", "Suddenly",
 * "Instead", "Maybe", "Yet" and "Both" all became "names", so an ordinary
 * tightening that merged two sentences read as a fact leaving the book and the
 * whole scene's edit was thrown away. Worse, the gate ITSELF orders "suddenly"
 * and "just" cut, so the two checks contradicted each other.
 *
 * The cost of the narrower rule is a name that appears ONLY at the start of
 * sentences, everywhere, in both versions — and a name in that position is
 * still counted, because `countNames` scans the whole text for candidates found
 * anywhere.
 */
function nameCandidates(text: string): Set<string> {
  const out = new Set<string>();
  // A terminator followed by a closing quote still ends a sentence. Without
  // that, `"Get down!" Suddenly the lamp went out.` is ONE sentence, "Suddenly"
  // sits at index 2 and becomes a name — so the rule was narrowed everywhere
  // except in dialogue, which is exactly where "Suddenly", "Perhaps" and
  // "Instead" live. The line pass then threw away the whole scene's edit.
  for (const sentence of text.split(/(?<=[.!?]["”’'»]{0,2})\s+/)) {
    const words = sentence.split(/[^A-Za-zÀ-ɏ'’-]+/).filter(Boolean);
    for (let i = 1; i < words.length; i++) {
      if (/^[A-ZÀ-Þ][a-zß-ɏ]{1,}/.test(words[i]!)) out.add(words[i]!);
    }
  }
  return out;
}

/**
 * Count known names ANYWHERE, including sentence-initially.
 *
 * Two passes, because a one-pass version has a blind spot that fires on
 * ordinary tightening: joining "Linnet spoke. Then Linnet left." into "Linnet spoke,
 * left." leaves Linnet only at the start of a sentence, and a checker that
 * refuses to look there reports a name that is right in front of it as deleted.
 */
function countNames(text: string, candidates: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of text.split(/[^A-Za-zÀ-ɏ'’-]+/).filter(Boolean)) {
    if (candidates.has(w)) out.set(w, (out.get(w) ?? 0) + 1);
  }
  return out;
}

/**
 * Numbers, spelled or written. Prose says "seventeen coins" far more often than
 * "17 coins", so a digit-only check would miss most of the numbers in a novel —
 * and a quantity is exactly the kind of fact a tightening pass can quietly
 * round off.
 */
// "one" is left out deliberately: it is a pronoun far more often than a
// quantity ("the one with the dog", "one of them"), so counting it turned every
// rephrasing into fact drift.
const NUMBER_WORDS =
  'zero two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen ' +
  'seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million';

function numbers(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(/\b\d[\d,.]*\b/g)) {
    const key = m[0]!.replace(/[.,]$/, '');
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  const words = new Set(NUMBER_WORDS.split(' '));
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (words.has(w)) out.set(w, (out.get(w) ?? 0) + 1);
  }
  return out;
}

/**
 * Facts that vanished between `before` and `after`.
 *
 * Only DISAPPEARANCES count. A line edit legitimately removes repetition, so a
 * name mentioned four times and now three is tightening; a name mentioned once
 * and now absent is a fact that left the book. New names are not flagged either
 * — an edit that adds one is doing something wrong, but it is visible in the
 * diff, and flagging it would fire on ordinary re-phrasing ("he" → "Linnet").
 */
export function factDrift(before: string, after: string, sanctionedBy = ''): string[] {
  const out: string[] = [];
  const sanctioned = sanctionedTokens(sanctionedBy);
  // Candidates from BOTH sides: a name is a name whichever text proves it.
  const candidates = new Set([...nameCandidates(before), ...nameCandidates(after)]);
  const beforeNouns = countNames(before, candidates);
  const afterNouns = countNames(after, candidates);
  for (const [name] of beforeNouns) {
    if (!afterNouns.has(name) && !isSanctioned(name, sanctioned)) out.push(name);
  }
  const beforeNums = numbers(before);
  const afterNums = numbers(after);
  for (const [n] of beforeNums) {
    if (!afterNums.has(n) && !isSanctioned(n, sanctioned)) out.push(n);
  }
  return out;
}

/**
 * Facts the ticket itself authorized removing.
 *
 * The guard exists to catch a drafter who quietly drops a name or a quantity
 * while tightening. It should not fire on a removal that was the job: a ticket
 * reading "Abelard Pellam becomes Ludo Wilmot" or "delete the author-query block,
 * which cites days 134 and 148" is asking for exactly the disappearance the
 * guard reports, and with no way to say so, every correction ticket fails on
 * the correction it was written to make.
 *
 * The sanction is deliberately narrow: only a token the ticket text NAMES is
 * excused, so a ticket that renames one captain does not license dropping a
 * different one in the same pass.
 */
export function sanctionedTokens(text: string): Set<string> {
  const out = new Set<string>();
  if (!text.trim()) return out;
  for (const word of normalizeApostrophes(text).toLowerCase().split(/[^a-z0-9,.']+/)) {
    const token = word.replace(/^[.,']+|[.,']+$/g, '');
    if (!token) continue;
    out.add(token);
    // A ticket says "rename Pellam"; the text drops "Pellam's". Same fact.
    out.add(possessiveBase(token));
  }
  return out;
}

/** Curly and straight apostrophes are the same character for this purpose. */
function normalizeApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc]/g, "'");
}

function possessiveBase(token: string): string {
  return token.replace(/'s$/, '').replace(/s'$/, 's');
}

function isSanctioned(token: string, sanctioned: Set<string>): boolean {
  const flat = normalizeApostrophes(token).toLowerCase();
  return sanctioned.has(flat) || sanctioned.has(possessiveBase(flat));
}
