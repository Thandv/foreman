import type { Runner } from './index.ts';
import { spawnStreaming, withoutColourEnv } from './proc.ts';
import { SandboxError } from '../security/sandbox.ts';
import { sandboxedShell } from '../verify/tests.ts';

/**
 * Runs the task prompt as a shell command inside the jail. Useful for build,
 * migration, and test-sweep tasks that need no model at all.
 */
export const shellRunner: Runner = {
  id: 'shell',
  takesBrief: false,
  verifiable: true,
  async preflight() {
    return null;
  },
  async run(ctx) {
    ctx.stage('work', 'running shell command');
    let lines = 0;
    // The command is the ticket's text: under FOREMAN_SANDBOX it runs confined to the jail (security/sandbox.ts).
    let launch: Awaited<ReturnType<typeof sandboxedShell>>;
    try {
      launch = await sandboxedShell(ctx.dir, ctx.task.prompt);
    } catch (err) {
      if (!(err instanceof SandboxError)) throw err;
      ctx.log(`foreman: ${err.message}`);
      return { ok: false, exitCode: null, summary: `shell command not run: ${err.message}` };
    }
    let code: number;
    try {
      code = await spawnStreaming(launch.cmd, launch.args, {
        cwd: ctx.dir,
        signal: ctx.signal,
        // The daemon's environment as before, minus the colour switches it happened to inherit (proc.ts COLOUR_ENV).
        // The command itself must stay untouched, so critique arrives out of band.
        env: {
          ...withoutColourEnv(process.env),
          ...(ctx.task.repairNotes ? { FOREMAN_REPAIR_NOTES: ctx.task.repairNotes } : {}),
          ...launch.env,
        },
        replaceEnv: true,
        onSpawn: (pid) => ctx.child(pid),
        onLine: (line) => {
          lines++;
          ctx.log(line);
          // No total to divide by, so creep toward 90% and let the caller finish it.
          ctx.progress(Math.min(0.9, lines / 200));
        },
      });
    } finally {
      launch.done();
    }
    ctx.child(null);
    ctx.progress(1);
    return {
      ok: code === 0,
      exitCode: code,
      summary: code === 0 ? `shell command succeeded (${lines} lines)` : `shell command exited ${code}`,
    };
  },
};
