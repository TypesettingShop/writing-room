// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { getGregorianCalendar, normalizeCalendar, type Calendar } from '../../common/calendar.js';
import { calendarDateKey, compareCalendarDates, orderTimeline, type TimedItem } from '../../common/timeOrder.js';
import type { CalendarDate } from '../../common/timePoint.js';

const gregorian = getGregorianCalendar();

function dated(id: string, createdAt: number, date: CalendarDate): TimedItem {
  return { id, createdAt, when: { kind: 'date', date } };
}

function relative(id: string, createdAt: number, kind: 'before' | 'at' | 'after', anchor: string): TimedItem {
  return { id, createdAt, when: { kind, anchor } };
}

function unset(id: string, createdAt: number): TimedItem {
  return { id, createdAt, when: { kind: 'unset' } };
}

function ids(items: readonly TimedItem[], calendar: Calendar = gregorian): string[] {
  return orderTimeline(items, calendar).map(entry => entry.id);
}

describe('calendar date order', () => {
  it('orders descending years, months within a descending year and the BC/AD boundary', () => {
    const items = [
      dated('early-ad', 1, { era: 'ad', year: 1 }),
      dated('bc-1', 2, { era: 'bc', year: 1, month: 'dec', day: 31, time: { hour: 23, minute: 59 } }),
      dated('bc-100', 3, { era: 'bc', year: 100 }),
      dated('bc-10', 4, { era: 'bc', year: 10 }),
      // Only the year runs backwards: months, days and the partial-date start stay in calendar order.
      dated('bc-50-apr', 5, { era: 'bc', year: 50, month: 'apr', day: 1 }),
      dated('bc-50-mar', 6, { era: 'bc', year: 50, month: 'mar' }),
      dated('bc-50', 7, { era: 'bc', year: 50 }),
    ];
    expect(ids(items)).toEqual(['bc-100', 'bc-50', 'bc-50-mar', 'bc-50-apr', 'bc-10', 'bc-1', 'early-ad']);
    expect(calendarDateKey(gregorian, { era: 'bc', year: 100 })).toEqual([0, -100, -1, 0, -1]);
    expect(compareCalendarDates(gregorian, { era: 'bc', year: 1 }, { era: 'ad', year: 1 })).toBeLessThan(0);
    expect(compareCalendarDates(gregorian, { era: 'bc', year: 0 }, { era: 'ad', year: 1 })).toBeUndefined();
  });

  it('orders eras before their year numbers and compares partial dates lexicographically', () => {
    const calendar = normalizeCalendar({
      version: 1,
      eras: [
        { id: 'empire', name: '제국력', countsDown: false, endYear: 302 },
        { id: 'republic', name: '공화력', countsDown: false },
      ],
      months: [
        { id: 'short', name: '초월', days: 30 },
        { id: 'long', name: '긴달', days: 31 },
        { id: 'last', name: '말월', days: 29 },
      ],
    });
    const end = { era: 'empire', year: 302 };
    const items = [
      dated('next-era', 1, { era: 'republic', year: 1 }),
      dated('last-month', 2, { ...end, month: 'last', day: 1 }),
      dated('long-month-end', 3, { ...end, month: 'long', day: 31 }),
      dated('short-month-end', 4, { ...end, month: 'short', day: 30 }),
      dated('same-day-nine', 5, { ...end, month: 'short', day: 1, time: { hour: 9, minute: 0 } }),
      dated('day-only', 6, { ...end, month: 'short', day: 1 }),
      dated('month-only', 7, { ...end, month: 'short' }),
      dated('year-only', 8, end),
      // Created first, so a missing time read as 00:00 would tie and put this before the day-only date.
      dated('midnight', 0, { ...end, month: 'short', day: 1, time: { hour: 0, minute: 0 } }),
    ];
    expect(ids(items, calendar)).toEqual([
      'year-only', 'month-only', 'day-only', 'midnight', 'same-day-nine',
      'short-month-end', 'long-month-end', 'last-month', 'next-era',
    ]);
    expect(calendarDateKey(calendar, { ...end, month: 'short', day: 1, time: { hour: 9, minute: 15 } }))
      .toEqual([0, 302, 0, 1, 555]);
    expect(calendarDateKey(calendar, { ...end, year: 303 })).toBeUndefined();
    expect(compareCalendarDates(calendar, end, { ...end })).toBe(0);
  });

  it('breaks equal date ties by creation time and then by code-point ID order', () => {
    const day = { era: 'ad', year: 2024, month: 'feb', day: 29 };
    expect(ids([dated('a', 3, day), dated('z', 2, day), dated('A', 3, day), dated('X', 1, day)]))
      .toEqual(['X', 'z', 'A', 'a']);
  });
});

describe('timeline order', () => {
  const rootDate = { era: 'ad', year: 2024, month: 'mar', day: 5 };
  const example: TimedItem[] = [
    dated('E1', 1, rootDate),
    relative('E2', 2, 'after', 'E1'),
    relative('E3', 3, 'before', 'E1'),
    relative('E4', 4, 'after', 'E1'),
    relative('E5', 5, 'after', 'E2'),
    dated('E6', 6, { era: 'ad', year: 2024 }),
    dated('E7', 7, { era: 'bc', year: 50 }),
    unset('E8', 8),
    relative('E9', 9, 'after', 'E8'),
    dated('E10', 10, { ...rootDate, month: 'removed' }),
    relative('E11', 11, 'after', 'E12'),
    relative('E12', 12, 'after', 'E11'),
    relative('E13', 13, 'after', 'missing'),
  ];

  it('orders the documented example, keeps each ID once and annotates the root of each block', () => {
    const result = orderTimeline(example, gregorian);
    expect(result.map(entry => entry.id)).toEqual([
      'E7', 'E6', 'E3', 'E1', 'E2', 'E5', 'E4', 'E10', 'E8', 'E9', 'E11', 'E12', 'E13',
    ]);
    expect(result.map(entry => entry.rank)).toEqual(example.map((_, index) => index));
    expect(result.slice(2, 7).map(({ rootId, rootDate }) => ({ rootId, rootDate })))
      .toEqual(Array.from({ length: 5 }, () => ({ rootId: 'E1', rootDate })));
    expect(result.slice(2, 7).map(entry => entry.relative)).toEqual([true, false, true, true, true]);
    expect(result.slice(7)).toEqual([
      { id: 'E10', rank: 7, group: 'needsReview', rootId: 'E10', relative: false },
      { id: 'E8', rank: 8, group: 'undated', rootId: 'E8', relative: false },
      { id: 'E9', rank: 9, group: 'undated', rootId: 'E8', relative: true },
      ...['E11', 'E12', 'E13'].map((id, index) => ({ id, rank: 10 + index, group: 'broken', relative: false })),
    ]);
  });

  it('keeps edits to the output root date and time separate from the input', () => {
    const input = { ...rootDate, time: { hour: 9, minute: 15 } };
    const items = [dated('root', 1, input), relative('child', 2, 'after', 'root')];
    const result = orderTimeline(items, gregorian);
    expect(result[1].rootDate).toEqual(input);
    result[1].rootDate!.year = 2030;
    result[1].rootDate!.time!.minute = 45;
    expect(input).toEqual({ ...rootDate, time: { hour: 9, minute: 15 } });
    expect(orderTimeline(items, gregorian)[0].rootDate).toEqual(input);
  });

  it('emits before, anchor, same-time and after blocks with ties resolved within each list', () => {
    const items = [
      dated('root', 0, rootDate),
      relative('before-late', 10, 'before', 'root'),
      relative('before-A', 4, 'before', 'root'),
      relative('before-B', 4, 'before', 'root'),
      relative('at-end', 20, 'at', 'root'),
      relative('at-first', 15, 'at', 'root'),
      relative('at-first-before', 30, 'before', 'at-first'),
      relative('before-A-after', 40, 'after', 'before-A'),
      relative('after-late', 50, 'after', 'root'),
      relative('after-first', 8, 'after', 'root'),
      relative('after-first-child', 60, 'after', 'after-first'),
    ];
    expect(ids(items)).toEqual([
      'before-A', 'before-A-after', 'before-B', 'before-late', 'root',
      'at-first-before', 'at-first', 'at-end', 'after-first', 'after-first-child', 'after-late',
    ]);
  });

  it('puts cycles, descendants of cycles, self-anchors and missing-anchor chains in creation order', () => {
    const items = [
      relative('descendant-B', 2, 'after', 'descendant-A'),
      relative('in-cycle-A', 4, 'at', 'in-cycle-B'),
      relative('descendant-A', 2, 'before', 'in-cycle-A'),
      relative('in-cycle-B', 3, 'before', 'in-cycle-A'),
      relative('self', 1, 'after', 'self'),
      relative('missing', 5, 'after', 'gone'),
      relative('missing-descendant', 0, 'at', 'missing'),
      unset('root', 100),
    ];
    const result = orderTimeline(items, gregorian);
    expect(result.map(entry => entry.id)).toEqual([
      'root', 'missing-descendant', 'self', 'descendant-A', 'descendant-B', 'in-cycle-B', 'in-cycle-A', 'missing',
    ]);
    expect(result.slice(1).every(entry => entry.group === 'broken' && !entry.relative && entry.rootId === undefined))
      .toBe(true);
  });

  it('orders review and undated roots by creation time and then ID, not by stored date or ID alone', () => {
    const items = [
      dated('review-a', 3, { era: 'ad', year: 1, month: 'gone' }),
      dated('review-z', 1, { era: 'ad', year: 9, month: 'gone' }),
      dated('review-m', 3, { era: 'gone', year: 5 }),
      unset('undated-a', 6),
      unset('undated-z', 4),
      unset('undated-B', 6),
    ];
    expect(orderTimeline(items, gregorian).map(({ id, group }) => [id, group])).toEqual([
      ['review-z', 'needsReview'], ['review-a', 'needsReview'], ['review-m', 'needsReview'],
      ['undated-z', 'undated'], ['undated-B', 'undated'], ['undated-a', 'undated'],
    ]);
  });

  it('keeps the first record for duplicate IDs', () => {
    expect(orderTimeline([unset('duplicate', 1), dated('duplicate', 0, rootDate)], gregorian)).toEqual([
      { id: 'duplicate', rank: 0, group: 'undated', rootId: 'duplicate', relative: false },
    ]);
  });

  it('returns identical entries after seeded shuffles of unique input IDs', () => {
    const items = [
      ...example, dated('tie-z', 1, rootDate), dated('tie-A', 1, rootDate), relative('tie-child', 2, 'after', 'E1'),
      dated('invalid-earlier', 0, { era: 'removed', year: 7 }), unset('undated-earlier', 0),
    ];
    const expected = orderTimeline(items, gregorian);
    let seed = 123456789;
    for (let repetition = 0; repetition < 30; repetition++) {
      const shuffled = [...items];
      for (let index = shuffled.length - 1; index > 0; index--) {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        const other = seed % (index + 1);
        [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
      }
      expect(orderTimeline(shuffled, gregorian)).toEqual(expected);
    }
  });

  it('recomputes groups and order after editing the calendar while preserving input dates', () => {
    const items = [
      dated('early-year', 1, { era: 'ad', year: 1 }),
      dated('last-of-april', 2, { era: 'ad', year: 2, month: 'apr', day: 30 }),
      dated('last-of-march', 3, { era: 'ad', year: 2, month: 'mar', day: 31 }),
      relative('march-child', 4, 'after', 'last-of-march'),
      dated('late-at-night', 5, { era: 'ad', year: 2, month: 'apr', day: 15, time: { hour: 21, minute: 0 } }),
    ];
    const saved = structuredClone(items);
    const calendar = getGregorianCalendar();
    const before = orderTimeline(items, calendar);
    const march = calendar.months[2];
    calendar.months[2] = { ...march, name: '새 이름' };
    expect(orderTimeline(items, calendar)).toEqual(before);
    [calendar.months[2], calendar.months[3]] = [calendar.months[3], calendar.months[2]];
    expect(ids(items, calendar)).toEqual(['early-year', 'late-at-night', 'last-of-april', 'last-of-march', 'march-child']);
    calendar.months = calendar.months.filter(month => month.id !== 'mar');
    const removed = orderTimeline(items, calendar);
    expect(removed.slice(-2)).toEqual([
      { id: 'last-of-march', rank: 3, group: 'needsReview', rootId: 'last-of-march', relative: false },
      { id: 'march-child', rank: 4, group: 'needsReview', rootId: 'last-of-march', relative: true },
    ]);
    calendar.months.splice(2, 0, march);
    expect(orderTimeline(items, calendar)).toEqual(before);

    calendar.months[2].days = 30;
    calendar.hoursPerDay = 20;
    expect(orderTimeline(items, calendar).filter(entry => entry.group === 'needsReview').map(entry => entry.id))
      .toEqual(['last-of-march', 'march-child', 'late-at-night']);
    expect(orderTimeline(items, { ...calendar, eras: [calendar.eras[0]] }).every(entry => entry.group === 'needsReview'))
      .toBe(true);
    expect(items).toEqual(saved);
  });

  it('recomputes era positions, descending years and changed start and end years', () => {
    const items = [
      dated('bc', 0, { era: 'bc', year: 1 }),
      dated('ad-1', 1, { era: 'ad', year: 1 }),
      dated('ad-2', 2, { era: 'ad', year: 2 }),
      dated('ad-3', 3, { era: 'ad', year: 3 }),
    ];
    const calendar = getGregorianCalendar();
    [calendar.eras[0], calendar.eras[1]] = [calendar.eras[1], calendar.eras[0]];
    expect(ids(items, calendar)).toEqual(['ad-1', 'ad-2', 'ad-3', 'bc']);
    calendar.eras[0] = { id: 'ad', name: '서기', countsDown: true };
    expect(ids(items, calendar)).toEqual(['ad-3', 'ad-2', 'ad-1', 'bc']);
    calendar.eras[0] = { id: 'ad', name: '서기', countsDown: false, startYear: 2, endYear: 2 };
    expect(orderTimeline(items, calendar).map(({ id, group }) => [id, group]))
      .toEqual([['ad-2', 'dated'], ['bc', 'dated'], ['ad-1', 'needsReview'], ['ad-3', 'needsReview']]);
  });

  it('uses bounded call depth and finishes a mixed 30,000-record timeline within a second', () => {
    const size = 10_000;
    const items: TimedItem[] = [dated('root', 0, rootDate)];
    for (let index = 1; index <= size; index++) {
      items.push(relative('after-' + index, index, 'after', index === 1 ? 'root' : 'after-' + (index - 1)));
      items.push(relative('before-' + index, index, 'before', index === 1 ? 'root' : 'before-' + (index - 1)));
      items.push(relative('broken-' + index, index, 'after', 'broken-' + (index - 1)));
    }
    const startedAt = performance.now();
    const result = orderTimeline(items.reverse(), gregorian);
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeLessThan(1_000);
    expect(result).toHaveLength(30_001);
    expect(result[0].id).toBe('before-10000');
    expect(result[size].id).toBe('root');
    expect(result[size * 2].id).toBe('after-10000');
    expect(result.at(-1)).toEqual({ id: 'broken-10000', rank: 30_000, group: 'broken', relative: false });
  });
});
