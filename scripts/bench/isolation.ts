// What a bench that starts daemons may touch. Imported by identity.ts and its test; it reads no environment, so a test can
// import it without scripts/bench/env.ts's side effects.
import os from 'node:os';
import path from 'node:path';

/** The port the operator's own daemon listens on by default: a bench daemon never takes it. */
export const LIVE_PORT = 4100;

/** Throws unless `home` is outside the operator's ~/.foreman and `port` is not the live daemon's. */
export function assertIsolated(home: string, port: number): void {
  const live = path.join(os.homedir(), '.foreman');
  const rel = path.relative(live, path.resolve(home));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`refusing to run a daemon in ${home}: it is the operator's ~/.foreman or inside it`);
  }
  if (port === LIVE_PORT) throw new Error(`refusing to run a daemon on port ${LIVE_PORT}: it is the live daemon's port`);
}
