import type { Calendar } from './calendar.js';
import { checkCalendarDate, type CalendarDate, type TimePoint } from './timePoint.js';

export interface TimedItem {
  readonly id: string;
  readonly when: TimePoint;
  readonly createdAt: number;
}

export type TimelineGroup = 'dated' | 'needsReview' | 'undated' | 'broken';

export interface OrderedEntry {
  readonly id: string;
  readonly rank: number;
  readonly group: TimelineGroup;
  readonly rootId?: string;
  readonly rootDate?: CalendarDate;
  readonly relative: boolean;
}

export type CalendarDateKey = readonly [
  eraIndex: number, year: number, monthIndex: number, day: number, minuteOfDay: number,
];

export function calendarDateKey(calendar: Calendar, date: CalendarDate): CalendarDateKey | undefined {
  if (!checkCalendarDate(calendar, date).ok) {
    return undefined;
  }
  const eraIndex = calendar.eras.findIndex(era => era.id === date.era);
  const year = calendar.eras[eraIndex].countsDown ? -date.year : date.year;
  const monthIndex = date.month === undefined ? -1 : calendar.months.findIndex(month => month.id === date.month);
  return [eraIndex, year, monthIndex, date.day ?? 0, date.time ? 60 * date.time.hour + date.time.minute : -1];
}

function compareDateKeys(a: CalendarDateKey, b: CalendarDateKey): number {
  for (const [index, part] of a.entries()) {
    const difference = part - b[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** A comparison is available when both dates are valid in the calendar. */
export function compareCalendarDates(calendar: Calendar, a: CalendarDate, b: CalendarDate): number | undefined {
  const left = calendarDateKey(calendar, a);
  const right = calendarDateKey(calendar, b);
  return left && right ? compareDateKeys(left, right) : undefined;
}

interface Children {
  before: TimedItem[];
  at: TimedItem[];
  after: TimedItem[];
}

interface DatedRoot {
  item: TimedItem;
  date: CalendarDate;
  key: CalendarDateKey;
}

interface StackEntry {
  item: TimedItem;
  expanded: boolean;
}

function compareCreation(a: TimedItem, b: TimedItem): number {
  const aTime = Number.isNaN(a.createdAt) ? Infinity : a.createdAt;
  const bTime = Number.isNaN(b.createdAt) ? Infinity : b.createdAt;
  return aTime - bTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function orderTimeline(items: readonly TimedItem[], calendar: Calendar): OrderedEntry[] {
  const byId = new Map<string, TimedItem>();
  for (const item of items) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }

  // Populate each child list and the undated roots in creation order with one shared sort.
  const byCreation = [...byId.values()].sort(compareCreation);
  const dated: DatedRoot[] = [];
  const needsReview: TimedItem[] = [];
  const undated: TimedItem[] = [];
  const childrenByAnchor = new Map<string, Children>();
  for (const item of byCreation) {
    const { when } = item;
    if (when.kind === 'date') {
      const key = calendarDateKey(calendar, when.date);
      if (key) {
        dated.push({ item, date: when.date, key });
      } else {
        needsReview.push(item);
      }
    } else if (when.kind === 'unset') {
      undated.push(item);
    } else if (byId.has(when.anchor)) {
      let children = childrenByAnchor.get(when.anchor);
      if (!children) {
        children = { before: [], at: [], after: [] };
        childrenByAnchor.set(when.anchor, children);
      }
      children[when.kind].push(item);
    }
  }
  dated.sort((a, b) => compareDateKeys(a.key, b.key) || compareCreation(a.item, b.item));

  const ordered: OrderedEntry[] = [];
  const rooted = new Set<string>();

  function appendBlock(root: TimedItem, group: Exclude<TimelineGroup, 'broken'>, rootDate?: CalendarDate): void {
    const stack: StackEntry[] = [{ item: root, expanded: false }];
    function pushChildren(children: readonly TimedItem[]): void {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ item: children[i], expanded: false });
      }
    }

    while (stack.length) {
      const { item, expanded } = stack.pop()!;
      const children = childrenByAnchor.get(item.id);
      if (children && !expanded) {
        // The stack pops in reverse: before blocks, anchor, same-time blocks, after blocks.
        pushChildren(children.after);
        pushChildren(children.at);
        stack.push({ item, expanded: true });
        pushChildren(children.before);
        continue;
      }
      rooted.add(item.id);
      ordered.push({
        id: item.id,
        rank: ordered.length,
        group,
        rootId: root.id,
        ...(rootDate ? { rootDate } : {}),
        relative: item.id !== root.id,
      });
    }
  }

  for (const { item, date } of dated) {
    appendBlock(item, 'dated', date);
  }
  for (const item of needsReview) {
    appendBlock(item, 'needsReview');
  }
  for (const item of undated) {
    appendBlock(item, 'undated');
  }

  // Each relative item has one anchor. A cycle or a missing anchor cannot be reached from a root.
  // A single scan picks up those components and their descendants without walking each anchor chain.
  for (const { id } of byCreation) {
    if (!rooted.has(id)) {
      ordered.push({ id, rank: ordered.length, group: 'broken', relative: false });
    }
  }
  return ordered;
}
