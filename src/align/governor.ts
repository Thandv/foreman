import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
import { alignDir } from './extract.ts';
import { personaAdapterDir, personaDataDir, type Persona } from './personas.ts';
import { trainPreflight } from './train.ts';
import {
  acquireLocalModelLock, describeHolder, localModelLockFile, localModelLockHolder, releaseLocalModelLock,
} from './localLock.ts';

/** Read lazily, never captured at module load, so a test or an operator can point it elsewhere per case. */
const python = (): string => process.env['FOREMAN_PYTHON'] ?? '/opt/homebrew/bin/python3';

/**
 * Training must never be the reason the machine is unusable.
 *
 * Three mechanisms, in order of bluntness:
 *
 * 1. One job at a time, enforced by a lock file holding a live pid. Two MLX
 *    jobs contend for the same unified memory and both crawl.
 * 2. `nice` at the bottom of the scheduler, so anything the operator is doing
 *    outranks it for CPU.
 * 3. SIGSTOP while Foreman has work in flight, SIGCONT when it goes quiet. This
 *    is the one that matters. Niceness does not help with memory bandwidth or
 *    the GPU, and a suspended process holds its allocation but stops competing,
 *    so an agent run does not have to fight a trainer for the machine it needs.
 *
 * The cost is wall-clock: training proceeds only in the gaps. That is the
 * intended trade — this is a background chore, not a deadline.
 */
export interface GovernorOptions {
  /** True while the operator's own work is running; training suspends. */
  isBusy: () => boolean;
  /** How often to re-check. */
  pollMs?: number;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
  /** Wall-clock ceiling for one slice of training. */
  maxMs?: number;
}

export interface GovernorResult {
  ok: boolean;
  reason: string;
  adapterDir: string;
  /** Milliseconds actually spent running, excluding suspended time. */
  ranMs: number;
  suspensions: number;
  /** Final losses, read from the trainer's own output. Null when it said none. */
  loss: { train: number | null; valid: number | null };
  /** Set when the losses say the adapter memorized its corpus instead of learning it. */
  overfit: string | null;
}

/**
 * Whether these losses describe learning or memorizing.
 *
 * A validation loss far above the training loss means the adapter has learned
 * the corpus by heart rather than the job it stands for — and a persona that
 * memorized will serve back the work it was trained on when asked for new work.
 * Observed on a real run: 24 samples, 150 iterations, train 0.064 against valid
 * 5.108. That is not a persona, it is a lookup table.
 *
 * The test is deliberately loose. Small honest gaps are normal on small corpora;
 * this only fires when validation is both proportionally and absolutely worse.
 */
export function overfitWarning(
  train: number | null,
  valid: number | null,
  samples?: number,
): string | null {
  if (train === null || valid === null || train <= 0) return null;
  if (valid <= train * 1.5 || valid - train <= 0.5) return null;
  const ratio = (valid / train).toFixed(1);
  return (
    `validation loss ${valid.toFixed(3)} against training loss ${train.toFixed(3)} (${ratio}x): ` +
    'the adapter memorized its corpus rather than learning from it' +
    (samples ? `, which ${samples} samples makes easy` : '') +
    '. Give it more material, or fewer iterations, before trusting it.'
  );
}

/** Final train and validation losses from mlx-lm's own reporting. */
export function parseLosses(output: string): { train: number | null; valid: number | null } {
  const last = (re: RegExp): number | null => {
    let value: number | null = null;
    for (const m of output.matchAll(re)) value = Number(m[1]);
    return Number.isFinite(value) ? value : null;
  };
  return {
    train: last(/Iter \d+: Train loss ([0-9.]+)/g),
    valid: last(/Iter \d+: Val loss ([0-9.]+)/g),
  };
}

/** Every `Iter N: Val loss X` mlx-lm reported, in order. */
export function parseValCurve(output: string): Array<{ iter: number; valid: number }> {
  const out: Array<{ iter: number; valid: number }> = [];
  for (const m of output.matchAll(/Iter (\d+): Val loss ([0-9.]+)/g)) {
    const iter = Number(m[1]);
    const valid = Number(m[2]);
    if (Number.isFinite(iter) && Number.isFinite(valid)) out.push({ iter, valid });
  }
  return out;
}

/**
 * The checkpoint that actually validated best — which is not, in general, the
 * one training happened to stop on.
 *
 * mlx-lm writes `{iter}_adapters.safetensors` as it goes and leaves the FINAL
 * state in `adapters.safetensors`. Reading only the last reported val loss and
 * shipping only the final adapter means that once validation bottoms out and
 * starts drifting back up — which is the normal shape of a training run, and
 * was observed on this corpus at iteration 200 of 1200 — every later iteration
 * makes the shipped adapter worse while the number reported about it also gets
 * worse. Both halves are avoidable: the good adapter was written to disk and
 * then passed over.
 *
 * Returns null when the final checkpoint is already the best one, so the
 * common case does nothing at all.
 */
export function bestCheckpoint(
  output: string,
  adapterDir: string,
): { iter: number; valid: number; file: string; finalValid: number } | null {
  const curve = parseValCurve(output);
  if (curve.length < 2) return null;
  const best = curve.reduce((a, b) => (b.valid < a.valid ? b : a));
  const final = curve[curve.length - 1]!;
  // Being the last VALIDATED point is not the same as being what is on disk.
  // mlx-lm saves on its own interval, so a run interrupted between validations
  // leaves `adapters.safetensors` holding a state nothing ever measured —
  // observed exactly: best validation at iteration 600, live adapter from 700.
  // Comparing only the curve said "the final is already the best" and shipped
  // the unvalidated one.
  const liveIsUnvalidated = (): boolean => {
    const live = path.join(adapterDir, 'adapters.safetensors');
    const bestFile = path.join(adapterDir, `${String(best.iter).padStart(7, '0')}_adapters.safetensors`);
    if (!fs.existsSync(live) || !fs.existsSync(bestFile)) return false;
    try {
      return !fs.readFileSync(live).equals(fs.readFileSync(bestFile));
    } catch {
      return false;
    }
  };
  if (best.iter === final.iter && !liveIsUnvalidated()) return null;
  // A checkpoint only counts if it is on disk. mlx-lm's save interval and its
  // eval interval are configured separately and need not line up.
  const padded = String(best.iter).padStart(7, '0');
  const file = path.join(adapterDir, `${padded}_adapters.safetensors`);
  if (!fs.existsSync(file)) return null;
  return { iter: best.iter, valid: best.valid, file, finalValid: final.valid };
}

/**
 * Promote the best-validating checkpoint over the final one.
 *
 * The previous `adapters.safetensors` is kept beside it rather than
 * overwritten away: it is the state training actually ended in, and throwing it
 * out would make this irreversible on a hunch about two numbers.
 */
export function promoteBestCheckpoint(output: string, adapterDir: string): { promoted: boolean; note: string } {
  const best = bestCheckpoint(output, adapterDir);
  if (!best) return { promoted: false, note: '' };
  const live = path.join(adapterDir, 'adapters.safetensors');
  try {
    if (fs.existsSync(live)) fs.copyFileSync(live, path.join(adapterDir, 'final_adapters.safetensors'));
    fs.copyFileSync(best.file, live);
    return {
      promoted: true,
      note:
        `kept the iteration-${best.iter} checkpoint (val ${best.valid.toFixed(3)}) over the final state ` +
        `(val ${best.finalValid.toFixed(3)}); the final state is at final_adapters.safetensors`,
    };
  } catch (err) {
    return { promoted: false, note: `could not promote the best checkpoint: ${(err as Error).message}` };
  }
}

export function lockFile(): string {
  return localModelLockFile();
}

/** The pid currently holding the machine's local model, or null. */
export function activeTrainingPid(): number | null {
  return localModelLockHolder()?.pid ?? null;
}

export function trainArgsFor(persona: Persona, iters?: number): string[] {
  const args = [
    '-m', 'mlx_lm', 'lora',
    '--model', persona.base,
    '--train',
    '--data', personaDataDir(persona.id),
    '--adapter-path', personaAdapterDir(persona.id),
    '--iters', String(iters ?? persona.training.iters),
    '--batch-size', String(persona.training.batchSize),
    '--num-layers', String(persona.training.loraLayers),
    '--learning-rate', String(persona.training.learningRate),
    '--max-seq-length', String(persona.training.maxSeqLength),
    // The loss belongs on the completion. Without this the adapter spends half
    // its capacity learning to reproduce briefs it will always be handed.
    '--mask-prompt',
  ];
  if (persona.training.gradCheckpoint) args.push('--grad-checkpoint');
  if (persona.training.mode === 'dpo') args.push('--training-mode', 'dpo');
  return args;
}

/**
 * Whether this machine can train this base without swapping itself to a halt.
 *
 * Measured, not guessed: the weights are already on disk, so their size is
 * known, and training needs room for them plus optimizer state, activations and
 * whatever else is resident. A 12B at 4-bit is ~7 GB of weights, which on a
 * 17 GB machine left 31 of 32 GB of swap in use and dropped the trainer to 9%
 * CPU — it was not training, it was paging. Refusing up front costs a sentence;
 * finding out costs half an hour and the machine.
 *
 * The ceiling is a fraction of physical RAM rather than of free RAM: free
 * memory swings with whatever is open, and a run that only fits on a quiet
 * desktop is a run that fails the first time you open something.
 */
export function memoryPreflight(persona: Persona, weightsBytes: number | null): string | null {
  if (weightsBytes === null || weightsBytes <= 0) return null; // not downloaded yet; let mlx-lm say so
  const totalBytes = os.totalmem();
  const share = Number(process.env['FOREMAN_TRAIN_MEMORY_SHARE'] ?? 0.4);
  const budget = totalBytes * share;
  if (weightsBytes <= budget) return null;
  const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`;
  return (
    `${persona.base} is ${gb(weightsBytes)} of weights, over the ${gb(budget)} training budget on a ` +
    `${gb(totalBytes)} machine — it would page rather than train. Pick a smaller base with ` +
    `\`foreman persona set ${persona.id} --base <model>\`, or raise FOREMAN_TRAIN_MEMORY_SHARE if you ` +
    'are willing to give the trainer the machine.'
  );
}

/** Size of a model's weight files, from the local HF cache; null if not cached. */
export function cachedWeightsBytes(base: string): number | null {
  const home = process.env['HF_HOME'] ?? path.join(os.homedir(), '.cache', 'huggingface');
  const dir = path.join(home, 'hub', `models--${base.replace(/\//g, '--')}`);
  if (!fs.existsSync(dir)) return fs.existsSync(base) ? dirBytes(base) : null;
  return dirBytes(dir);
}

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (current: string, depth = 0): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // The HF cache keeps the real bytes in `blobs/` under content-hash names
      // with no extension, and `snapshots/` is symlinks into them. Counting by
      // extension therefore measures nothing at all; counting every regular
      // file and skipping symlinks measures each blob exactly once.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

/**
 * Whether the installed mlx-lm can train the mode this persona asks for.
 *
 * DPO is not in every mlx-lm — 0.31.3 has no such flag — and emitting
 * `--training-mode dpo` at a parser that has never heard of it fails the job
 * on a usage error. Asking the binary what it supports is cheap, and turns
 * that into a sentence the operator can act on.
 */
export async function modeSupported(mode: 'sft' | 'dpo'): Promise<string | null> {
  if (mode === 'sft') return null;
  try {
    const { stdout } = await exec(python(), ['-m', 'mlx_lm', 'lora', '--help'], { timeout: 60_000 });
    if (stdout.includes('--training-mode')) return null;
  } catch {
    return 'could not ask mlx-lm which training modes it supports';
  }
  return (
    'this mlx-lm has no DPO training mode — set the persona\'s training.mode to "sft", ' +
    'or upgrade mlx-lm to a version that supports preference training'
  );
}

/**
 * Train one persona in the background, yielding to the operator's work.
 *
 * `nice` is applied by spawning through it rather than by re-nicing after the
 * fact: a process that starts at normal priority has already taken its first
 * slice by the time anything could lower it.
 */
export async function trainPersonaGoverned(
  persona: Persona,
  opts: GovernorOptions,
): Promise<GovernorResult> {
  const adapterDir = personaAdapterDir(persona.id);
  // One local model on this machine, whoever is using it: a trainer and a
  // chapter-flagging run are both weights in the same RAM.
  const held = acquireLocalModelLock(`training ${persona.id}`);
  if (held) {
    return {
      ok: false,
      reason: `the local model is in use by ${describeHolder(held)}`,
      adapterDir, ranMs: 0, suspensions: 0, loss: { train: null, valid: null }, overfit: null,
    };
  }

  const blocked =
    (await trainPreflight()) ??
    (await modeSupported(persona.training.mode)) ??
    memoryPreflight(persona, cachedWeightsBytes(persona.base));
  if (blocked) {
    return { ok: false, reason: blocked, adapterDir, ranMs: 0, suspensions: 0, loss: { train: null, valid: null }, overfit: null };
  }

  const dataFile = path.join(personaDataDir(persona.id), persona.training.mode === 'dpo' ? 'dpo_train.jsonl' : 'train.jsonl');
  if (!fs.existsSync(dataFile) || fs.statSync(dataFile).size === 0) {
    return {
      ok: false,
      reason: `no training data at ${dataFile} — run: foreman persona build`,
      adapterDir, ranMs: 0, suspensions: 0, loss: { train: null, valid: null }, overfit: null,
    };
  }

  fs.mkdirSync(adapterDir, { recursive: true });
  const args = trainArgsFor(persona);
  const niceness = process.env['FOREMAN_TRAIN_NICE'] ?? '19';
  const child = spawn('nice', ['-n', niceness, python(), ...args], {
    cwd: alignDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own group, so suspending the trainer cannot suspend the daemon.
    detached: true,
  });
  // Re-stamp with the child's pid so the lock tracks the process that actually
  // holds the memory, and outlives this one if the CLI is killed under nohup.
  releaseLocalModelLock();
  acquireLocalModelLock(`training ${persona.id}`, child.pid ?? process.pid);

  const pollMs = opts.pollMs ?? 5_000;
  const startedAt = Date.now();
  let suspended = false;
  let suspensions = 0;
  let suspendedMs = 0;
  let suspendedAt = 0;

  const transcript: string[] = [];
  const emit = (line: string): void => {
    // Kept so the losses can be read back: the trainer reports them on stdout
    // and nowhere else.
    if (transcript.length < 5_000) transcript.push(line);
    opts.onLine?.(line);
  };
  child.stdout?.on('data', (b: Buffer) => b.toString().split('\n').filter(Boolean).forEach(emit));
  child.stderr?.on('data', (b: Buffer) => b.toString().split('\n').filter(Boolean).forEach(emit));

  const signalGroup = (sig: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* the job is gone; the exit handler will settle it */
    }
  };

  const timer = setInterval(() => {
    const busy = opts.isBusy();
    if (busy && !suspended) {
      signalGroup('SIGSTOP');
      suspended = true;
      suspensions++;
      suspendedAt = Date.now();
      emit('training suspended: foreman has work in flight');
    } else if (!busy && suspended) {
      signalGroup('SIGCONT');
      suspended = false;
      suspendedMs += Date.now() - suspendedAt;
      emit('training resumed: the queue is quiet');
    }
  }, pollMs);

  const abort = (): void => {
    // A suspended process ignores SIGTERM until it runs again.
    if (suspended) signalGroup('SIGCONT');
    signalGroup('SIGTERM');
  };
  opts.signal?.addEventListener('abort', abort, { once: true });
  const deadline = opts.maxMs ? setTimeout(abort, opts.maxMs) : null;

  const code: number = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('exit', (c) => resolve(c ?? -1));
  });

  clearInterval(timer);
  if (deadline) clearTimeout(deadline);
  opts.signal?.removeEventListener('abort', abort);
  releaseLocalModelLock(child.pid ?? process.pid);

  const produced = fs.existsSync(adapterDir) && fs.readdirSync(adapterDir).some((f) => f.endsWith('.safetensors'));
  const output = transcript.join('\n');
  const loss = parseLosses(output);

  // Ship the checkpoint that validated best, not the one training stopped on.
  // Only ever a no-op or an improvement: `promoteBestCheckpoint` returns early
  // when the final state already is the best.
  const promotion = code === 0 && produced ? promoteBestCheckpoint(output, adapterDir) : { promoted: false, note: '' };
  if (promotion.note) opts.onLine?.(promotion.note);
  // The reported validation loss must describe the adapter that was actually
  // kept, or the overfit guard and the operator are both reading a number about
  // a file nobody will use.
  const best = promotion.promoted ? bestCheckpoint(output, adapterDir) : null;
  const effectiveLoss = best ? { train: loss.train, valid: best.valid } : loss;

  return {
    ok: code === 0 && produced,
    reason: code !== 0
      ? `mlx_lm exited ${code}`
      : produced
        ? `adapter written${promotion.promoted ? ` (${promotion.note})` : ''}`
        : 'training finished but wrote no adapter',
    adapterDir,
    ranMs: Date.now() - startedAt - suspendedMs,
    suspensions,
    loss: effectiveLoss,
    overfit: overfitWarning(effectiveLoss.train, effectiveLoss.valid),
  };
}

/**
 * A load-average fallback for callers with no view of the queue. Foreman's own
 * scheduler knows better and should pass its active count instead.
 */
export function machineIsBusy(threshold = os.cpus().length * 0.6): boolean {
  return os.loadavg()[0]! > threshold;
}
