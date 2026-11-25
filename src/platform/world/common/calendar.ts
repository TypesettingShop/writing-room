import { isCharacterFieldId } from '../../characters/common/characterFields.js';
import { utf8Size } from '../../manuscript/common/manuscript.js';
import { WorldStoreError } from './world.js';

export type CalendarEra = { id: string; name: string } & (
  | { countsDown: true; startYear?: never; endYear?: never }
  | { countsDown: false; startYear?: number; endYear?: number }
);

export interface CalendarMonth {
  id: string;
  name: string;
  days: number;
}

export interface Calendar {
  version: 1;
  eras: CalendarEra[];
  months: CalendarMonth[];
  hoursPerDay: number;
}

export const calendarLimits = {
  eras: 50,
  months: 100,
  name: 100,
  days: 1_000,
  hoursPerDay: 100,
  year: 1_000_000_000,
  bytes: 64 * 1024,
} as const;

export class CalendarValidationError extends WorldStoreError {
  constructor(
    readonly detail: string,
    readonly row: 'era' | 'month' | 'calendar',
    readonly index?: number,
    code: 'invalid' | 'too_large' = 'invalid',
  ) {
    super(code);
    this.name = 'CalendarValidationError';
  }
}

export function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object Object]' &&
    Object.keys(value).every(key => keys.includes(key));
}

export function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// Names follow the title rule: one line without control characters (VT, FF and NEL also break lines).
const invalidName = /[\x00-\x1f\x7f-\x9f\u2028\u2029\uD800-\uDFFF]/u;

function normalizeName(value: unknown, row: 'era' | 'month', index: number): string {
  if (typeof value !== 'string' || invalidName.test(value)) {
    throw new CalendarValidationError('The name must be valid single-line text.', row, index);
  }
  const name = value.trim().normalize('NFC');
  if (!name || [...name].length > calendarLimits.name) {
    throw new CalendarValidationError('The name must have between 1 and 100 characters.', row, index);
  }
  return name;
}

function normalizeEra(value: unknown, index: number): CalendarEra {
  if (!hasOnlyKeys(value, ['id', 'name', 'countsDown', 'startYear', 'endYear']) ||
    !isCharacterFieldId(value.id) || typeof value.countsDown !== 'boolean') {
    throw new CalendarValidationError('Invalid era definition.', 'era', index);
  }
  const { id, countsDown, endYear } = value;
  const name = normalizeName(value.name, 'era', index);
  if (countsDown) {
    // An undefined key is absent, as it is after the JSON round trip of the HTTP store.
    if (value.startYear !== undefined || endYear !== undefined) {
      throw new CalendarValidationError('A descending era has no start or end year.', 'era', index);
    }
    return { id, name, countsDown };
  }
  const startYear = value.startYear === undefined ? 1 : value.startYear;
  if (!integerInRange(startYear, -calendarLimits.year, calendarLimits.year) ||
    (endYear !== undefined && !integerInRange(endYear, startYear, calendarLimits.year))) {
    throw new CalendarValidationError('Invalid era year range.', 'era', index);
  }
  return endYear === undefined ? { id, name, countsDown, startYear } : { id, name, countsDown, startYear, endYear };
}

function normalizeMonth(value: unknown, index: number): CalendarMonth {
  if (!hasOnlyKeys(value, ['id', 'name', 'days']) || !isCharacterFieldId(value.id) ||
    !integerInRange(value.days, 1, calendarLimits.days)) {
    throw new CalendarValidationError('Invalid month definition.', 'month', index);
  }
  return { id: value.id, name: normalizeName(value.name, 'month', index), days: value.days };
}

function normalizeRows<T extends { id: string }>(
  value: unknown, row: 'era' | 'month', max: number, normalize: (value: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new CalendarValidationError(`The calendar must have between 1 and ${max} ${row}s.`, 'calendar');
  }
  const ids = new Set<string>();
  return Array.from(value, (entry, index) => {
    const normalized = normalize(entry, index);
    if (ids.has(normalized.id)) {
      throw new CalendarValidationError('IDs must be unique within this list.', row, index);
    }
    ids.add(normalized.id);
    return normalized;
  });
}

export function normalizeCalendar(value: unknown): Calendar {
  if (!hasOnlyKeys(value, ['version', 'eras', 'months', 'hoursPerDay']) || value.version !== 1) {
    throw new CalendarValidationError('Invalid calendar format or version.', 'calendar');
  }
  const hoursPerDay = value.hoursPerDay === undefined ? 24 : value.hoursPerDay;
  if (!integerInRange(hoursPerDay, 1, calendarLimits.hoursPerDay)) {
    throw new CalendarValidationError('A day must contain between 1 and 100 hours.', 'calendar');
  }
  const calendar: Calendar = {
    version: 1,
    eras: normalizeRows(value.eras, 'era', calendarLimits.eras, normalizeEra),
    months: normalizeRows(value.months, 'month', calendarLimits.months, normalizeMonth),
    hoursPerDay,
  };
  if (utf8Size(JSON.stringify(calendar)) > calendarLimits.bytes) {
    throw new CalendarValidationError('The calendar exceeds 64 KiB.', 'calendar', undefined, 'too_large');
  }
  return calendar;
}

export function getGregorianCalendar(): Calendar {
  const ids = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // Until leap-year rules exist, February accepts the 29th in every year.
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return {
    version: 1,
    eras: [
      { id: 'bc', name: '기원전', countsDown: true },
      { id: 'ad', name: '서기', countsDown: false, startYear: 1 },
    ],
    months: ids.map((id, index) => ({ id, name: `${index + 1}월`, days: days[index] })),
    hoursPerDay: 24,
  };
}
