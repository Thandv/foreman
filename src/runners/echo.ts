import type { Runner } from './index.ts';
import type { Stage } from '../types.ts';

const STEPS: Stage[] = ['plan', 'work', 'test', 'verify'];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Deterministic demo/self-test worker: walks the stage rail without calling a
 * model. A prompt containing "fail" ends with a failure, which is what the
 * gate and dependency-propagation tests exercise.
 */
export const echoRunner: Runner = {
  id: 'echo',
  takesBrief: true,
  verifiable: false,
  async preflight() {
    return null;
  },
  async run(ctx) {
    const stepMs = Number(process.env['FOREMAN_ECHO_STEP_MS'] ?? 900);
    for (const [i, stage] of STEPS.entries()) {
      ctx.stage(stage);
      ctx.log(`[${stage}] ${ctx.task.title}`);
      await sleep(stepMs, ctx.signal);
      ctx.progress((i + 1) / STEPS.length);
      ctx.usage({ tokensIn: 120, tokensOut: 80, costUsd: 0 });
    }
    const shouldFail = /\bfail\b/i.test(ctx.task.prompt);
    ctx.log(shouldFail ? 'simulated failure' : 'simulated success');
    return {
      ok: !shouldFail,
      summary: shouldFail ? 'echo runner failed on request' : `echoed ${ctx.task.prompt.length} chars`,
      exitCode: shouldFail ? 1 : 0,
    };
  },
};
