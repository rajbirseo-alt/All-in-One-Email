import { describe, expect, it } from 'vitest';
import { addBusinessMinutes, businessMinutesBetween, weeklyHoursProblems, type CalendarSpec, type WeeklyHours } from './business-clock';
import { matchPolicy } from './sla.service';

const weekdays = (spans: [string, string][]): WeeklyHours => ({ mon: spans, tue: spans, wed: spans, thu: spans, fri: spans, sat: [], sun: [] });
const india = (holidays: string[] = []): CalendarSpec => ({ timezone: 'Asia/Kolkata', weeklyHours: weekdays([['09:30', '18:30']]), holidays });
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('business clock (time travel)', () => {
  it('counts only opening hours within a day', () => {
    // Wed 18 Nov 2026 10:00 IST + 90 min = 11:30 IST
    expect(iso(addBusinessMinutes(india(), new Date('2026-11-18T04:30:00Z'), 90))).toBe('2026-11-18T06:00:00.000Z');
  });

  it('starts counting at opening time when mail arrives before hours', () => {
    // Wed 06:00 IST → opens 09:30, +30 = 10:00 IST
    expect(iso(addBusinessMinutes(india(), new Date('2026-11-18T00:30:00Z'), 30))).toBe('2026-11-18T04:30:00.000Z');
  });

  it('skips the weekend', () => {
    // Fri 20 Nov 17:30 IST + 120 min: 60 on Friday, 60 on Monday → Mon 23 Nov 10:30 IST
    expect(iso(addBusinessMinutes(india(), new Date('2026-11-20T12:00:00Z'), 120))).toBe('2026-11-23T05:00:00.000Z');
  });

  it('skips holidays', () => {
    // Same as above with Monday a holiday → Tue 24 Nov 10:30 IST
    expect(iso(addBusinessMinutes(india(['2026-11-23']), new Date('2026-11-20T12:00:00Z'), 120))).toBe('2026-11-24T05:00:00.000Z');
  });

  it('mail on a holiday waits for the next working day', () => {
    // Mon 23 Nov (holiday) 11:00 IST + 30 → Tue 10:00 IST
    expect(iso(addBusinessMinutes(india(['2026-11-23']), new Date('2026-11-23T05:30:00Z'), 30))).toBe('2026-11-24T04:30:00.000Z');
  });

  it('respects a lunch break', () => {
    const cal: CalendarSpec = { timezone: 'Asia/Kolkata', weeklyHours: weekdays([['09:30', '13:00'], ['14:00', '18:30']]), holidays: [] };
    // Wed 12:30 IST + 60: 30 before lunch, 30 after → 14:30 IST
    expect(iso(addBusinessMinutes(cal, new Date('2026-11-18T07:00:00Z'), 60))).toBe('2026-11-18T09:00:00.000Z');
  });

  it('follows the calendar time zone across a daylight-saving change', () => {
    const ny: CalendarSpec = { timezone: 'America/New_York', weeklyHours: weekdays([['09:00', '17:00']]), holidays: [] };
    // Fri 12 Mar 2027 16:00 EST (UTC−5) + 120 → Mon 15 Mar 10:00 EDT (UTC−4); clocks moved on Sunday 14 Mar
    expect(iso(addBusinessMinutes(ny, new Date('2027-03-12T21:00:00Z'), 120))).toBe('2027-03-15T14:00:00.000Z');
  });

  it('the same instant is a different business day in another time zone', () => {
    const london: CalendarSpec = { timezone: 'Europe/London', weeklyHours: weekdays([['09:00', '17:00']]), holidays: [] };
    // Fri 20 Nov 2026 20:00 UTC: after hours in London (opens Mon 09:00 UTC) and already Saturday in India
    expect(iso(addBusinessMinutes(london, new Date('2026-11-20T20:00:00Z'), 60))).toBe('2026-11-23T10:00:00.000Z');
    expect(iso(addBusinessMinutes(india(), new Date('2026-11-20T20:00:00Z'), 60))).toBe('2026-11-23T05:00:00.000Z');
  });

  it('supports hours until midnight', () => {
    const late: CalendarSpec = { timezone: 'Asia/Kolkata', weeklyHours: weekdays([['20:00', '24:00']]), holidays: [] };
    // Wed 23:30 IST + 60 → 30 on Wednesday, then Thu 20:30 IST
    expect(iso(addBusinessMinutes(late, new Date('2026-11-18T18:00:00Z'), 60))).toBe('2026-11-19T15:00:00.000Z');
  });

  it('0 minutes fires immediately, even outside hours', () => {
    const sunday = new Date('2026-11-22T06:00:00Z');
    expect(addBusinessMinutes(india(), sunday, 0)).toEqual(sunday);
  });

  it('never comes due on a calendar without opening hours', () => {
    const closed: CalendarSpec = { timezone: 'Asia/Kolkata', weeklyHours: weekdays([]), holidays: [] };
    expect(addBusinessMinutes(closed, new Date('2026-11-18T04:30:00Z'), 30)).toBeNull();
  });

  it('measures business minutes between two instants', () => {
    // Fri 17:30 IST → Mon 10:30 IST = 60 + 60
    expect(businessMinutesBetween(india(), new Date('2026-11-20T12:00:00Z'), new Date('2026-11-23T05:00:00Z'))).toBe(120);
    expect(businessMinutesBetween(india(['2026-11-23']), new Date('2026-11-20T12:00:00Z'), new Date('2026-11-23T05:00:00Z'))).toBe(60);
  });

  it('validates weekly hours', () => {
    expect(weeklyHoursProblems(weekdays([['09:30', '18:30']]))).toEqual([]);
    expect(weeklyHoursProblems(weekdays([['18:00', '09:00']])).length).toBe(5);
    expect(weeklyHoursProblems({ ...weekdays([]), mon: [['09:00', '13:00'], ['12:00', '17:00']] })).toEqual(['mon: opening hours overlap']);
    expect(weeklyHoursProblems({ ...weekdays([]), mon: [['9:00', '17:00']] })).toEqual(['mon: times must be HH:MM']);
  });
});

describe('SLA policy matching', () => {
  const p = (name: string, departmentId: string | null, priority: 'URGENT' | 'NORMAL' | null, isDefault = false, isEnabled = true) => ({ name, departmentId, priority, isDefault, isEnabled });
  const all = [p('default', null, null, true), p('urgent anywhere', null, 'URGENT'), p('sales', 'sales', null), p('sales urgent', 'sales', 'URGENT'), p('hr off', 'hr', null, false, false)];

  it('most specific policy wins', () => {
    expect(matchPolicy(all, 'sales', 'URGENT')?.name).toBe('sales urgent');
    expect(matchPolicy(all, 'sales', 'NORMAL')?.name).toBe('sales');
    expect(matchPolicy(all, 'finance', 'URGENT')?.name).toBe('urgent anywhere');
    expect(matchPolicy(all, 'finance', 'NORMAL')?.name).toBe('default');
    expect(matchPolicy(all, null, 'NORMAL')?.name).toBe('default');
  });

  it('ignores disabled policies', () => {
    expect(matchPolicy(all, 'hr', 'NORMAL')?.name).toBe('default');
    expect(matchPolicy([p('hr off', 'hr', null, false, false)], 'hr', 'NORMAL')).toBeNull();
  });
});
