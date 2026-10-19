import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnStreaming } from '../runners/proc.ts';
import { alignDir } from './extract.ts';

const exec = promisify(execFile);
/** Read lazily, never captured at module load, so a test or an operator can point it elsewhere per case. */
const python = (): string => process.env['FOREMAN_PYTHON'] ?? '/opt/homebrew/bin/python3';

export interface TrainOptions {
  /** Hugging Face id or local path of the base model. */
  base: string;
  dataDir: string;
  adapterName: string;
  iters?: number;
  batchSize?: number;
  loraLayers?: number;
  learningRate?: number;
  /** 'sft' uses train.jsonl; 'dpo' uses dpo_train.jsonl. */
  mode?: 'sft' | 'dpo';
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export interface TrainResult {
  ok: boolean;
  adapterDir: string;
  reason: string;
  command: string;
}

export function adaptersDir(): string {
  return path.join(alignDir(), 'adapters');
}

/**
 * QLoRA training runs through mlx-lm, which is the Apple-Silicon-native path.
 * It is an optional dependency: without it the pipeline still extracts, redacts
 * and builds datasets, and says plainly that it cannot train.
 */
export async function trainPreflight(): Promise<string | null> {
  try {
    await exec(python(), ['-c', 'import mlx_lm'], { timeout: 30_000 });
    return null;
  } catch {
    return `mlx-lm is not installed for ${python()} — install it with: ${python()} -m pip install mlx-lm`;
  }
}

export function buildTrainArgs(opts: TrainOptions): string[] {
  const mode = opts.mode ?? 'sft';
  const args = [
    '-m', 'mlx_lm', 'lora',
    '--model', opts.base,
    '--train',
    '--data', opts.dataDir,
    '--adapter-path', path.join(adaptersDir(), opts.adapterName),
    '--iters', String(opts.iters ?? 600),
    '--batch-size', String(opts.batchSize ?? 1),
    '--num-layers', String(opts.loraLayers ?? 8),
    '--learning-rate', String(opts.learningRate ?? 1e-5),
  ];
  if (mode === 'dpo') args.push('--training-mode', 'dpo');
  return args;
}

export async function train(opts: TrainOptions): Promise<TrainResult> {
  const adapterDir = path.join(adaptersDir(), opts.adapterName);
  const args = buildTrainArgs(opts);
  const command = `${python()} ${args.join(' ')}`;

  const blocked = await trainPreflight();
  if (blocked) return { ok: false, adapterDir, reason: blocked, command };

  const dataFile = path.join(opts.dataDir, opts.mode === 'dpo' ? 'dpo_train.jsonl' : 'train.jsonl');
  if (!fs.existsSync(dataFile) || fs.statSync(dataFile).size === 0) {
    return { ok: false, adapterDir, reason: `no training data at ${dataFile} — run: foreman align build`, command };
  }

  fs.mkdirSync(adapterDir, { recursive: true });
  const code = await spawnStreaming(python(), args, {
    cwd: alignDir(),
    signal: opts.signal ?? new AbortController().signal,
    onLine: (line) => opts.onLine?.(line),
  });
  const produced = fs.existsSync(adapterDir) && fs.readdirSync(adapterDir).some((f) => f.endsWith('.safetensors'));
  return {
    ok: code === 0 && produced,
    adapterDir,
    reason: code !== 0 ? `mlx_lm exited ${code}` : produced ? 'adapter written' : 'training finished but wrote no adapter',
    command,
  };
}
