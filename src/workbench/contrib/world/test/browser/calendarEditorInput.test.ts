import { expect, it, vi } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { getGregorianCalendar, type Calendar } from '../../../../../platform/world/common/calendar.js';
import { IWorkService } from '../../../../services/work/common/work.js';
import { IWorldService } from '../../../../services/world/common/worldService.js';
import { CalendarEditorSerializer, ICalendarInputService } from '../../browser/calendarEditorInput.js';

it('shares the work input, restores only that work and reports dirty changes across save', async () => {
  const disposables = new DisposableStore();
  try {
    const changed = disposables.add(new Emitter<string>());
    let calendar = getGregorianCalendar();
    let revision = 0;
    const getCalendar = vi.fn(async () => ({ calendar, revision }));
    const putCalendar = vi.fn(async (id: string, draft: Calendar, expected: number) => {
      expect(expected).toBe(revision);
      calendar = draft;
      revision++;
      changed.fire(id);
      return { calendar, revision };
    });
    const services = new ServiceCollection(
      [IWorldService, { store: { getCalendar, putCalendar }, onDidChangeCalendar: changed.event }],
      [IDialogService, {}],
      [INotificationService, {}],
      [IWorkService, { current: { id: 'work' } }],
    );
    const instantiation = new InstantiationService(services);
    const inputs = instantiation.invokeFunction(accessor => accessor.get(ICalendarInputService));
    const first = disposables.add(inputs.getOrCreate('work'));
    const serializer = new CalendarEditorSerializer();
    expect(first.resource.toString()).toBe('world-calendar://work');
    expect(serializer.deserialize(instantiation, serializer.serialize(first)!)).toBe(first);
    expect(serializer.deserialize(instantiation, 'other')).toBeUndefined();

    await first.resolve();
    const dirty: boolean[] = [];
    first.onDidChangeDirty(() => dirty.push(first.isDirty()));
    const composition = first.model.beginComposition();
    first.model.card!.edit({ ...calendar, hoursPerDay: 20 });
    expect(await first.save(1)).toBeUndefined();
    expect(putCalendar).not.toHaveBeenCalled();
    composition.dispose();
    expect(await first.save(1)).toBe(first);
    expect(putCalendar).toHaveBeenCalledOnce();
    expect(dirty).toEqual([true, false]);

    first.dispose();
    const restored = disposables.add(serializer.deserialize(instantiation, 'work')!);
    expect(restored).not.toBe(first);
    await restored.resolve();
    expect(restored.model.card?.draft.hoursPerDay).toBe(20);
  } finally {
    disposables.dispose();
  }
});
