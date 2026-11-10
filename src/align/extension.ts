import type { Extension } from '../extensions.ts';
import { localModelLockHolder } from './localLock.ts';
import { startAdoptedPersonas } from './personaHealth.ts';

/**
 * Alignment's part in the daemon: it starts the adopted persona servers, and it holds new work while a trainer or an
 * adoption gate owns the machine's inference.
 */
export const alignExtension: Extension = {
  name: 'align',
  // An adopted persona is already routed live work by modelForTask, so the
  // daemon owning its server is not a convenience — it is what keeps routing
  // and reality in step. A model server that will not start is a reason to
  // refuse the tickets that want it, never a reason to refuse to boot the queue.
  async onStart(store) {
    for (const r of await startAdoptedPersonas()) {
      if (r.reason === 'already serving') continue;
      store.record({ type: 'status', message: `persona ${r.id}: ${r.ok ? 'serving' : `not serving — ${r.reason}`}` });
    }
  },
  /**
   * A trainer or an adoption gate holds the machine-wide local-model lock for hours, and starting new work under it
   * is how a 17 GB machine ends up 33 GB into swap — the exact collision the lock was created for after it happened
   * once for real.
   *
   * Deliberately blunt: it pauses ALL dispatch, not just tasks that would touch a local model. A cloud-runner ticket
   * looks harmless until its verify stage asks the local council for two opinions, and by then a worktree has been
   * cut and a model is loading. Predicting what a task will do before it does it is not knowable; pausing for a few
   * hours while an adapter trains is cheap and is correct.
   *
   * `FOREMAN_IGNORE_TRAINING_LOCK=1` opts out for an operator with the memory headroom to run both.
   */
  dispatchHold: {
    kind: 'local-lock',
    released: 'local-model lock released; dispatch resumed',
    current() {
      if (process.env['FOREMAN_IGNORE_TRAINING_LOCK'] === '1') return null;
      const holder = localModelLockHolder();
      if (!holder) return null;
      const who = `${holder.label} (pid ${holder.pid})`;
      return {
        paused: `dispatch paused: ${who} holds the local-model lock. Running work continues.`,
        held: `held: ${who} holds the local-model lock; new work waits until it releases the lock`,
      };
    },
  },
};
