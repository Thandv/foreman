import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../queue.ts';
import { extractSamples, type ExtractOptions, type Sample } from './extract.ts';
import { redact } from './redact.ts';
import {
  loadPersonas, personaDataDir, personaForText, personaId,
  savePersona, type Persona, type PersonaCatalog,
} from './personas.ts';
import type { DpoRow, SftRow } from './dataset.ts';

export interface PersonaBuildRow {
  id: string;
  sft: { train: number; valid: number };
  dpo: { train: number; valid: number; fromGate: number; fromTickets: number };
  newSinceLastBuild: number;
  dueForTraining: boolean;
  /** Rows dropped because they could not fit this persona's training window. */
  droppedTooLong: number;
  dir: string;
}

/**
 * Target tokens that must survive inside the window for a step to mean
 * anything, and the floor on a completion worth taking a step for.
 *
 * Both are deliberately low. The failure being guarded against is a prompt that
 * fills the whole sequence, leaving nothing unmasked; a short answer is not
 * that. An early cut at 64 tokens for both discarded two thirds of a corpus
 * whose median prompt is 26 tokens — it was solving the wrong problem.
 */
const MIN_TARGET_ROOM = 32;
const MIN_COMPLETION_TOKENS = 8;

/** The extractor's own approximation, reused so both ends agree. */
const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Whether a sample can actually teach anything inside this persona's window.
 *
 * Training masks the prompt, so the loss is computed on completion tokens
 * alone. A sample whose prompt fills the whole sequence leaves nothing
 * unmasked, and mlx-lm answers a batch with no target tokens with a NaN loss —
 * which then propagates and silently ruins the entire run. Observed exactly
 * that: 14% of the author corpus had prompts longer than the window, and its
 * loss was NaN from the first iteration while a persona with shorter prompts
 * trained cleanly on the same settings.
 */
export function fitsWindow(prompt: string, completion: string, maxSeqLength: number): boolean {
  const promptTokens = approxTokens(prompt);
  return maxSeqLength - promptTokens >= MIN_TARGET_ROOM && approxTokens(completion) >= MIN_COMPLETION_TOKENS;
}

export interface PersonaBuildReport {
  rows: PersonaBuildRow[];
  /** History samples no persona's triggers claimed; they land in `general`. */
  unclaimed: number;
  filesRead: number;
  /** Samples dropped because redaction had to blank something inside them. */
  droppedRedacted: number;
}

/**
 * Whether a sample still carries a redaction marker.
 *
 * Redaction runs first and it over-fires by design — a lost sample costs
 * nothing, a leaked key costs a lot. But a sample with `[REDACTED_…]` inside it
 * is one we could not fully vouch for, and training on it teaches the model to
 * emit that token where a path or an identifier belongs. There is far more
 * history than any adapter needs, so the honest move is to drop it.
 */
export function wasRedacted(...parts: string[]): boolean {
  return parts.some((p) => p.includes('[REDACTED_'));
}

/**
 * SFT rows from Foreman's own completed tickets, which — unlike a chat
 * transcript — carry the role that did the work.
 *
 * This is the highest-signal corpus a persona has: the brief is the prompt, the
 * approved summary is the completion, and the pair is only harvested when a
 * HUMAN approved it. An owner-gated approval is a model agreeing with a model,
 * and training on those teaches Foreman its own opinions — the same rule
 * dpoFromGate already applies.
 *
 * The completion is the RUN that was approved (`runs.decision`), not every run
 * of a task that ended `done`: a ticket's earlier attempts — rejected at the
 * gate, failed by the council — would otherwise be taught as the answer, and
 * a ticket rejected and then finished by hand would teach its rejected run.
 */
export function sftFromTickets(store: Store): Map<string, SftRow[]> {
  const rows = store.db
    .prepare(
      `SELECT t.playbook AS playbook, t.role AS role, t.prompt AS prompt, COALESCE(r.summary,'') AS summary
         FROM tasks t JOIN runs r ON r.task_id = t.id
        WHERE t.status = 'done' AND r.decision = 'approved' AND r.status = 'succeeded'
          AND t.role IS NOT NULL AND r.summary IS NOT NULL
          AND COALESCE(t.gate_decision, '') NOT LIKE 'approved@%'
          AND COALESCE(t.error, '') NOT LIKE 'owner-gate:%'
        ORDER BY r.started_at DESC LIMIT 4000`,
    )
    .all() as Record<string, unknown>[];

  const out = new Map<string, SftRow[]>();
  for (const row of rows) {
    const summary = String(row['summary']).trim();
    const prompt = String(row['prompt']).trim();
    if (summary.length < 40 || prompt.length < 40) continue;
    const id = personaId(
      typeof row['playbook'] === 'string' ? row['playbook'] : null,
      typeof row['role'] === 'string' ? row['role'] : null,
    );
    const list = out.get(id) ?? [];
    list.push({ prompt: redact(prompt).text, completion: redact(summary).text });
    out.set(id, list);
  }
  return out;
}

/**
 * DPO pairs from the gate, keyed by persona.
 *
 * A pair is only made where BOTH sides are real work: a rejected attempt and an
 * approved attempt at the same brief. That is a genuine contrast the operator
 * drew — this, not that — and it is the only preference signal here worth
 * training on. Both sides are runs the operator decided at the gate
 * (`runs.decision`), never inferred from where the task ended up — the same
 * rule as dpoFromGate.
 */
export function dpoFromGateByPersona(store: Store): Map<string, DpoRow[]> {
  const rows = store.db
    .prepare(
      `SELECT t.playbook AS playbook, t.role AS role, t.prompt AS prompt,
              r.decision AS decision, COALESCE(r.summary,'') AS summary
         FROM tasks t JOIN runs r ON r.task_id = t.id
        WHERE r.decision IN ('approved', 'rejected') AND r.status = 'succeeded'
          AND t.role IS NOT NULL AND r.summary IS NOT NULL
          AND COALESCE(t.gate_decision, '') NOT LIKE 'approved@%'
          AND COALESCE(t.gate_decision, '') NOT LIKE 'rejected@%'
          AND COALESCE(t.error, '') NOT LIKE 'owner-gate:%'
        ORDER BY r.started_at DESC, r.rowid DESC LIMIT 4000`,
    )
    .all() as Record<string, unknown>[];

  // Newest approval of a brief first; later ones do not displace it.
  const approvedByPrompt = new Map<string, string>();
  const rejected: Array<{ id: string; prompt: string; summary: string }> = [];
  for (const row of rows) {
    const summary = String(row['summary']).trim();
    const prompt = String(row['prompt']).trim();
    if (!summary || !prompt) continue;
    const id = personaId(
      typeof row['playbook'] === 'string' ? row['playbook'] : null,
      typeof row['role'] === 'string' ? row['role'] : null,
    );
    if (String(row['decision']) === 'approved') {
      if (!approvedByPrompt.has(prompt)) approvedByPrompt.set(prompt, summary);
    } else {
      rejected.push({ id, prompt, summary });
    }
  }

  const out = new Map<string, DpoRow[]>();
  for (const bad of rejected) {
    // A pair needs a real preferred side. The tempting fallback — "Do not do
    // this: <the rejection note>" — is worse than no pair at all: it trains the
    // model to emit refusal prose, and it poisons the corpus whenever a ticket
    // was closed for a reason that is not about quality. One real rejection in
    // this repo reads "chapter approved on the merits, but this diff carries
    // placeholder stubs", which as a chosen side teaches the model that good
    // work is the thing to avoid.
    const chosen = approvedByPrompt.get(bad.prompt);
    if (!chosen) continue;
    const list = out.get(bad.id) ?? [];
    list.push({
      prompt: redact(bad.prompt).text,
      chosen: redact(chosen).text,
      rejected: redact(bad.summary).text,
      origin: 'gate',
    });
    out.set(bad.id, list);
  }
  return out;
}

/** Exported so the manuscript ingester writes a corpus the same way. */
export function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/** Deterministic split, so a rebuild does not reshuffle the validation set. */
export function split<T>(rows: T[], validFraction: number): { train: T[]; valid: T[] } {
  const every = Math.max(2, Math.round(1 / Math.max(0.01, validFraction)));
  const train: T[] = [];
  const valid: T[] = [];
  rows.forEach((row, i) => ((i + 1) % every === 0 ? valid : train).push(row));
  return { train, valid };
}

export interface PersonaBuildOptions extends ExtractOptions {
  store?: Store;
  catalog?: PersonaCatalog;
  validFraction?: number;
  /** Per-persona ceiling, so one loud persona cannot eat the whole corpus. */
  maxSamplesPerPersona?: number;
  /** Skip chat history entirely and build from Foreman's ledger alone. */
  ticketsOnly?: boolean;
}

/**
 * Build one training corpus per persona.
 *
 * Three sources, in descending order of signal: Foreman tickets a human
 * approved (role-tagged, so attribution is exact); the gate's rejections
 * (preference pairs); and free chat history, which carries no role tag and is
 * routed by the persona's own declared triggers. History is the largest and
 * weakest source — it is what the operator and an assistant said, not what the
 * operator accepted — so it is capped per persona rather than let dominate.
 */
export function buildPersonaDatasets(opts: PersonaBuildOptions = {}): PersonaBuildReport {
  const catalog = opts.catalog ?? loadPersonas();
  const cap = opts.maxSamplesPerPersona ?? 4000;
  const validFraction = opts.validFraction ?? 0.1;

  const sft = new Map<string, SftRow[]>();
  const dpo = new Map<string, DpoRow[]>();
  let droppedRedacted = 0;
  const push = <T>(map: Map<string, T[]>, id: string, row: T): void => {
    const text = Object.values(row as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
    if (wasRedacted(...text)) {
      droppedRedacted++;
      return;
    }
    const list = map.get(id) ?? [];
    if (list.length < cap) list.push(row);
    map.set(id, list);
  };

  // 1. Foreman's own tickets — role-tagged, human-approved.
  if (opts.store) {
    for (const [id, rows] of sftFromTickets(opts.store)) for (const row of rows) push(sft, id, row);
    for (const [id, rows] of dpoFromGateByPersona(opts.store)) for (const row of rows) push(dpo, id, row);
  }

  // 2. Chat history, routed by trigger. Unclaimed samples are `general`'s.
  let unclaimed = 0;
  let filesRead = 0;
  if (!opts.ticketsOnly) {
    const { samples, stats } = extractSamples(opts);
    filesRead = stats.filesRead;
    for (const sample of samples as Sample[]) {
      const persona = personaForText(sample.prompt, catalog);
      if (!persona) unclaimed++;
      push(sft, persona?.id ?? 'general', { prompt: sample.prompt, completion: sample.completion });
    }
  }

  const rows: PersonaBuildRow[] = [];
  for (const persona of catalog.personas) {
    const dir = personaDataDir(persona.id);
    const window = persona.training.maxSeqLength;
    const allSft = sft.get(persona.id) ?? [];
    const sftRows = allSft.filter((row) => fitsWindow(row.prompt, row.completion, window));
    const droppedTooLong = allSft.length - sftRows.length;
    const dpoRows = (dpo.get(persona.id) ?? []).filter((row) => fitsWindow(row.prompt, row.chosen, window));
    const sftSplit = split(sftRows, validFraction);
    const dpoSplit = split(dpoRows, validFraction);

    writeJsonl(path.join(dir, 'train.jsonl'), sftSplit.train);
    writeJsonl(path.join(dir, 'valid.jsonl'), sftSplit.valid);
    writeJsonl(path.join(dir, 'dpo_train.jsonl'), dpoSplit.train);
    writeJsonl(path.join(dir, 'dpo_valid.jsonl'), dpoSplit.valid);

    const total = sftRows.length + dpoRows.length;
    const previous = (persona.lastBuild?.sft ?? 0) + (persona.lastBuild?.dpo ?? 0);
    const fresh = Math.max(0, total - previous);

    rows.push({
      id: persona.id,
      sft: { train: sftSplit.train.length, valid: sftSplit.valid.length },
      dpo: {
        train: dpoSplit.train.length,
        valid: dpoSplit.valid.length,
        fromGate: dpoRows.filter((d) => d.origin === 'gate').length,
        fromTickets: dpoRows.length,
      },
      newSinceLastBuild: fresh,
      droppedTooLong,
      // A persona with no adapter yet is due as soon as it has enough to learn
      // from; one already adopted waits for its retrainAfter budget of new
      // material, so a retrain is never bought for a handful of rows.
      dueForTraining:
        persona.status === 'adopted' ? fresh >= persona.retrainAfter : sftSplit.train.length + dpoSplit.train.length >= 50,
      dir,
    });

    savePersona({ ...persona, lastBuild: { sft: sftRows.length, dpo: dpoRows.length, at: new Date().toISOString() } });
  }

  return { rows, unclaimed, filesRead, droppedRedacted };
}
