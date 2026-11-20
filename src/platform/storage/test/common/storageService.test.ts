import { afterEach, describe, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { InMemoryStorageDatabase } from '../../../../base/parts/storage/common/storage.js';
import type { IStorageUpdate } from '../../../../base/parts/storage/common/storage.js';
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

  test('reads back fractional numbers and gives the fallback for JSON that is not an object', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = disposables.add(new InMemoryStorageService());
    storage.store('fraction', 250.5, scope, target);
    storage.store('large', 1e21, scope, target);
    expect(storage.getNumber('fraction', scope, 0)).toBe(250.5);
    expect(storage.getNumber('large', scope, 0)).toBe(1e21);

    const fallback = { value: 'fallback' };
    storage.store('null', 'null', scope, target);
    storage.store('number', '5', scope, target);
    expect(storage.getObject('null', scope, fallback)).toBe(fallback);
    expect(storage.getObject('number', scope, fallback)).toBe(fallback);
    expect(warning).toHaveBeenCalledTimes(2);
  });

  test('adds the change subscription to the store given to the returned event as well', () => {
    const storage = disposables.add(new InMemoryStorageService());
    const service = disposables.add(new DisposableStore());
    const listenerStore = new DisposableStore();
    const change = vi.fn();
    storage.onDidChangeValue(scope, 'key', service)(change, undefined, listenerStore);
    storage.store('key', 'one', scope, target);
    listenerStore.dispose();
    storage.store('key', 'two', scope, target);
    expect(change).toHaveBeenCalledTimes(1);
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

/** A backend another tab can write to directly, and that can be made to fail. */
class SharedDatabase extends InMemoryStorageDatabase {
  failOpen = false;
  failWrite = false;
  readonly reads: string[] = [];
  opens = 0;

  override getItems(): Map<string, string> {
    this.opens++;
    if (this.failOpen) {
      throw new Error('access denied');
    }
    return super.getItems();
  }

  override getItem(key: string): string | undefined {
    this.reads.push(key);
    return super.getItem(key);
  }

  override updateItems(update: IStorageUpdate): void {
    if (this.failWrite) {
      throw new Error('quota exceeded');
    }
    super.updateItems(update);
  }

  /** Writes as another tab would, without this tab's storage seeing it. */
  writeFromOtherTab(key: string, value: string | undefined): void {
    super.updateItems(value === undefined
      ? { insert: new Map(), delete: new Set([key]) }
      : { insert: new Map([[key, value]]), delete: new Set() });
  }
}

const namespaced = (key: string) => `${scope}:${key}`;

describe('cached keys', () => {
  test('lists a detached snapshot per scope, including queued and immediate changes', () => {
    const storage = disposables.add(new InMemoryStorageService());
    const key = 'shared:part';
    storage.store(key, 'profile', scope, target);
    storage.store(key, 'application', StorageScope.APPLICATION, target);
    storage.store('work', 'workspace', StorageScope.WORKSPACE, target);

    const snapshot = storage.keys(scope);
    expect(storage.keys(StorageScope.APPLICATION)).toEqual([key]);
    expect(storage.keys(StorageScope.WORKSPACE)).toEqual(['work']);

    storage.remove(key, scope);
    expect(storage.keys(scope)).toEqual([]);
    storage.storeImmediately('immediate', 'saved', scope, target);
    expect(storage.keys(scope)).toEqual(['immediate']);
    storage.storeImmediately('immediate', () => undefined, scope, target);
    expect(storage.keys(scope)).toEqual([]);
    expect(snapshot).toEqual([key]);
    snapshot.push('caller');
    expect(storage.keys(scope)).toEqual([]);
  });

  test.each([false, true])('only reads this tab’s cache (failed open: %s)', failOpen => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const database = new SharedDatabase();
    database.failOpen = failOpen;
    const write = vi.spyOn(database, 'updateItems');
    const storage = disposables.add(new InMemoryStorageService(database));
    const change = vi.fn();
    storage.onDidChangeValue(scope, undefined, disposables)(change);

    database.writeFromOtherTab(namespaced('elsewhere'), 'other tab');
    expect(storage.keys(scope)).toEqual([]);
    expect(database.opens).toBe(1);
    expect(database.reads).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();

    if (failOpen) {
      storage.store('local', 'session', scope, target);
      expect(storage.keys(scope)).toEqual(['local']);
      expect(database.opens).toBe(1);
      expect(database.reads).toEqual([]);
      expect(write).not.toHaveBeenCalled();
    } else {
      expect(storage.getPersisted('elsewhere', scope)).toBe('other tab');
      expect(storage.keys(scope)).toEqual(['elsewhere']);
    }
    const cached = storage.keys(scope);
    storage.dispose();
    expect(storage.keys(scope)).toEqual(cached);
  });
});

describe('memory mode and persisted reads', () => {
  test('a service whose backend opened is not in memory mode', () => {
    const storage = disposables.add(new InMemoryStorageService(new SharedDatabase()));
    expect(storage.usesMemory).toBe(false);
  });

  test('a backend that cannot be opened puts the service in memory mode, and reads answer this tab without reopening it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const database = new SharedDatabase();
    database.failOpen = true;
    const storage = disposables.add(new InMemoryStorageService(database));
    expect(storage.usesMemory).toBe(true);
    storage.store('key', 'session', scope, target);
    void storage.flush();
    database.writeFromOtherTab(namespaced('key'), 'elsewhere');
    expect(storage.getPersisted('key', scope)).toBe('session');
    expect(storage.getPersisted('missing', scope)).toBeUndefined();
    expect(database.opens).toBe(1);
    expect(database.reads).toEqual([]);
  });

  test('a failed write puts the service in memory mode for good', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const database = new SharedDatabase();
    const storage = disposables.add(new InMemoryStorageService(database));
    database.failWrite = true;
    storage.store('key', 'one', scope, target);
    void storage.flush();
    expect(storage.usesMemory).toBe(true);
    database.failWrite = false;
    storage.store('key', 'two', scope, target);
    void storage.flush();
    expect(storage.usesMemory).toBe(true);
    expect(storage.getPersisted('key', scope)).toBe('two');
    expect(database.reads).toEqual([]);
  });

  test('reads what another tab persisted, aligns the cache and reports an external change once', () => {
    const database = new SharedDatabase();
    const storage = disposables.add(new InMemoryStorageService(database));
    const change = vi.fn();
    storage.onDidChangeValue(scope, undefined, disposables)(change);

    database.writeFromOtherTab(namespaced('shared'), 'other tab');
    expect(storage.getPersisted('shared', scope)).toBe('other tab');
    expect(storage.get('shared', scope)).toBe('other tab');
    expect(storage.getPersisted('shared', scope)).toBe('other tab');
    expect(change.mock.calls).toEqual([[{ scope, key: 'shared', target: undefined, external: true }]]);

    database.writeFromOtherTab(namespaced('shared'), undefined);
    expect(storage.getPersisted('shared', scope)).toBeUndefined();
    expect(storage.get('shared', scope)).toBeUndefined();
    expect(change).toHaveBeenCalledTimes(2);
    expect(database.reads).toEqual([namespaced('shared'), namespaced('shared'), namespaced('shared')]);
  });

  test('answers a value this tab queued and still persists it', async () => {
    const database = new SharedDatabase();
    const storage = disposables.add(new InMemoryStorageService(database));
    storage.store('queued', 'local', scope, target);
    database.writeFromOtherTab(namespaced('queued'), 'other tab');
    expect(storage.getPersisted('queued', scope)).toBe('local');
    storage.remove('removed', scope);
    expect(storage.getPersisted('removed', scope)).toBeUndefined();
    await Promise.resolve();
    expect(database.getItems().get(namespaced('queued'))).toBe('local');
  });

  test('answers the cache once the service is closed', () => {
    const database = new SharedDatabase();
    const storage = new InMemoryStorageService(database);
    storage.store('key', 'cached', scope, target);
    storage.dispose();
    database.writeFromOtherTab(namespaced('key'), 'other tab');
    expect(storage.getPersisted('key', scope)).toBe('cached');
  });
});
