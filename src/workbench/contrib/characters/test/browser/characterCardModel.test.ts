import { afterEach, expect, test, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { characterLimits, CharacterStoreError, type CharacterEntry } from '../../../../../platform/characters/common/characters.js';
import type { CharacterNodeChange, CharactersStore } from '../../../../../platform/characters/common/charactersStore.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { CharacterCardModel, type CharacterCardSnapshot } from '../../browser/characterCardModel.js';

const initial: CharacterEntry = {
  id: 'character', kind: 'character', parentId: null, position: 0, title: 'Rin', type: 'unknown',
  values: { hidden: 'Preserve', role: 'Retired choice' }, createdAt: 0, updatedAt: 0,
};

const disposables = new DisposableStore();
afterEach(() => {
  disposables.clear();
  vi.useRealTimers();
});

function setup() {
  let snapshot: CharacterCardSnapshot = { node: initial, revision: 1 };
  const read = vi.fn(async () => snapshot);
  const write = vi.fn<CharactersStore['updateNode']>(async (_workId, _id, patch, expected) => {
    if (expected !== snapshot.revision) {
      throw new CharacterStoreError('conflict', snapshot.revision);
    }
    if (!snapshot.node) {
      throw new CharacterStoreError('not_found');
    }
    const node = { ...snapshot.node, ...patch };
    snapshot = { node, revision: snapshot.revision + 1 };
    return { node, revision: snapshot.revision };
  });
  const error = vi.fn();
  const close = vi.fn();
  const prompt = vi.fn(() => ({ result: Promise.resolve<number | undefined>(2), close }));
  const model = disposables.add(new CharacterCardModel('work', initial, 1, {
    updateNode: write,
  } as unknown as CharactersStore, read, { prompt } as IDialogService, { error, warn: vi.fn() } as unknown as INotificationService));
  return {
    model, read, write, error, prompt,
    external(node: CharacterEntry | undefined) {
      snapshot = { node, revision: snapshot.revision + 1 };
    },
  };
}

test('uses the whole tree revision and retries automatically when this card matches its baseline', async () => {
  const { model, write, external, prompt } = setup();
  external({ ...initial, parentId: 'another folder' });
  model.edit({ ...model.draft, title: '  Rin Updated  ' });
  await expect(model.save('explicit')).resolves.toBe(true);
  expect(write.mock.calls.map(call => call[3])).toEqual([1, 2]);
  expect(prompt).not.toHaveBeenCalled();
  expect(model.draft).toEqual({ title: 'Rin Updated', type: 'unknown', values: initial.values });

  model.edit({ ...model.draft, type: 'female' });
  await expect(model.save('explicit')).resolves.toBe(true);
  expect(write.mock.lastCall?.[3]).toBe(3);
});

test('checks the store size limit in UTF-8 before writing', async () => {
  const { model, write, error } = setup();
  model.edit({ ...model.draft, values: { goal: '한'.repeat(Math.ceil(characterLimits.values / 3)) } });
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(error).toHaveBeenCalledExactlyOnceWith('Character input exceeds the size limit.');
  expect(write).not.toHaveBeenCalled();
  expect(model.dirty).toBe(true);
});

test('preserves a newer draft while a save is in flight and submits it with the returned revision', async () => {
  const { model, write } = setup();
  const first = new DeferredPromise<CharacterNodeChange>();
  write.mockImplementationOnce(() => first.p);
  model.edit({ ...model.draft, values: { goal: 'First' } });
  const pending = model.save('explicit');
  model.edit({ ...model.draft, values: { goal: 'Second' } });
  const saveAgain = model.save('explicit');
  write.mockResolvedValueOnce({ node: { ...initial, values: { goal: 'Second' } }, revision: 3 });
  await first.complete({ node: { ...initial, values: { goal: 'First' } }, revision: 2 });
  await expect(pending).resolves.toBe(true);
  await expect(saveAgain).resolves.toBe(true);
  expect(write.mock.calls.map(call => [call[2].values?.goal, call[3]])).toEqual([['First', 1], ['Second', 2]]);
  expect(model.draft.values.goal).toBe('Second');
  expect(model.dirty).toBe(false);
});

test('cancels idle writes while composing and defers conflict prompts until composition ends', async () => {
  vi.useFakeTimers();
  const { model, write, external, prompt } = setup();
  external({ ...initial, values: { goal: 'Remote' } });
  const composition = model.beginComposition();
  model.edit({ ...model.draft, values: { goal: '한' } });
  model.scheduleAutoSave(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(write).not.toHaveBeenCalled();
  const saved = model.save('explicit');
  await vi.advanceTimersByTimeAsync(0);
  expect(write.mock.lastCall?.[2].values?.goal).toBe('한');
  expect(prompt).not.toHaveBeenCalled();
  composition.dispose();
  await expect(saved).resolves.toBe(false);
  expect(prompt).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(write).toHaveBeenCalledOnce();
  expect(model.draft.values.goal).toBe('한');
});

test('a remotely deleted card preserves its draft for copying and never attempts to write it again', async () => {
  const { model, external, write, prompt } = setup();
  external(undefined);
  model.edit({ ...model.draft, title: 'Still copyable' });
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(model.deleted).toBe(true);
  expect(model.dirty).toBe(false);
  expect(model.draft.title).toBe('Still copyable');
  expect(prompt).not.toHaveBeenCalled();
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(write).toHaveBeenCalledOnce();
});

test('keeps the old baseline when remote changes arrive before the first preedit input event', async () => {
  const { model, read, external, write, prompt } = setup();
  const composition = model.beginComposition();
  external({ ...initial, title: 'Remote rename' });
  model.acceptTree(await read());
  expect(model.draft.title).toBe('Rin');
  model.edit({ ...model.draft, title: 'Rin 한' });
  composition.dispose();
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(write.mock.lastCall?.[3]).toBe(1);
  expect(prompt).toHaveBeenCalledOnce();
});
