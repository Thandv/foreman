import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { provisionDeps } from './deps.ts';
import { createJail, removeJail, type Jail } from './isolate.ts';
import { claudeWorkerEnv } from './runners/claudeIsolation.ts';
import { workerEnv } from './runners/cliRunners.ts';
import type { Task } from './types.ts';

export interface JailCheckSeams {
  /** The checkout the jail is cut from. Default: the Foreman checkout this process runs from. */
  repo?: string;
  createJail?: (task: Task, runId: string) => Promise<Jail>;
  timeoutMs?: number;
  removeJail?: (jail: Jail) => Promise<void>;
}

const TIMEOUT_MS = 60_000;

/** What the wrapper said, on one line: the line that names the refusal if there is one, else the last few. */
function said(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const cause = lines.find((l) => /contains Foreman's home|refused|SandboxError|Error:/.test(l));
  return (cause ?? lines.slice(-3).join(' | ')).slice(0, 400);
}

/**
 * `foreman doctor`: does the suite wrapper a worker runs work from inside a jail? A scratch jail of this checkout,
 * the slot wrapper started in it with a worker's environment and the sandbox on, `node -e 0` as the suite.
 * One line, never throws; the jail is gone when it returns.
 */
export async function workerSuiteInJail(seams: JailCheckSeams = {}): Promise<string> {
  const runId = `doctor-${process.pid}`;
  const repo = seams.repo ?? config.sourceRoot;
  const task = { id: runId, repo, testCmd: 'node -e 0' } as Task;
  const timeoutMs = seams.timeoutMs ?? TIMEOUT_MS;
  let jail: Jail | null = null;
  let line: string;
  try {
    jail = await (seams.createJail ?? createJail)(task, runId);
    // allowInstall off: a doctor line never runs `npm`.
    await provisionDeps(jail.dir, jail.repo ?? repo, { allowInstall: false });
    const env = {
      ...claudeWorkerEnv(task),
      ...workerEnv(task, runId),
      FOREMAN_SANDBOX: 'tests',
      // No daemon to ask for a slot: the wrapper then runs the command unslotted.
      FOREMAN_PORT: '0',
    };
    const cwd = jail.dir;
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [path.join('src', 'verify', 'testSlot.ts'), '--', 'node', '-e', '0'],
        { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return resolve();
          const e = err as { killed?: boolean; code?: unknown };
          reject(new Error(e.killed ? `timed out after ${timeoutMs}ms` : `exit ${e.code}: ${said(`${stderr}\n${stdout}`)}`));
        },
      );
    });
    line = 'worker suite in a jail: ok';
  } catch (err) {
    line = `worker suite in a jail: FAIL ${(err as Error).message.split('\n')[0]!.slice(0, 400)}`;
  }
  if (!jail) return line;
  // A jail that stays is said, never a plain ok: removeJail swallows its own errors, so look for the directory too.
  let left: string | null = null;
  try {
    await (seams.removeJail ?? removeJail)(jail);
  } catch (err) {
    left = (err as Error).message.split('\n')[0]!.slice(0, 200);
  }
  if (left === null && fs.existsSync(jail.dir)) left = 'directory still exists';
  if (left === null) return line;
  const was = line.replace('worker suite in a jail: FAIL ', '').replace('worker suite in a jail: ', '');
  return `worker suite in a jail: FAIL ${was === 'ok' ? '' : `(${was}) `}jail left at ${jail.dir} (${left})`;
}
