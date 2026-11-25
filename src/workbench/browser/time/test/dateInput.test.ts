import { expect, it } from 'vitest';
import { getGregorianCalendar } from '../../../../platform/world/common/calendar.js';
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

it('keeps the select options while a draft name still holds spaces', () => {
  const calendar = getGregorianCalendar();
  const spaced = { ...calendar, eras: [{ id: 'ad', name: '새  서기 ', countsDown: false as const, startYear: 1 }] };
  const input = new DateInput(document, spaced);
  const era = control<HTMLSelectElement>(input, 'Era');
  const option = era.options[1];
  input.setCalendar({ ...spaced });
  expect(era.options[1]).toBe(option);
  expect(option.textContent).toBe('새  서기 ');
  input.dispose();
});
