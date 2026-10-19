/**
 * A deliberately small recurrence language. Full cron would be more
 * expressive than anything Foreman needs, and every extra field is another
 * way for a batch to fire at 3am when the operator meant 3pm.
 *
 *   every 30m | every 2h | every 1d
 *   daily 07:30
 *   weekly mon 09:00
 */
export interface Recurrence {
  spec: string;
  describe: string;
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class BadSchedule extends Error {}

export function parseSpec(spec: string): Recurrence {
  const s = spec.trim().toLowerCase();
  if (/^every\s+\d+\s*[mhd]$/.test(s)) return { spec: s, describe: s };
  const daily = s.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    assertTime(Number(daily[1]), Number(daily[2]), spec);
    return { spec: s, describe: s };
  }
  const weekly = s.match(/^weekly\s+([a-z]{3})\s+(\d{1,2}):(\d{2})$/);
  if (weekly) {
    if (!DAYS.includes(weekly[1]!)) throw new BadSchedule(`unknown weekday: ${weekly[1]}`);
    assertTime(Number(weekly[2]), Number(weekly[3]), spec);
    return { spec: s, describe: s };
  }
  throw new BadSchedule(
    `unrecognised schedule: ${spec} (use "every 30m", "daily 07:30" or "weekly mon 09:00")`,
  );
}

function assertTime(hour: number, minute: number, spec: string): void {
  if (hour > 23 || minute > 59) throw new BadSchedule(`impossible time in schedule: ${spec}`);
}

/** Next firing strictly after `from`. Local time, matching operator intent. */
export function nextRunAt(spec: string, from: number = Date.now()): number {
  const { spec: s } = parseSpec(spec);

  const every = s.match(/^every\s+(\d+)\s*([mhd])$/);
  if (every) {
    const ms = Number(every[1]) * UNIT_MS[every[2]!]!;
    if (ms <= 0) throw new BadSchedule(`interval must be positive: ${spec}`);
    return from + ms;
  }

  const daily = s.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(Number(daily[1]), Number(daily[2]));
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  const weekly = s.match(/^weekly\s+([a-z]{3})\s+(\d{1,2}):(\d{2})$/)!;
  const target = DAYS.indexOf(weekly[1]!);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(Number(weekly[2]), Number(weekly[3]));
  let delta = (target - next.getDay() + 7) % 7;
  if (delta === 0 && next.getTime() <= from) delta = 7;
  next.setDate(next.getDate() + delta);
  return next.getTime();
}
