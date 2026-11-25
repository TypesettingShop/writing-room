import { expect, it } from 'vitest';
import { getGregorianCalendar, type Calendar } from '../../common/calendar.js';
import { formatCalendarDate } from '../../common/calendarFormat.js';

it('prints Korean dates at each precision and retains missing IDs', () => {
  const calendar = getGregorianCalendar();
  expect(formatCalendarDate(calendar, { era: 'ad', year: 2024, month: 'feb', day: 29, time: { hour: 14, minute: 30 } }))
    .toBe('서기 2024년 2월 29일 14:30');
  expect(formatCalendarDate(calendar, { era: 'ad', year: 2024, month: 'feb', day: 3, time: { hour: 7, minute: 5 } }))
    .toBe('서기 2024년 2월 3일 07:05');
  expect(formatCalendarDate(calendar, { era: 'bc', year: 50, month: 'mar' })).toBe('기원전 50년 3월');
  expect(formatCalendarDate(calendar, { era: 'old', year: 302, month: 'lost' })).toBe('(확인 필요) old 302년 lost');
  expect(formatCalendarDate(calendar, { era: 'ad', year: 10, month: 'lost' })).toBe('(확인 필요) 서기 10년 lost');
  const imperial: Calendar = { ...calendar, eras: [{ id: 'imperial', name: '제국력', countsDown: false, startYear: 1 }] };
  expect(formatCalendarDate(imperial, { era: 'imperial', year: 302 })).toBe('제국력 302년');
});
