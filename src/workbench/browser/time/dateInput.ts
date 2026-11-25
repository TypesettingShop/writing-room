import { addDisposableListener } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isCharacterFieldId } from '../../../platform/characters/common/characterFields.js';
import { calendarLimits, integerInRange, type Calendar } from '../../../platform/world/common/calendar.js';
import { checkCalendarDate, normalizeCalendarDate, type CalendarDate } from '../../../platform/world/common/timePoint.js';
import { parseIntegerInput } from './integerInput.js';

type DateField = 'era' | 'year' | 'month' | 'day' | 'hour' | 'minute';
let nextId = 0;

interface DateControl<T> {
  readonly input: T;
  readonly problem: HTMLElement;
}

/** A partial date editor. Calendar mismatches warn while structural errors withhold change events. */
export class DateInput extends Disposable {
  readonly element: HTMLDivElement;
  private readonly changed = this._register(new Emitter<CalendarDate | undefined>());
  readonly onDidChange = this.changed.event;
  private readonly controls: {
    [K in DateField]: DateControl<K extends 'era' | 'month' ? HTMLSelectElement : HTMLInputElement>;
  };
  private readonly warning: HTMLElement;
  private readonly composing = new Set<DateField>();
  private emitting = false;
  private current?: CalendarDate;

  constructor(private readonly document: Document, private calendar: Calendar) {
    super();
    this.element = document.createElement('div');
    this.element.className = 'calendar-date-input';
    const fields = this.element.appendChild(document.createElement('div'));
    fields.className = 'calendar-date-fields';
    this.controls = {
      era: this.createControl(fields, 'era', 'Era', 'select'),
      year: this.createControl(fields, 'year', 'Year', 'input'),
      month: this.createControl(fields, 'month', 'Month', 'select'),
      day: this.createControl(fields, 'day', 'Day', 'input'),
      hour: this.createControl(fields, 'hour', 'Hour', 'input'),
      minute: this.createControl(fields, 'minute', 'Minute', 'input'),
    };
    this.warning = this.element.appendChild(document.createElement('p'));
    this.warning.setAttribute('role', 'status');
    this.warning.className = 'calendar-problem';
    this.setValue(undefined);
  }

  setCalendar(calendar: Calendar): void {
    this.calendar = calendar;
    this.setChoices(this.controls.era.input, calendar.eras, this.controls.era.input.value);
    this.setChoices(this.controls.month.input, calendar.months, this.controls.month.input.value);
    this.updateWarning();
  }

  setValue(value: CalendarDate | undefined): void {
    if (this.composing.size) {
      return;
    }
    if (this.emitting && JSON.stringify(value) === JSON.stringify(this.current)) {
      return;
    }
    const { era, year, month, day, hour, minute } = this.controls;
    this.current = value;
    this.setChoices(era.input, this.calendar.eras, value?.era ?? '');
    this.setChoices(month.input, this.calendar.months, value?.month ?? '');
    year.input.value = String(value?.year ?? '');
    day.input.value = String(value?.day ?? '');
    hour.input.value = String(value?.time?.hour ?? '');
    minute.input.value = String(value?.time?.minute ?? '');
    this.updateDisabled();
    this.clearProblems();
    this.updateWarning();
  }

  private createControl<K extends 'input' | 'select'>(
    parent: HTMLElement, field: DateField, label: string, tag: K,
  ): DateControl<HTMLElementTagNameMap[K]> {
    const wrapper = parent.appendChild(this.document.createElement('div'));
    const caption = wrapper.appendChild(this.document.createElement('label'));
    const input = wrapper.appendChild(this.document.createElement(tag));
    const problem = wrapper.appendChild(this.document.createElement('span'));
    problem.className = 'calendar-problem';
    problem.hidden = true;
    input.id = `calendar-date-${++nextId}`;
    problem.id = input.id + '-problem';
    input.setAttribute('aria-describedby', problem.id);
    caption.htmlFor = input.id;
    caption.textContent = label;
    if (tag === 'input') {
      const text = input as HTMLInputElement;
      text.inputMode = 'numeric';
      text.placeholder = '—';
      this._register(addDisposableListener(text, 'compositionstart', () => this.composing.add(field)));
      this._register(addDisposableListener(text, 'compositionend', () => {
        this.composing.delete(field);
        this.edit(field);
      }));
    }
    this._register(addDisposableListener(input, tag === 'input' ? 'input' : 'change', () => this.edit(field)));
    return { input, problem };
  }

  private setChoices(
    select: HTMLSelectElement, rows: readonly { id: string; name: string }[], selected: string,
  ): void {
    const options = [{ id: '', name: '—' }, ...rows];
    if (selected && !rows.some(row => row.id === selected)) {
      options.push({ id: selected, name: `${selected} (Not in calendar)` });
    }
    if (select.options.length !== options.length || options.some((option, i) =>
      select.options[i].value !== option.id || select.options[i].text !== option.name)) {
      select.replaceChildren(...options.map(({ id, name }) => {
        const option = this.document.createElement('option');
        option.value = id;
        option.textContent = name;
        return option;
      }));
    }
    select.value = selected;
  }

  private updateDisabled(): void {
    const { month, day, hour, minute } = this.controls;
    day.input.disabled = !month.input.value;
    hour.input.disabled = minute.input.disabled = day.input.disabled || parseIntegerInput(day.input.value) === undefined;
  }

  private clearProblems(): void {
    for (const field of Object.keys(this.controls) as DateField[]) {
      this.problem(field, '');
    }
  }

  private problem(field: DateField, message: string): void {
    const { input, problem } = this.controls[field];
    if (problem.textContent !== message) {
      problem.textContent = message;
    }
    problem.hidden = !message;
    input.setAttribute('aria-invalid', String(!!message));
  }

  private edit(field: DateField): void {
    if (this.composing.size) {
      return;
    }
    const { era, year, month, day, hour, minute } = this.controls;
    if (field === 'era' && !era.input.value) {
      this.setValue(undefined);
      this.emit(undefined);
      return;
    }
    if (field === 'month' && !month.input.value) {
      day.input.value = '';
    }
    if ((field === 'month' || field === 'day') && !day.input.value.trim()) {
      hour.input.value = minute.input.value = '';
    }
    this.updateDisabled();
    this.clearProblems();
    const raw = {
      era: era.input.value,
      year: parseIntegerInput(year.input.value),
      month: month.input.value || undefined,
      day: parseIntegerInput(day.input.value),
      time: hour.input.value.trim() || minute.input.value.trim()
        ? { hour: parseIntegerInput(hour.input.value), minute: parseIntegerInput(minute.input.value) }
        : undefined,
    };
    let date: CalendarDate;
    try {
      date = normalizeCalendarDate(raw);
    } catch {
      if (!isCharacterFieldId(raw.era)) {
        this.problem('era', 'Choose an era.');
      }
      if (!integerInRange(raw.year, -calendarLimits.year, calendarLimits.year)) {
        this.problem('year', 'Enter a whole year within the supported range.');
      }
      if (raw.month !== undefined && !isCharacterFieldId(raw.month)) {
        this.problem('month', 'Choose a month.');
      }
      if (raw.day !== undefined && (!raw.month || !integerInRange(raw.day, 1, calendarLimits.days))) {
        this.problem('day', 'Enter a whole day between 1 and 1,000.');
      }
      if (raw.time) {
        if (raw.day === undefined || !integerInRange(raw.time.hour, 0, calendarLimits.hoursPerDay - 1)) {
          this.problem('hour', 'Enter a whole hour between 0 and 99.');
        }
        if (raw.day === undefined || !integerInRange(raw.time.minute, 0, 59)) {
          this.problem('minute', 'Enter a whole minute between 0 and 59.');
        }
      }
      this.updateWarning();
      return;
    }
    this.current = date;
    this.updateWarning();
    this.emit(date);
  }

  private emit(date: CalendarDate | undefined): void {
    this.emitting = true;
    try {
      this.changed.fire(date);
    } finally {
      this.emitting = false;
    }
  }

  private updateWarning(): void {
    const result = this.current && checkCalendarDate(this.calendar, this.current);
    let message = '';
    if (result && !result.ok) {
      switch (result.reason) {
        case 'era': message = 'This era is not in the calendar.'; break;
        case 'year': message = 'This year is outside the era’s year range.'; break;
        case 'month': message = 'This month is not in the calendar.'; break;
        case 'day': {
          const days = this.calendar.months.find(month => month.id === this.current?.month)?.days;
          message = Number.isFinite(days) ? `This month has ${days} days.` : 'This month has an invalid day count.';
          break;
        }
        case 'time': message = 'This time is outside the calendar’s day.'; break;
      }
    }
    if (this.warning.textContent !== message) {
      this.warning.textContent = message;
    }
    this.warning.hidden = !message;
  }

  override dispose(): void {
    this.element.remove();
    super.dispose();
  }
}
