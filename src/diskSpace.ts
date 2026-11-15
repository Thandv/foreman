import fs from 'node:fs';
import { config } from './config.ts';

/** The statfs fields the free-space check reads; injectable so tests need no real full disk. */
export type StatfsFn = (dir: string) => { bavail: number | bigint; bsize: number | bigint };

/** FOREMAN_MIN_FREE_MB: a non-negative number of MB; empty, non-numeric or negative falls back to 2048. */
export function minFreeMb(): number {
  return config.minFreeMb;
}

/**
 * Free MB on the volume holding `dir` (nearest existing ancestor), or null when it cannot be read —
 * an unreadable volume never pauses dispatch on its own.
 */
export function freeMb(dir: string, statfs: StatfsFn = fs.statfsSync): number | null {
  let d = dir;
  for (;;) {
    try {
      const s = statfs(d);
      return (Number(s.bavail) * Number(s.bsize)) / (1024 * 1024);
    } catch {
      const parent = d.replace(/[\\/][^\\/]*$/, '');
      if (!parent || parent === d) return null;
      d = parent;
    }
  }
}
