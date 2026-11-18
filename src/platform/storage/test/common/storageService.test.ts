import { afterEach, describe, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { InMemoryStorageDatabase } from '../../../../base/parts/storage/common/storage.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../common/storage.js';

const scope = StorageScope.PROFILE;
const target = StorageTarget.USER;
const disposables = new DisposableStore();

afterEach(() => {
  disposables.clear();
  vi.restoreAllMocks();
});

describe('InMemoryStorageService', () => {
  test('updates the cache immediately and persists by the end of the task', async () => {
    const database = new InMemoryStorageDatabase();
    const writer = disposables.add(new InMemoryStorageService(database));
    writer.store('string', '', scope, target);
    writer.store('bool', false, scope, target);
    writer.store('num', 0, scope, target);
    writer.store('obj', { value: 'object' }, scope, target);
    expect(writer.get('string', scope)).toBe('');

    await Promise.resolve();
    const reader = disposables.add(new InMemoryStorageService(database));
    expect(reader.get('string', scope, 'fallback')).toBe('');
    expect(reader.getBoolean('bool', scope, true)).toBe(false);
    expect(reader.getNumber('num', scope, 99)).toBe(0);
    expect(reader.getObject('obj', scope)).toEqual({ value: 'object' });
  });

  test('provides fallbacks and logs malformed JSON once per scoped key', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = disposables.add(new InMemoryStorageService());
    expect(storage.get('missing', scope, 'fallback')).toBe('fallback');
    expect(storage.getBoolean('missing', scope, true)).toBe(true);
    expect(storage.getNumber('missing', scope, 42)).toBe(42);
    const fallback = { value: 'fallback' };
    expect(storage.getObject('missing', scope, fallback)).toBe(fallback);

    storage.store('broken', '{', scope, target);
    expect(storage.getObject('broken', scope, fallback)).toBe(fallback);
    expect(storage.getObject('broken', scope)).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    storage.store('broken', '[', StorageScope.WORKSPACE, target);
    expect(storage.getObject('broken', StorageScope.WORKSPACE)).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(2);
  });

  test('isolates equal keys across scopes and persists all removal paths synchronously', () => {
    const database = new InMemoryStorageDatabase();
    const storage = disposables.add(new InMemoryStorageService(database));
    storage.store('same', 'profile', scope, target);
    storage.store('same', 'work', StorageScope.WORKSPACE, target);
    storage.store('same', 'app', StorageScope.APPLICATION, target);
    storage.store('null', 'before', scope, target);
    void storage.flush();
    storage.store('same', undefined, scope, target);
    storage.store('null', null, scope, target);
    storage.remove('same', StorageScope.WORKSPACE);
    void storage.flush();

    const reader = disposables.add(new InMemoryStorageService(database));
    expect(reader.get('same', scope)).toBeUndefined();
    expect(reader.get('null', scope)).toBeUndefined();
    expect(reader.get('same', StorageScope.WORKSPACE)).toBeUndefined();
    expect(reader.get('same', StorageScope.APPLICATION)).toBe('app');
  });

  test('emits only changed values for the requested scope and key, until disposed', () => {
    const storage = disposables.add(new InMemoryStorageService());
    const subscriptions = disposables.add(new DisposableStore());
    const keyChange = vi.fn();
    const scopeChange = vi.fn();
    storage.onDidChangeValue(scope, 'key', subscriptions)(keyChange);
    storage.onDidChangeValue(scope, undefined, subscriptions)(scopeChange);

    storage.store('key', 'one', scope, target);
    storage.store('key', 'one', scope, StorageTarget.MACHINE);
    storage.store('key', 'two', StorageScope.WORKSPACE, target);
    storage.store('other', 'three', scope, target);
    storage.remove('key', scope);
    storage.remove('key', scope);
    subscriptions.dispose();
    storage.store('key', 'four', scope, target);

    expect(keyChange.mock.calls.map(([event]) => event)).toEqual([
      { scope, key: 'key', target },
      { scope, key: 'key', target: undefined },
    ]);
    expect(scopeChange.mock.calls.map(([event]) => event.key)).toEqual(['key', 'other', 'key']);
  });
});
