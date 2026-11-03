import fs from 'node:fs';

/** The statfs fields the free-space check reads; injectable so tests need no real full disk. */
export type StatfsFn = (dir: string) => { bavail: number | bigint; bsize: number | bigint };

export const DEFAULT_MIN_FREE_MB = 2048;

/** FOREMAN_MIN_FREE_MB: a non-negative number of MB; empty, non-numeric or negative falls back to the default. */
export function minFreeMb(raw: string | undefined = process.env['FOREMAN_MIN_FREE_MB']): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_FREE_MB;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_FREE_MB;
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
