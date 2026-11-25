import type { Calendar } from './calendar.js';
import type { CalendarDate } from './timePoint.js';

export function formatCalendarDate(calendar: Calendar, date: CalendarDate): string {
  const era = calendar.eras.find(entry => entry.id === date.era);
  const month = calendar.months.find(entry => entry.id === date.month);
  const parts = [];
  if (!era || (date.month !== undefined && !month)) {
    parts.push('(확인 필요)');
  }
  parts.push(era?.name ?? date.era, `${date.year}년`);
  if (date.month !== undefined) {
    parts.push(month?.name ?? date.month);
  }
  if (date.day !== undefined) {
    parts.push(`${date.day}일`);
  }
  if (date.time) {
    const hour = String(date.time.hour).padStart(2, '0');
    const minute = String(date.time.minute).padStart(2, '0');
    parts.push(`${hour}:${minute}`);
  }
  return parts.join(' ');
}
