import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { Calendar } from '../../../../platform/world/common/calendar.js';

export interface CalendarUsageSource {
  readonly label: string;
  /** Count dates valid in saved whose checkCalendarDate result fails in draft. */
  countAffected(workId: string, saved: Calendar, draft: Calendar): Promise<number>;
}

const sources = new Set<CalendarUsageSource>();

export function registerCalendarUsageSource(source: CalendarUsageSource): IDisposable {
  // Each registration owns its own lifetime, even if the provider is registered twice.
  const entry: CalendarUsageSource = {
    label: source.label,
    countAffected: (workId, saved, draft) => source.countAffected(workId, saved, draft),
  };
  sources.add(entry);
  return toDisposable(() => sources.delete(entry));
}

export function countCalendarImpact(
  workId: string, saved: Calendar, draft: Calendar,
): Promise<readonly { label: string; count: number }[]> {
  return Promise.all([...sources].map(async source => {
    const count = await source.countAffected(workId, saved, draft);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid calendar impact count.');
    }
    return { label: source.label, count };
  }));
}
