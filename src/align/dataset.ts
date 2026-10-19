import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../queue.ts';
import { alignDir, extractSamples, type ExtractOptions, type Sample } from './extract.ts';
import { redact } from './redact.ts';

export interface SftRow {
  prompt: string;
  completion: string;
}

export interface DpoRow {
  prompt: string;
  chosen: string;
  rejected: string;
  origin: 'gate' | 'council';
}

export interface DatasetStats {
  sft: { train: number; valid: number };
  dpo: { train: number; valid: number; fromGate: number; fromCouncil: number; councilHeldBack: number };
  files: string[];
}

/**
 * Foreman's own gate ledger is the highest-signal preference data it has: an
 * approval is the operator saying "like this", a rejection with a reason is
 * "not like that". Nobody has to label anything — the pairs are a by-product
 * of using the system.
 *
 * Read per RUN, from the decision the gate recorded on it (`runs.decision`),
 * never from a task's final status: a ticket rejected at the gate and then
 * finished on the operator's own desk ends `done`, and its rejected run's
 * summary would otherwise be offered as the preferred answer. Only the run a
 * person ruled on speaks for them — not every run the task ever had, not an
 * owner-gate decision ('owner-…' labels), and not a run that did not succeed
 * (a budget hard-stop parks with the error as its summary).
 */
export function dpoFromGate(store: Store): DpoRow[] {
  const rows = store.db
    .prepare(
      `SELECT t.prompt AS prompt, r.decision AS decision, COALESCE(r.summary, '') AS summary
         FROM runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.decision IN ('approved', 'rejected') AND r.status = 'succeeded' AND r.summary IS NOT NULL
          -- Alignment data is the OPERATOR's preferences. A ticket the owner
          -- gate decided is a model agreeing with a model; training on it would
          -- teach Foreman its own opinions. The durable marker is the column
          -- (a hold is not a decision — the human still made that one); the
          -- note prefix is kept as the reader for rows written before it.
          AND COALESCE(t.gate_decision, '') NOT LIKE 'approved@%'
          AND COALESCE(t.gate_decision, '') NOT LIKE 'rejected@%'
          AND COALESCE(t.error, '') NOT LIKE 'owner-gate:%'
        ORDER BY r.started_at DESC, r.rowid DESC LIMIT 2000`,
    )
    .all() as Record<string, unknown>[];

  // Newest approval of a brief first; later ones do not displace it.
  const approved = new Map<string, string>();
  const rejected: Array<{ prompt: string; summary: string }> = [];
  for (const row of rows) {
    const prompt = String(row['prompt']);
    const summary = String(row['summary']).trim();
    if (!summary) continue;
    if (String(row['decision']) === 'approved') {
      if (!approved.has(prompt)) approved.set(prompt, summary);
    } else {
      rejected.push({ prompt, summary });
    }
  }

  const pairs: DpoRow[] = [];
  for (const bad of rejected) {
    // Both sides must be real work. Falling back to "Do not do this: <reason>"
    // as the preferred answer trains the model to write refusal prose, and it
    // inverts the lesson entirely whenever a ticket was closed for a reason
    // that is not about quality — a rejection note reading "approved on the
    // merits, but superseded" would teach that good work is what to avoid.
    const chosen = approved.get(bad.prompt);
    if (!chosen) continue;
    pairs.push({
      prompt: redact(bad.prompt).text,
      chosen: redact(chosen).text,
      rejected: redact(bad.summary).text,
      origin: 'gate',
    });
  }
  return pairs;
}

/**
 * A chair overruling an advisor is a labelled judgement about a judgement —
 * but the label is only the OPERATOR's when they confirmed it at the gate
 * (the local-only policy: the human gate is the sole corpus admission
 * authority). Admitted: the final, non-provisional ruling on the task's latest
 * run, when a person approved the work it passed or rejected the work it
 * failed AT THE APPROVAL GATE, on that run (`runs.decision`, which
 * `decide()` records). Not admitted: a ruling nobody confirmed or the
 * operator overturned (a model agreeing with a model, or the opposite
 * lesson) — including a task the operator rejected and then finished by hand,
 * whose final `done` ruled on no run; an owner-gate decision (same rule as
 * dpoFromGate); a superseded or stepped-down ruling; a split (council.ts
 * writes `disagreement` on splits nobody decided, whose summary is a status
 * line); a crew chair's "chair ruled <x>" placeholder. Older decisions were
 * labelled from the status timeline when the column arrived (db.ts
 * backfillRunDecisions); a run with no label is not admitted.
 *
 * Balanced by direction. A non-provisional FAIL goes to repair, not to the
 * operator, so confirmed FAIL rulings are rare (a manual re-review the
 * operator then rejects) and a ledger of confirmed rulings is almost all
 * "the chair's PASS beat the advisor's FAIL" — a leniency gradient on exactly
 * the judgement the human gate protects. Keep as many of each direction as the scarcer
 * one has, as (pass, fail) pairs in that order — buildDatasets splits them
 * as units so train and valid stay balanced too; `report` says how many
 * were held back.
 */
export function dpoFromCouncil(
  store: Store,
  report?: { pass: number; fail: number; heldBack: number },
  perDirection = 1000,
): DpoRow[] {
  const rows = store.db
    .prepare(
      // Window functions, not correlated subqueries: `verdicts` has no run_id
      // index, and a per-row subquery went quadratic (1.4 s at 12k verdicts).
      `WITH newest AS (
         SELECT v.*, v.rowid AS rid,
                ROW_NUMBER() OVER (PARTITION BY v.run_id ORDER BY v.created_at DESC, v.rowid DESC) AS rn
           FROM verdicts v
       ), latest AS (
         SELECT r.id AS run_id, ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.started_at DESC, r.rowid DESC) AS rn
           FROM runs r
       ), admitted AS (
       SELECT n.council_json AS council, COALESCE(n.chair_summary,'') AS chair, n.verdict AS verdict,
              t.prompt AS prompt, n.created_at AS created_at, n.rid AS rid,
              -- Capped per direction: one cap across both, newest first, lets a
              -- run of PASS rulings crowd out every rarer FAIL and so empty the set.
              ROW_NUMBER() OVER (PARTITION BY n.verdict ORDER BY n.created_at DESC, n.rid DESC) AS dn
         FROM newest n
         JOIN latest l ON l.run_id = n.run_id AND l.rn = 1
         JOIN runs dr ON dr.id = n.run_id AND dr.status = 'succeeded'
                     AND dr.decision = CASE n.verdict WHEN 'pass' THEN 'approved' WHEN 'fail' THEN 'rejected' END
         JOIN tasks t ON t.id = n.task_id
        WHERE n.rn = 1 AND n.disagreement = 1 AND n.chair_summary IS NOT NULL
          AND ((n.verdict = 'pass' AND t.status = 'done') OR (n.verdict = 'fail' AND t.status = 'rejected'))
          AND COALESCE(t.gate_decision, '') NOT LIKE 'approved@%'
          AND COALESCE(t.gate_decision, '') NOT LIKE 'rejected@%'
          AND COALESCE(t.error, '') NOT LIKE 'owner-gate:%'
          AND COALESCE(n.provisional, 0) = 0
          AND n.chair_summary NOT IN ('chair ruled pass', 'chair ruled fail')
       )
       SELECT council, chair, verdict, prompt FROM admitted WHERE dn <= ? ORDER BY created_at DESC, rid DESC`,
    )
    .all(perDirection) as Record<string, unknown>[];

  const byDirection: Record<'pass' | 'fail', DpoRow[]> = { pass: [], fail: [] };
  for (const row of rows) {
    const chair = String(row['chair']).trim();
    if (!chair) continue;
    let council: Array<{ verdict?: string; critique?: string }> = [];
    try {
      council = JSON.parse(String(row['council'])) as typeof council;
    } catch {
      continue;
    }
    // The advisor the chair disagreed with is the rejected rationale.
    const overruled = council.find((o) => o.verdict && o.verdict !== String(row['verdict']) && o.critique);
    if (!overruled?.critique) continue;
    byDirection[String(row['verdict']) === 'fail' ? 'fail' : 'pass'].push({
      prompt: redact(`Review this work and give a verdict with a short critique.\n\n${String(row['prompt']).slice(0, 2000)}`).text,
      chosen: redact(chair).text,
      rejected: redact(overruled.critique).text,
      origin: 'council',
    });
  }
  // Newest first within each direction, as (pass, fail) pairs.
  const keep = Math.min(byDirection.pass.length, byDirection.fail.length);
  const pairs: DpoRow[] = [];
  for (let i = 0; i < keep; i++) pairs.push(byDirection.pass[i]!, byDirection.fail[i]!);
  if (report) {
    report.pass = byDirection.pass.length;
    report.fail = byDirection.fail.length;
    report.heldBack = byDirection.pass.length + byDirection.fail.length - pairs.length;
  }
  return pairs;
}

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/** Deterministic split so a rebuild does not reshuffle the validation set. */
function split<T>(rows: T[], validFraction: number): { train: T[]; valid: T[] } {
  const every = Math.max(2, Math.round(1 / Math.max(0.01, validFraction)));
  const train: T[] = [];
  const valid: T[] = [];
  rows.forEach((row, i) => ((i + 1) % every === 0 ? valid : train).push(row));
  return { train, valid };
}

export interface BuildOptions extends ExtractOptions {
  store?: Store;
  outDir?: string;
  validFraction?: number;
  maxSamples?: number;
}

/**
 * Build the training sets. SFT comes from session history (what the user kept),
 * DPO from Foreman's own gate and council ledgers (what the user accepted and
 * refused). Everything is written redacted; nothing here reaches the network.
 */
export function buildDatasets(opts: BuildOptions = {}): DatasetStats & { samples: Sample[] } {
  const out = opts.outDir ?? path.join(alignDir(), 'data');
  const { samples } = extractSamples(opts);
  const capped = opts.maxSamples ? samples.slice(0, opts.maxSamples) : samples;

  const sft: SftRow[] = capped.map((s) => ({ prompt: s.prompt, completion: s.completion }));
  const councilReport = { pass: 0, fail: 0, heldBack: 0 };
  const gatePairs = opts.store ? dpoFromGate(opts.store) : [];
  const councilPairs = opts.store ? dpoFromCouncil(opts.store, councilReport) : [];
  const dpo = [...gatePairs, ...councilPairs];

  const sftSplit = split(sft, opts.validFraction ?? 0.1);
  // Council pairs go through the split as (pass, fail) units: split row by
  // row, every tenth row lands at the same parity, and valid would hold one
  // direction only while train leaned the other way.
  const gateSplit = split(gatePairs, opts.validFraction ?? 0.1);
  const units: DpoRow[][] = [];
  for (let i = 0; i + 1 < councilPairs.length; i += 2) units.push([councilPairs[i]!, councilPairs[i + 1]!]);
  const unitSplit = split(units, opts.validFraction ?? 0.1);
  const dpoSplit = {
    train: [...gateSplit.train, ...unitSplit.train.flat()],
    valid: [...gateSplit.valid, ...unitSplit.valid.flat()],
  };

  const files = [
    path.join(out, 'train.jsonl'),
    path.join(out, 'valid.jsonl'),
    path.join(out, 'dpo_train.jsonl'),
    path.join(out, 'dpo_valid.jsonl'),
  ];
  writeJsonl(files[0]!, sftSplit.train);
  writeJsonl(files[1]!, sftSplit.valid);
  writeJsonl(files[2]!, dpoSplit.train);
  writeJsonl(files[3]!, dpoSplit.valid);

  return {
    sft: { train: sftSplit.train.length, valid: sftSplit.valid.length },
    dpo: {
      train: dpoSplit.train.length,
      valid: dpoSplit.valid.length,
      fromGate: dpo.filter((d) => d.origin === 'gate').length,
      fromCouncil: dpo.filter((d) => d.origin === 'council').length,
      councilHeldBack: councilReport.heldBack,
    },
    files,
    samples: capped,
  };
}
