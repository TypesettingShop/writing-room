import { expect, it } from 'vitest';
import { getGregorianCalendar } from '../../../../platform/world/common/calendar.js';
import { formatCalendarDate } from '../../../../platform/world/common/calendarFormat.js';
import type { CalendarDate } from '../../../../platform/world/common/timePoint.js';
import { DateInput } from '../dateInput.js';

function control<T extends HTMLInputElement | HTMLSelectElement>(input: DateInput, label: string): T {
  const caption = [...input.element.querySelectorAll('label')].find(node => node.textContent === label);
  return input.element.querySelector<T>('#' + caption!.htmlFor)!;
}

function enter(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

it('prints Korean dates at each precision and retains missing IDs', () => {
  const calendar = getGregorianCalendar();
  expect(formatCalendarDate(calendar, { era: 'ad', year: 2024, month: 'feb', day: 29, time: { hour: 14, minute: 30 } }))
    .toBe('서기 2024년 2월 29일 14:30');
  expect(formatCalendarDate(calendar, { era: 'bc', year: 50, month: 'mar' })).toBe('기원전 50년 3월');
  expect(formatCalendarDate(calendar, { era: 'ad', year: 302 })).toBe('서기 302년');
  expect(formatCalendarDate(calendar, { era: 'old', year: 302, month: 'lost' })).toBe('(확인 필요) old 302년 lost');
});

it('preserves absent choices and emits only after composition and structural validation', () => {
  const calendar = getGregorianCalendar();
  const input = new DateInput(document, calendar);
  const changes: (CalendarDate | undefined)[] = [];
  input.onDidChange(date => changes.push(date));
  input.setValue({ era: 'ad', year: 10, month: 'lost', day: 31 });
  const year = control<HTMLInputElement>(input, 'Year');
  const month = control<HTMLSelectElement>(input, 'Month');
  expect(month.selectedOptions[0].text).toBe('lost (Not in calendar)');
  expect(input.element.textContent).toContain('This month is not in the calendar.');
  year.dispatchEvent(new CompositionEvent('compositionstart'));
  enter(year, '３０２');
  input.setCalendar({ ...calendar, eras: calendar.eras.filter(era => era.id !== 'ad') });
  expect(year.value).toBe('３０２');
  expect(changes).toEqual([]);
  year.dispatchEvent(new CompositionEvent('compositionend'));
  expect(changes).toEqual([{ era: 'ad', year: 302, month: 'lost', day: 31 }]);
  expect(control<HTMLSelectElement>(input, 'Era').value).toBe('ad');
  enter(year, '1.5');
  expect(year.getAttribute('aria-invalid')).toBe('true');
  expect(changes).toHaveLength(1);
  input.dispose();
});

it('warns on a short month and clears dependent precision only when edited', () => {
  const input = new DateInput(document, getGregorianCalendar());
  const changes: (CalendarDate | undefined)[] = [];
  input.onDidChange(date => changes.push(date));
  input.setValue({ era: 'ad', year: 10, month: 'apr', day: 31, time: { hour: 0, minute: 0 } });
  expect(input.element.textContent).toContain('This month has 30 days.');
  const month = control<HTMLSelectElement>(input, 'Month');
  month.value = '';
  month.dispatchEvent(new Event('change'));
  expect(changes).toEqual([{ era: 'ad', year: 10 }]);
  expect(control<HTMLInputElement>(input, 'Day').disabled).toBe(true);
  expect(control<HTMLInputElement>(input, 'Hour').disabled).toBe(true);
  input.dispose();
});
