import { describe, expect, it } from 'vitest';
import { getGregorianCalendar } from '../../common/calendar.js';
import { checkCalendarDate, normalizeCalendarDate, normalizeTimePoint } from '../../common/timePoint.js';

const date = { era: 'ad', year: 2023 };
const anchor = 'aaaaaaaa-0000-0000-0000-000000000000';

describe('time points', () => {
  it('stores partial dates and IDs from an older calendar', () => {
    const oldDate = { era: 'old-era', year: -10, month: 'gone', day: 1000, time: { hour: 99, minute: 59 } };
    const point = normalizeTimePoint({ kind: 'date', date: oldDate });
    expect(point).toEqual({ kind: 'date', date: oldDate });
    expect(point.kind === 'date' && point.date.time).not.toBe(oldDate.time);
    expect(normalizeCalendarDate(date)).toEqual(date);
    expect(normalizeCalendarDate({ ...date, month: 'jan' })).toEqual({ ...date, month: 'jan' });
    for (const kind of ['before', 'at', 'after']) {
      expect(normalizeTimePoint({ kind, anchor })).toEqual({ kind, anchor });
    }
    expect(normalizeTimePoint({ kind: 'unset' })).toEqual({ kind: 'unset' });
  });

  it.each([
    { day: 1 }, { month: 'jan', time: { hour: 0, minute: 0 } }, { year: 1.5 }, { year: 1e10 },
    { month: 'jan', day: 1, time: { hour: 0, minute: 60 } },
    { month: 'jan', day: 1, time: { hour: 100, minute: 0 } },
    { extra: 1 }, { month: 'jan', day: 1, time: { hour: 0, minute: 0, second: 0 } },
  ])('rejects malformed dates %j', patch => {
    expect(() => normalizeCalendarDate({ ...date, ...patch })).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it.each([
    { kind: 'unknown' }, { kind: 'after', anchor: 'not-a-uuid' }, { kind: 'date', date, anchor },
    { kind: 'unset', anchor }, { kind: 'at', anchor, note: '' },
  ])('rejects malformed points %j', input => {
    expect(() => normalizeTimePoint(input)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('checks the current calendar without modifying the date', () => {
    const calendar = getGregorianCalendar();
    calendar.hoursPerDay = 20;
    calendar.eras[1] = { id: 'ad', name: '한정 연호', countsDown: false, startYear: 2, endYear: 2024 };
    expect(checkCalendarDate(calendar, { ...date, month: 'feb', day: 29 })).toEqual({ ok: true });
    for (const valid of [
      { era: 'bc', year: 1 }, { era: 'ad', year: 2 }, { era: 'ad', year: 2024 },
      { ...date, month: 'apr', day: 30, time: { hour: 19, minute: 59 } },
    ]) {
      expect(checkCalendarDate(calendar, valid)).toEqual({ ok: true });
    }
    for (const invalid of [
      { era: 'bc', year: 0 }, { era: 'bc', year: -1 }, { era: 'ad', year: 0 }, { era: 'ad', year: 1 },
      { era: 'ad', year: 2025 },
    ]) {
      expect(checkCalendarDate(calendar, invalid)).toEqual({ ok: false, reason: 'year' });
    }
    expect(checkCalendarDate(calendar, { ...date, era: 'gone' })).toEqual({ ok: false, reason: 'era' });
    expect(checkCalendarDate(calendar, { ...date, month: 'gone' })).toEqual({ ok: false, reason: 'month' });
    expect(checkCalendarDate(calendar, { ...date, month: 'apr', day: 31 })).toEqual({ ok: false, reason: 'day' });
    expect(checkCalendarDate(calendar, { ...date, month: 'apr', day: 1, time: { hour: 20, minute: 0 } }))
      .toEqual({ ok: false, reason: 'time' });
  });
});
