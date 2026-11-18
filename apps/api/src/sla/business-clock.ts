import { DateTime } from 'luxon';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** Opening hours per weekday in the calendar's time zone, e.g. { mon: [["09:30","13:00"],["14:00","18:30"]] }. "24:00" closes at midnight. */
export type WeeklyHours = Record<Weekday, [string, string][]>;

export interface CalendarSpec {
  timezone: string;
  weeklyHours: WeeklyHours;
  /** Local dates (YYYY-MM-DD) on which the office is closed all day. */
  holidays: Iterable<string>;
}

/** The clock never searches further ahead than this (a calendar with no open hours never comes due). */
const MAX_DAYS = 800;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isValidTimezone(tz: string) {
  return DateTime.now().setZone(tz).isValid;
}

/** Problems with a weekly-hours definition (empty = valid): bad times, end before start, overlaps. */
export function weeklyHoursProblems(w: WeeklyHours): string[] {
  const out: string[] = [];
  for (const d of WEEKDAYS) {
    const spans = [...(w[d] ?? [])].sort((a, b) => a[0].localeCompare(b[0]));
    let lastEnd = -1;
    for (const [a, b] of spans) {
      if (!HHMM.test(a) || !HHMM.test(b) || a === '24:00') {
        out.push(`${d}: times must be HH:MM`);
        continue;
      }
      if (minutesOf(b) <= minutesOf(a)) out.push(`${d}: ${a}–${b} ends before it starts`);
      if (minutesOf(a) < lastEnd) out.push(`${d}: opening hours overlap`);
      lastEnd = Math.max(lastEnd, minutesOf(b));
    }
  }
  return out;
}

/**
 * Open intervals [start, end) in UTC milliseconds, day by day in the calendar's zone, starting
 * with the local day that contains `from`. Holidays are skipped. Local times that do not exist
 * (spring-forward gap) are moved forward by luxon; repeated times (fall-back) use the first.
 */
function* openIntervals(cal: CalendarSpec, from: Date): Generator<[number, number]> {
  const holidays = cal.holidays instanceof Set ? (cal.holidays as Set<string>) : new Set(cal.holidays);
  let day = DateTime.fromJSDate(from, { zone: cal.timezone }).startOf('day');
  for (let i = 0; i < MAX_DAYS; i++, day = day.plus({ days: 1 })) {
    if (holidays.has(day.toISODate()!)) continue;
    const spans = cal.weeklyHours[WEEKDAYS[day.weekday - 1]!] ?? [];
    for (const [a, b] of [...spans].sort((x, y) => x[0].localeCompare(y[0]))) {
      const at = (hhmm: string) => (hhmm === '24:00' ? day.plus({ days: 1 }) : day.set({ hour: Number(hhmm.slice(0, 2)), minute: Number(hhmm.slice(3, 5)) })).toMillis();
      const s = at(a);
      const e = at(b);
      if (e > s) yield [s, e];
    }
  }
}

/**
 * The instant at which `minutes` business minutes have passed since `start`.
 * 0 minutes means "immediately" (at `start`, even outside opening hours).
 * Returns null when the calendar has no opening hours within the search window.
 */
export function addBusinessMinutes(cal: CalendarSpec, start: Date, minutes: number): Date | null {
  if (minutes <= 0) return start;
  let left = minutes * 60_000;
  const t0 = start.getTime();
  for (const [s, e] of openIntervals(cal, start)) {
    if (e <= t0) continue;
    const from = Math.max(s, t0);
    if (e - from >= left) return new Date(from + left);
    left -= e - from;
  }
  return null;
}

/** Business minutes between two instants (0 if `b` is not after `a`). */
export function businessMinutesBetween(cal: CalendarSpec, a: Date, b: Date): number {
  if (b <= a) return 0;
  let total = 0;
  for (const [s, e] of openIntervals(cal, a)) {
    if (s >= b.getTime()) break;
    const from = Math.max(s, a.getTime());
    const to = Math.min(e, b.getTime());
    if (to > from) total += to - from;
  }
  return Math.floor(total / 60_000);
}

/** "18 Nov, 4:30 pm" in the calendar's zone (used in notification texts). */
export function formatLocal(d: Date, timezone: string) {
  return DateTime.fromJSDate(d, { zone: timezone }).toFormat("d LLL, h:mm a").replace('AM', 'am').replace('PM', 'pm');
}
