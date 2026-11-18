import { expect, test } from 'vitest';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { InMemoryStorageDatabase } from '../../../base/parts/storage/common/storage.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { Memento } from '../../common/memento.js';

test('loads one mutable object per scope, saves changes, and removes an emptied memento', () => {
  const disposables = new DisposableStore();
  const database = new InMemoryStorageDatabase();
  const storage = disposables.add(new InMemoryStorageService(database));
  const profile = StorageScope.PROFILE;
  const workspace = StorageScope.WORKSPACE;
  const target = StorageTarget.USER;
  const key = 'memento/component';
  try {
    storage.store(key, { count: 1 }, profile, target);
    const memento = disposables.add(new Memento<{ count: number }>('component', storage));
    const state = memento.getMemento(profile, target);
    const workspaceState = memento.getMemento(workspace, target);
    expect(state).toEqual({ count: 1 });
    expect(workspaceState).toEqual({});
    expect(memento.getMemento(profile, target)).toBe(state);

    storage.store(key, { count: 9 }, profile, target);
    void storage.flush();
    expect(storage.getObject(key, profile)).toEqual({ count: 9 });
    expect(state).toEqual({ count: 1 });

    state.count = 2;
    workspaceState.count = 3;
    void storage.flush();
    const reader = disposables.add(new InMemoryStorageService(database));
    expect(reader.getObject(key, profile)).toEqual({ count: 2 });
    expect(reader.getObject(key, workspace)).toEqual({ count: 3 });

    delete state.count;
    void storage.flush();
    expect(storage.get(key, profile)).toBeUndefined();
  } finally {
    disposables.dispose();
  }
});
