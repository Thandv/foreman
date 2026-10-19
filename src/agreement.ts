import type { Store } from './queue.ts';

/**
 * Can the cloud reviewer be retired yet?
 *
 * The question this module exists to answer, and the reason it answers it with
 * a ledger rather than an opinion: until 2026-08-31 a cloud model reviews every
 * ticket and its verdict is the one that lands. On every such ticket a LOCAL
 * reviewer is also asked, its answer is recorded, and nothing is done with it.
 * That is a shadow verdict. Accumulate enough of them and you have the only
 * honest basis for retiring the cloud gate: a measured record of how often the
 * local reviewer would have decided the same way.
 *
 * Three things make this a real measurement rather than a comforting one.
 *
 * **The criterion is defined here, in advance, in code.** Deciding what counts
 * as "good enough" after seeing the numbers is how every gate gets retired
 * early. The thresholds below were written before the first shadow verdict was
 * recorded, and changing them is a visible diff.
 *
 * **The two ways of being wrong are not equally bad.** A local reviewer that
 * FAILS work the cloud passed is merely expensive — it buys a repair round
 * nobody needed, and the human gate still sees the work. A local reviewer that
 * PASSES work the cloud failed is the dangerous one: it is precisely the error
 * that would let bad work land once the cloud is gone. So a false pass is
 * counted separately and held to a much harder limit than overall agreement.
 *
 * **Agreement is scored per (playbook, role), not globally.** A local model
 * that matches the cloud on copyedit tickets and misses on developmental ones
 * is not "85% agreed"; it is ready for one job and not the other. A global
 * average hides exactly the distinction the decision turns on.
 */

/** A verdict pair: what the cloud decided, and what the local model would have. */
export interface ShadowPair {
  taskId: string;
  playbook: string | null;
  role: string | null;
  /** The verdict that actually landed. */
  authoritative: 'pass' | 'fail' | 'split';
  /** What the local reviewer said, recorded and otherwise ignored. */
  shadow: 'pass' | 'fail' | 'split';
  at: number;
}

export interface AgreementStats {
  playbook: string | null;
  role: string | null;
  samples: number;
  /** Pairs where the two reviewers reached the same verdict. */
  agreed: number;
  agreementRate: number;
  /**
   * Local said pass, cloud said fail. The dangerous error: work that would
   * have landed unreviewed once the cloud gate is gone.
   */
  falsePasses: number;
  falsePassRate: number;
  /** Local said fail, cloud said pass. Merely expensive. */
  falseFails: number;
  /** Local could not form an opinion at all. Counted as a non-agreement. */
  shadowSplits: number;
  /** Work the authoritative reviewer rejected — the half that tests saying no. */
  authoritativeFails: number;
  /** Agreement over the most recent half of the sample, for a trend. */
  recentAgreementRate: number | null;
  /** Positive when the recent half agrees more often than the older half. */
  trend: number | null;
  ready: boolean;
  /** Why it is not ready, in the order the operator should act on them. */
  blockers: string[];
}

/**
 * The promotion criterion. Written before any data was collected.
 *
 * `MIN_SAMPLES` is the one that will bite: 30 reviewed tickets of the same
 * (playbook, role) is a lot of chapters. That is deliberate — the alternative
 * is retiring a gate on eight samples, and eight samples cannot distinguish a
 * 90% reviewer from a 70% one.
 */
export const MIN_SAMPLES = 30;
export const MIN_AGREEMENT = 0.9;
/**
 * At most one false pass in thirty. Not zero: demanding a perfect record on a
 * finite sample means the criterion is met by luck or never, and a single
 * disagreement on a genuinely borderline diff should not reset the clock.
 */
export const MAX_FALSE_PASS_RATE = 1 / 30;
/**
 * The sample must contain work the authoritative reviewer actually FAILED.
 *
 * Without this the criterion is satisfiable by a reviewer that says `pass` to
 * everything: 30 samples the cloud also passed, 100% agreement, zero false
 * passes, READY. The false-pass rate — the number the whole asymmetry rests on
 * — is unmeasured, because nothing in the sample could have produced one. That
 * is precisely the reviewer this gate exists to keep out, and it was the one
 * shape guaranteed to pass.
 *
 * Five is low, and deliberately: rejections are rarer than approvals and
 * demanding many would mean the gate never opens. Five is enough that an
 * always-pass reviewer scores five false passes and is refused on the rate.
 */
export const MIN_AUTHORITATIVE_FAILS = 5;

export function scorePairs(pairs: ShadowPair[], playbook: string | null, role: string | null): AgreementStats {
  const sorted = [...pairs].sort((a, b) => a.at - b.at);
  const samples = sorted.length;
  const agreed = sorted.filter((p) => p.authoritative === p.shadow).length;
  const falsePasses = sorted.filter((p) => p.shadow === 'pass' && p.authoritative === 'fail').length;
  const falseFails = sorted.filter((p) => p.shadow === 'fail' && p.authoritative === 'pass').length;
  const shadowSplits = sorted.filter((p) => p.shadow === 'split').length;

  // The trend is what says whether the local models are actually improving, as
  // opposed to sitting at whatever they were. Split at the midpoint rather than
  // over a fixed window, so it stays meaningful at any sample size.
  const half = Math.floor(samples / 2);
  const rateOf = (xs: ShadowPair[]): number | null =>
    xs.length ? xs.filter((p) => p.authoritative === p.shadow).length / xs.length : null;
  const older = rateOf(sorted.slice(0, half));
  const recent = rateOf(sorted.slice(half));

  const agreementRate = samples ? agreed / samples : 0;
  const falsePassRate = samples ? falsePasses / samples : 0;

  // Work the cloud reviewer rejected. Agreement on approvals alone says
  // nothing about whether the local reviewer can say no.
  const authoritativeFails = sorted.filter((p) => p.authoritative === 'fail').length;

  const blockers: string[] = [];
  if (samples < MIN_SAMPLES) blockers.push(`${samples}/${MIN_SAMPLES} samples — not enough to tell a 90% reviewer from a 70% one`);
  if (authoritativeFails < MIN_AUTHORITATIVE_FAILS) {
    blockers.push(
      `only ${authoritativeFails}/${MIN_AUTHORITATIVE_FAILS} of the sample was work the cloud FAILED — ` +
      'a reviewer that never says no would score 100% here, so the false-pass rate is unmeasured',
    );
  }
  if (agreementRate < MIN_AGREEMENT) {
    blockers.push(`agreement ${(agreementRate * 100).toFixed(0)}% < ${(MIN_AGREEMENT * 100).toFixed(0)}%`);
  }
  if (falsePassRate > MAX_FALSE_PASS_RATE) {
    blockers.push(
      `${falsePasses} false pass(es) in ${samples} — work the cloud failed that the local reviewer would have landed`,
    );
  }

  return {
    playbook, role, samples, agreed, agreementRate,
    falsePasses, falsePassRate, falseFails, shadowSplits, authoritativeFails,
    recentAgreementRate: recent,
    trend: older !== null && recent !== null ? recent - older : null,
    ready: blockers.length === 0,
    blockers,
  };
}

/**
 * Score every (playbook, role) that has shadow verdicts, plus one `overall`
 * row. The overall row is reported for orientation and is deliberately NOT
 * what `ready` is read off for a routing decision — see the module comment.
 */
export function agreementReport(store: Store, limit = 2000): AgreementStats[] {
  // A cloud `split` is not a verdict to agree with: the crew reviewer found nothing to fail and could not verify an
  // acceptance item (crewReview.ts), so the ticket is held for a person. The local reviewer's pass or fail beside it
  // is neither agreement nor a miss, and counting the pair as a disagreement would lower the rate the cutover waits
  // on for a reason that says nothing about the local model. The row stays in the ledger; it is not scored.
  const pairs = store.shadowPairs(limit).filter((p) => p.authoritative !== 'split');
  const groups = new Map<string, ShadowPair[]>();
  for (const p of pairs) {
    const key = `${p.playbook ?? ''} ${p.role ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const rows = [...groups.values()]
    .map((list) => scorePairs(list, list[0]!.playbook, list[0]!.role))
    .sort((a, b) => b.samples - a.samples);
  if (pairs.length) rows.push({ ...scorePairs(pairs, null, null), playbook: null, role: 'ALL' });
  return rows;
}

/**
 * Is the shadow mechanism even running?
 *
 * Worth its own check because the failure mode is silence: with
 * FOREMAN_SHADOW_LOCAL unset, everything works, nothing is recorded, and the
 * agreement report is empty for a reason that looks identical to "no tickets
 * have been reviewed yet".
 */
export function shadowEnabled(): boolean {
  const raw = (process.env['FOREMAN_SHADOW_LOCAL'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
