import { describe, expect, it } from 'vitest';
import { getGregorianCalendar, normalizeCalendar } from '../../common/calendar.js';

describe('normalizeCalendar', () => {
  it('round-trips Gregorian calendars and returns independent copies', () => {
    const gregorian = getGregorianCalendar();
    const normalized = normalizeCalendar(gregorian);
    expect(normalized).toEqual(gregorian);
    normalized.eras[0].name = '바뀐 연호';
    gregorian.months[0].days = 1;
    expect(getGregorianCalendar().eras[0].name).toBe('기원전');
    expect(getGregorianCalendar().months[0].days).toBe(31);
    const defaults = normalizeCalendar({
      version: 1,
      eras: [{ id: 'a', name: ' e\u0301 ', countsDown: false }],
      months: [{ id: 'a', name: ' 첫달 ', days: 1000 }],
    });
    expect(defaults).toEqual({
      version: 1, eras: [{ id: 'a', name: 'é', countsDown: false, startYear: 1 }],
      months: [{ id: 'a', name: '첫달', days: 1000 }], hoursPerDay: 24,
    });
  });

  it.each([
    { version: 2 }, { leapRule: false }, { eras: [] }, { eras: Array(51).fill({}) },
    { months: [] }, { months: Array(101).fill({}) }, { hoursPerDay: 0 }, { hoursPerDay: 101 },
  ])('rejects invalid calendar attributes %j', patch => {
    expect(() => normalizeCalendar({ ...getGregorianCalendar(), ...patch }))
      .toThrow(expect.objectContaining({ code: 'invalid', row: 'calendar' }));
  });

  it.each([
    { id: '__proto__' }, { id: 'jan' }, { id: 'x'.repeat(65) }, { id: 'a b' },
    { name: '' }, { name: 'x'.repeat(101) }, { name: '\nx' }, { name: '\u0000' },
    { name: '\uD800' }, { days: 0 }, { days: 1001 }, { days: 1.5 }, { unknown: true },
  ])('reports an invalid month row %j', patch => {
    const calendar = getGregorianCalendar();
    calendar.months[1] = { ...calendar.months[1], ...patch };
    expect(() => normalizeCalendar(calendar))
      .toThrow(expect.objectContaining({ code: 'invalid', row: 'month', index: 1, detail: expect.any(String) }));
  });

  it('rejects descending-era bounds, inverted bounds and duplicate era IDs', () => {
    const calendar = getGregorianCalendar();
    for (const era of [
      { ...calendar.eras[0], startYear: 1 }, { ...calendar.eras[1], startYear: 3, endYear: 2 },
      { ...calendar.eras[1], id: 'bc' },
    ]) {
      expect(() => normalizeCalendar({ ...calendar, eras: [calendar.eras[0], era] }))
        .toThrow(expect.objectContaining({ code: 'invalid', row: 'era', index: 1 }));
    }
  });

  it('enforces the UTF-8 budget even with individually valid rows', () => {
    const name = '🌏'.repeat(100);
    expect(() => normalizeCalendar({
      version: 1,
      eras: Array.from({ length: 50 }, (_, index) => ({ id: `${index}${'e'.repeat(60)}`, name, countsDown: true })),
      months: Array.from({ length: 100 }, (_, index) => ({ id: `${index}${'m'.repeat(60)}`, name, days: 30 })),
    })).toThrow(expect.objectContaining({ code: 'too_large', row: 'calendar' }));
  });
});
