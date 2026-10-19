import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

/** A live daemon already owns this FOREMAN_HOME. */
export class DaemonLockError extends Error {}

/** True when a process with this pid exists (EPERM means it exists but isn't ours). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One daemon per home, enforced with an O_EXCL pidfile. A stale lock left by
 * a dead pid is reclaimed; a live pid is a hard startup error. Returns a
 * release function that removes the lock only while we still own it.
 */
export function acquireDaemonLock(home: string = config.home, pid: number = process.pid): () => void {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'daemon.pid');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, `${pid}\n`, { flag: 'wx' }); // O_CREAT|O_EXCL
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file);
        } catch {
          /* already released */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    let holder = NaN;
    try {
      holder = Number(fs.readFileSync(file, 'utf8').trim());
    } catch {
      continue; // the holder released between our open and read; try again
    }
    // A recorded pid equal to our own is never a live rival: this process has
    // not taken the lock yet. It is a lock left by a daemon that died before a
    // reboot, whose pid the new one happened to get — and signal 0 to our own
    // pid always succeeds, so without this the daemon refused to start, every
    // time, until someone deleted the file by hand.
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
      throw new DaemonLockError(
        `another foreman daemon (pid ${holder}) already owns ${home} — ` +
          'stop it first, or point FOREMAN_HOME at a different directory',
      );
    }
    // The recorded pid is dead (or the file is garbage): reclaim the stale lock.
    try {
      fs.unlinkSync(file);
    } catch {
      /* a racing daemon reclaimed it first; the next attempt decides */
    }
  }
  throw new DaemonLockError(`could not acquire ${file}: another daemon is starting up`);
}
