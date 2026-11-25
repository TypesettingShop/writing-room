import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { getGregorianCalendar, type Calendar } from '../../../../../platform/world/common/calendar.js';
import { WorldStoreError } from '../../../../../platform/world/common/world.js';
import { checkCalendarDate } from '../../../../../platform/world/common/timePoint.js';
import { CalendarModel } from '../../browser/calendarModel.js';
import { countCalendarImpact, registerCalendarUsageSource, type CalendarUsageSource } from '../../browser/calendarUsage.js';

const disposables = new DisposableStore();
afterEach(() => {
  disposables.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(choice = 0, initial = getGregorianCalendar()) {
  let calendar = initial;
  let revision = 0;
  const getCalendar = vi.fn(async () => ({ calendar, revision }));
  const putCalendar = vi.fn(async (_workId: string, draft: Calendar, expected: number) => {
    if (expected !== revision) {
      throw new WorldStoreError('conflict', revision);
    }
    calendar = draft;
    return { calendar, revision: ++revision };
  });
  const prompt = vi.fn(() => ({ result: Promise.resolve(choice), close() {} }));
  const model = disposables.add(new CalendarModel('work', { getCalendar, putCalendar },
    { prompt } as unknown as IDialogService, { error: vi.fn() } as unknown as INotificationService));
  await model.retry();
  return {
    model, card: model.card!, getCalendar, putCalendar, prompt,
    advance(next = calendar) { calendar = next; revision++; },
  };
}

function shorten(calendar: Calendar): Calendar {
  return { ...calendar, months: calendar.months.map(row => row.id === 'jan' ? { ...row, days: 30 } : row) };
}

function addImpactSource(countAffected: CalendarUsageSource['countAffected']) {
  disposables.add(registerCalendarUsageSource({ label: 'events', countAffected }));
}

describe('calendar autosave', () => {
  it('keeps an invalid draft and waits for composition before autosaving a correction', async () => {
    vi.useFakeTimers();
    const { model, card, putCalendar } = await setup();
    expect(card.draft).toEqual(getGregorianCalendar());
    card.edit({ ...card.draft, months: [{ id: 'jan', name: '1월', days: 0 }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(card.saveBlock).toMatchObject({ kind: 'validation', problems: [{ fieldId: 'month-0' }] });
    expect(card.dirty).toBe(true);
    expect(putCalendar).not.toHaveBeenCalled();
    const composing = model.beginComposition();
    card.edit({ ...card.draft, months: [{ id: 'jan', name: '첫 달 ', days: 30 }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(putCalendar).not.toHaveBeenCalled();
    composing.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(putCalendar).toHaveBeenCalledOnce();
    expect(putCalendar.mock.calls[0][1].months[0].name).toBe('첫 달');
    expect(card.dirty).toBe(false);
    expect(card.draft.months[0].name).toBe('첫 달 ');
  });

  it('rechecks approval when another window saves the same calendar at a newer revision', async () => {
    const { card, model, putCalendar, advance, prompt } = await setup();
    const count = vi.fn(async () => 3);
    addImpactSource(count);
    card.edit(shorten(card.draft));
    expect(await card.save('explicit')).toBe(false);
    expect(card.saveBlock).toMatchObject({ kind: 'confirmation', hold: { message: expect.stringContaining('3 events') } });
    expect(putCalendar).not.toHaveBeenCalled();
    advance();
    await model.retry();
    expect(await card.applyChange()).toBe(false);
    expect(count).toHaveBeenCalledTimes(2);
    expect(putCalendar.mock.calls.map(call => call[2])).toEqual([0]);
    expect(card.saveBlock?.kind).toBe('confirmation');
    expect(prompt).not.toHaveBeenCalled();
    expect(await card.applyChange()).toBe(true);
    expect(putCalendar.mock.calls.map(call => call[2])).toEqual([0, 1]);
  });

  it('drops outdated review results and preserves the draft on failed reads', async () => {
    const { card, model, putCalendar, getCalendar } = await setup();
    const pending = new DeferredPromise<number>();
    const count = vi.fn(async () => pending.p);
    addImpactSource(count);
    card.edit(shorten(card.draft));
    const write = card.save('explicit');
    await Promise.resolve();
    expect(count).toHaveBeenCalledOnce();
    const next = { ...card.draft, hoursPerDay: 20 };
    card.edit(next);
    await pending.complete(0);
    expect(await write).toBe(false);
    expect(putCalendar).not.toHaveBeenCalled();
    getCalendar.mockRejectedValueOnce(new Error('read unavailable'));
    await model.retry();
    expect(model.readError).toBe(true);
    await model.retry();
    expect(model.readError).toBe(false);
    expect(card.draft).toBe(next);
    expect(card.dirty).toBe(true);
    await model.discardDraft();
    expect(card.draft).toEqual(getGregorianCalendar());
  });

  it('blocks close from approving a failed impact check', async () => {
    const { card, putCalendar } = await setup();
    addImpactSource(async () => { throw new Error('events unavailable'); });
    card.edit(shorten(card.draft));
    expect(await card.save('explicit')).toBe(false);
    expect(card.saveBlock?.kind).toBe('reviewError');
    expect(await card.confirmClose()).toBe(false);
    expect(putCalendar).not.toHaveBeenCalled();
    expect(card.dirty).toBe(true);
  });

  it('reloads remote calendar content only after the conflict choice', async () => {
    const { card, advance, prompt, putCalendar } = await setup();
    card.edit(shorten(card.draft));
    const remote = { ...getGregorianCalendar(), hoursPerDay: 20 };
    advance(remote);
    expect(await card.save('explicit')).toBe(true);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Reload', 'Overwrite', 'Cancel'] }));
    expect(card.draft).toEqual(remote);
    expect(card.dirty).toBe(false);
    expect(putCalendar).toHaveBeenCalledOnce();
  });

  it('attaches the normalizer’s list-limit error to the first excess row', async () => {
    const { card, putCalendar } = await setup();
    const months = Array.from({ length: 101 }, (_, index) => ({ id: 'month-' + index, name: '월', days: 31 }));
    card.edit({ ...card.draft, months });
    expect(await card.save('explicit')).toBe(false);
    expect(card.saveBlock).toMatchObject({
      kind: 'validation',
      problems: [{ fieldId: 'month-100', message: 'The calendar must have between 1 and 100 months.' }],
    });
    expect(putCalendar).not.toHaveBeenCalled();
  });

  it('keeps row IDs distinct from the preset, from generated IDs and from saved rows removed in this session', async () => {
    const uuid = (last: string) => `00000000-0000-4000-8000-00000000000${last}` as ReturnType<Crypto['randomUUID']>;
    const saved = getGregorianCalendar();
    const { model, card } = await setup(0, { ...saved, months: [...saved.months, { id: uuid('9'), name: '윤달', days: 30 }] });
    card.edit({ ...card.draft, months: card.draft.months.filter(month => month.id !== uuid('9')) });
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('jan' as ReturnType<Crypto['randomUUID']>)
      .mockReturnValueOnce(uuid('9')).mockReturnValueOnce(uuid('1')).mockReturnValueOnce(uuid('1')).mockReturnValueOnce(uuid('2'));
    expect(model.newRowId()).toBe(uuid('1'));
    expect(model.newRowId()).toBe(uuid('2'));
  });

  it('counts impact against the saved calendar, not against the previous draft', async () => {
    const { card, putCalendar } = await setup();
    const date = { era: 'ad', year: 2024, month: 'jan', day: 31 };
    const count = vi.fn<CalendarUsageSource['countAffected']>(async (_workId, saved, draft) =>
      Number(checkCalendarDate(saved, date).ok && !checkCalendarDate(draft, date).ok));
    addImpactSource(count);
    card.edit({ ...card.draft, months: [...card.draft.months].reverse() });
    expect(await card.save('explicit')).toBe(true);
    expect(putCalendar).toHaveBeenCalledOnce();
    card.edit(shorten(card.draft));
    expect(await card.save('explicit')).toBe(false);
    expect(card.saveBlock).toMatchObject({ kind: 'confirmation', hold: { message: expect.stringContaining('1 events') } });
    card.edit({ ...card.draft, hoursPerDay: 20 });
    expect(await card.save('explicit')).toBe(false);
    expect(card.saveBlock?.kind).toBe('confirmation');
    expect(putCalendar).toHaveBeenCalledOnce();
  });

  it('never sends a request while a field is composing, even when a save was requested', async () => {
    const { model, card, putCalendar } = await setup();
    const composing = model.beginComposition();
    card.edit({ ...card.draft, hoursPerDay: 20 });
    expect(await card.save('explicit')).toBe(false);
    expect(putCalendar).not.toHaveBeenCalled();
    expect(card.dirty).toBe(true);
    composing.dispose();
    expect(await card.save('explicit')).toBe(true);
    expect(putCalendar).toHaveBeenCalledOnce();
  });
});

it('combines source results and rejects a partial count', async () => {
  const calendar = getGregorianCalendar();
  const draft = shorten(calendar);
  addImpactSource(async () => 3);
  disposables.add(registerCalendarUsageSource({ label: 'relation records', countAffected: async () => 2 }));
  expect(await countCalendarImpact('work', calendar, draft)).toEqual([
    { label: 'events', count: 3 }, { label: 'relation records', count: 2 },
  ]);
  addImpactSource(async () => { throw new Error('unavailable'); });
  await expect(countCalendarImpact('work', calendar, draft)).rejects.toThrow('unavailable');
});
