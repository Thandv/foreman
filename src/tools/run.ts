import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { entryPath, recordUse, toolsDir, validateArgs, type ToolManifest } from './catalog.ts';
import { scrubbedEnv } from '../runners/proc.ts';
import { describeReap, LeftoverReaper } from '../runners/proctree.ts';
import { SandboxError } from '../security/sandbox.ts';
import { sandboxedCommand } from '../verify/tests.ts';
import { validate } from './schema.ts';

export interface ToolRunResult {
  ok: boolean;
  /** Parsed stdout when the tool honoured its contract. */
  output: unknown;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  error: string | null;
}

export interface ToolRunOptions {
  /** Working directory — always a run jail, never the catalog. */
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT = Number(process.env['FOREMAN_TOOL_TIMEOUT_MS'] ?? 120_000);

/**
 * Run a catalog tool: JSON args on stdin, one JSON object on stdout. Failures
 * are values, not exceptions, so the caller can feed them back to a model —
 * but every outcome is recorded against the tool's quarantine counter.
 */
export async function runTool(tool: ToolManifest, args: unknown, opts: ToolRunOptions): Promise<ToolRunResult> {
  const started = Date.now();
  const fail = (error: string, extra: Partial<ToolRunResult> = {}): ToolRunResult => {
    recordUse(tool.name, false, error);
    return { ok: false, output: null, stderr: '', exitCode: null, durationMs: Date.now() - started, error, ...extra };
  };

  if (tool.quarantined) {
    // A refusal is not a failure by the tool; counting it would bury the
    // original reason under a growing pile of self-inflicted strikes.
    return {
      ok: false, output: null, stderr: '', exitCode: null, durationMs: Date.now() - started,
      error: `tool '${tool.name}' is quarantined: ${tool.quarantineReason ?? 'unknown'}`,
    };
  }

  const problems = validateArgs(tool, args);
  if (problems.length) return fail(`arguments do not match the tool's input schema: ${problems.join('; ')}`);

  let entry: string;
  try {
    entry = entryPath(tool);
    if (!fs.existsSync(entry)) return fail(`entry file missing: ${tool.entry}`);
  } catch (err) {
    return fail((err as Error).message);
  }

  const bin = tool.runtime === 'python' ? (process.env['FOREMAN_PYTHON'] ?? 'python3') : process.execPath;
  const maxBytes = opts.maxOutputBytes ?? 1_000_000;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  // A tool is code a worker wrote, run for a model that asked for it: under FOREMAN_SANDBOX it is confined to the
  // jail like the api runner's run_shell beside it (security/sandbox.ts), with a private HOME and TMPDIR and the
  // toolbox readable, never writable. A sandbox that cannot be built refuses the call; the tool is not run plain,
  // and the refusal is not counted against the tool.
  let launch: Awaited<ReturnType<typeof sandboxedCommand>>;
  try {
    launch = await sandboxedCommand(opts.cwd, bin, [entry], { readOnly: [path.resolve(toolsDir())] });
  } catch (err) {
    if (!(err instanceof SandboxError)) throw err;
    return { ok: false, output: null, stderr: '', exitCode: null, durationMs: Date.now() - started, error: `refused: ${err.message}` };
  }

  return new Promise<ToolRunResult>((resolve) => {
    const child = spawn(launch.cmd, launch.args, {
      cwd: opts.cwd,
      // A forged tool sees only PATH/HOME-class variables.
      env: scrubbedEnv('allow', { FOREMAN_TOOL: tool.name, ...launch.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    // What the tool leaves running is ended before its result is handed on, as for every other command (proc.ts).
    const reaper = child.pid !== undefined ? new LeftoverReaper(child.pid) : null;
    reaper?.start();
    let reaped: Promise<void> | null = null;
    child.on('exit', () => {
      reaper?.childExited();
      reaped ??= reaper
        ? reaper.reap().then((report) => {
            const line = describeReap(`tool '${tool.name}'`, report);
            if (line) process.stderr.write(`${line}\n`);
          }).catch(() => {})
        : Promise.resolve();
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let truncated = false;

    const kill = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    let timedOut = false;
    const onAbort = (): void => kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > maxBytes) {
        truncated = true;
        kill('SIGKILL');
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    const finish = (result: ToolRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reaper?.childExited();
      // Only a tool that exited has a reap to wait for; one that failed to start or to take its input has none.
      void (reaped ?? Promise.resolve()).then(() => {
        launch.done();
        recordUse(tool.name, result.ok, result.error ?? undefined);
        resolve(result);
      });
    };

    child.on('error', (err) =>
      finish({ ok: false, output: null, stderr, exitCode: null, durationMs: Date.now() - started, error: `could not start ${bin}: ${err.message}` }),
    );

    child.on('close', (code) => {
      const durationMs = Date.now() - started;
      const base = { stderr, exitCode: code, durationMs };
      if (truncated) return finish({ ...base, ok: false, output: null, error: `output exceeded ${maxBytes} bytes` });
      if (timedOut) return finish({ ...base, ok: false, output: null, error: `timed out after ${timeoutMs}ms` });
      if (code !== 0) return finish({ ...base, ok: false, output: null, error: `exited ${code}: ${stderr.slice(-500) || 'no stderr'}` });

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim() || 'null');
      } catch {
        return finish({ ...base, ok: false, output: null, error: `stdout was not JSON: ${stdout.slice(0, 300)}` });
      }
      const outProblems = tool.output && Object.keys(tool.output).length ? validate(parsed, tool.output) : [];
      if (outProblems.length) {
        return finish({ ...base, ok: false, output: parsed, error: `output does not match the schema: ${outProblems.join('; ')}` });
      }
      finish({ ...base, ok: true, output: parsed, error: null });
    });

    try {
      child.stdin.end(JSON.stringify(args ?? {}));
    } catch (err) {
      finish({ ok: false, output: null, stderr, exitCode: null, durationMs: Date.now() - started, error: `could not write args: ${(err as Error).message}` });
    }
  });
}

/** Where a tool task is expected to leave its built tool inside the jail. */
export function builtToolDir(jail: string): string {
  return path.join(jail, 'tool');
}
