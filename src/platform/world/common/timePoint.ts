import { isCharacterFieldId } from '../../characters/common/characterFields.js';
import { isManuscriptId } from '../../manuscript/common/manuscript.js';
import { calendarLimits, hasOnlyKeys, integerInRange, type Calendar } from './calendar.js';
import { WorldStoreError } from './world.js';

export interface CalendarDate {
  era: string;
  year: number;
  month?: string;
  day?: number;
  time?: { hour: number; minute: number };
}

export type TimePoint =
  | { kind: 'date'; date: CalendarDate }
  | { kind: 'after' | 'before' | 'at'; anchor: string }
  | { kind: 'unset' };

export function normalizeCalendarDate(value: unknown): CalendarDate {
  if (!hasOnlyKeys(value, ['era', 'year', 'month', 'day', 'time']) || !isCharacterFieldId(value.era) ||
    !integerInRange(value.year, -calendarLimits.year, calendarLimits.year)) {
    throw new WorldStoreError('invalid');
  }
  const date: CalendarDate = { era: value.era, year: value.year };
  if (value.month !== undefined) {
    if (!isCharacterFieldId(value.month)) {
      throw new WorldStoreError('invalid');
    }
    date.month = value.month;
  }
  if (value.day !== undefined) {
    if (date.month === undefined || !integerInRange(value.day, 1, calendarLimits.days)) {
      throw new WorldStoreError('invalid');
    }
    date.day = value.day;
  }
  if (value.time !== undefined) {
    if (date.day === undefined || !hasOnlyKeys(value.time, ['hour', 'minute']) ||
      !integerInRange(value.time.hour, 0, calendarLimits.hoursPerDay - 1) ||
      !integerInRange(value.time.minute, 0, 59)) {
      throw new WorldStoreError('invalid');
    }
    date.time = { hour: value.time.hour, minute: value.time.minute };
  }
  return date;
}

export function normalizeTimePoint(value: unknown): TimePoint {
  if (hasOnlyKeys(value, ['kind', 'date']) && value.kind === 'date') {
    return { kind: 'date', date: normalizeCalendarDate(value.date) };
  }
  if (hasOnlyKeys(value, ['kind', 'anchor']) &&
    (value.kind === 'after' || value.kind === 'before' || value.kind === 'at') &&
    isManuscriptId(value.anchor)) {
    return { kind: value.kind, anchor: value.anchor };
  }
  if (hasOnlyKeys(value, ['kind']) && value.kind === 'unset') {
    return { kind: 'unset' };
  }
  throw new WorldStoreError('invalid');
}

export type CalendarDateCheck =
  | { ok: true }
  | { ok: false; reason: 'era' | 'year' | 'month' | 'day' | 'time' };

export function checkCalendarDate(calendar: Calendar, date: CalendarDate): CalendarDateCheck {
  const era = calendar.eras.find(era => era.id === date.era);
  if (!era) {
    return { ok: false, reason: 'era' };
  }
  const minYear = era.countsDown ? 1 : era.startYear ?? 1;
  if (!integerInRange(date.year, minYear, era.endYear ?? calendarLimits.year)) {
    return { ok: false, reason: 'year' };
  }
  const month = calendar.months.find(month => month.id === date.month);
  if (date.month !== undefined && !month) {
    return { ok: false, reason: 'month' };
  }
  if (date.day !== undefined && (!month || !integerInRange(date.day, 1, month.days))) {
    return { ok: false, reason: 'day' };
  }
  if (date.time !== undefined && (date.day === undefined ||
    !integerInRange(date.time.hour, 0, calendar.hoursPerDay - 1) ||
    !integerInRange(date.time.minute, 0, 59))) {
    return { ok: false, reason: 'time' };
  }
  return { ok: true };
}
