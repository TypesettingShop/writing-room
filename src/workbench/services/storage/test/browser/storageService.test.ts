import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { StorageScope, StorageTarget, storageKey, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import {
  BrowserStorageService, registerStorageMigration, STORAGE_PREFIX, STORAGE_SCHEMA_VERSION, STORAGE_VERSION_KEY,
} from '../../browser/storageService.js';

const storageProperty = `${'local'}Storage` as const;
const scope = StorageScope.PROFILE;
const target = StorageTarget.USER;
const physicalKey = (key: string) => STORAGE_PREFIX + storageKey(scope, key);
const area = window[storageProperty];
const disposables = new DisposableStore();

function storageEvent(key: string | null, newValue: string | null): void {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: area }));
}

beforeEach(() => area.clear());

afterEach(() => {
  disposables.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('schema', () => {
  test('writes the current version with the first value and changes only the written key thereafter', async () => {
    area.setItem('outside', 'untouched');
    const storage = disposables.add(new BrowserStorageService());
    expect(area.getItem(STORAGE_VERSION_KEY)).toBeNull();

    storage.store('initial', 'first', scope, target);
    await Promise.resolve();
    expect(area.getItem(STORAGE_VERSION_KEY)).toBe(String(STORAGE_SCHEMA_VERSION));
    expect(area.getItem(physicalKey('initial'))).toBe('first');

    area.setItem(physicalKey('other-tab'), 'keep');
    area.setItem(STORAGE_PREFIX + '2:unknown-scope', 'keep');
    const set = vi.spyOn(window.Storage.prototype, 'setItem');
    const remove = vi.spyOn(window.Storage.prototype, 'removeItem');
    storage.store('only', 'second', scope, target);
    void storage.flush();
    expect(set.mock.calls).toEqual([[physicalKey('only'), 'second']]);
    expect(remove).not.toHaveBeenCalled();
    expect(area.getItem(physicalKey('initial'))).toBe('first');
    expect(area.getItem(physicalKey('other-tab'))).toBe('keep');
    expect(area.getItem(STORAGE_PREFIX + '2:unknown-scope')).toBe('keep');
    expect(area.getItem('outside')).toBe('untouched');
  });

  test('never reads entries or writes anything when the saved schema is newer', () => {
    const marker = String(STORAGE_SCHEMA_VERSION + 1);
    area.setItem(STORAGE_VERSION_KEY, marker);
    area.setItem(physicalKey('future'), 'preserved');
    const read = vi.spyOn(window.Storage.prototype, 'getItem');
    const enumerate = vi.spyOn(window.Storage.prototype, 'key');
    const write = vi.spyOn(window.Storage.prototype, 'setItem');
    const remove = vi.spyOn(window.Storage.prototype, 'removeItem');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = disposables.add(new BrowserStorageService());
    expect(storage.get('future', scope, 'default')).toBe('default');
    storage.store('new', 'memory', scope, target);
    storage.store('future', 'temporary', scope, target);
    storage.remove('future', scope);
    void storage.flush();

    expect(storage.get('new', scope)).toBe('memory');
    expect(read.mock.calls).toEqual([[STORAGE_VERSION_KEY]]);
    expect(enumerate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(area.getItem(STORAGE_VERSION_KEY)).toBe(marker);
    expect(area.getItem(physicalKey('future'))).toBe('preserved');
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test.each(['corrupt', '20'])('falls back without replacing invalid or unmigratable schema %s', marker => {
    area.setItem(STORAGE_VERSION_KEY, marker);
    area.setItem(physicalKey('saved'), 'preserved');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = disposables.add(new BrowserStorageService(window, 21));
    expect(storage.get('saved', scope, 'default')).toBe('default');
    storage.store('saved', 'temporary', scope, target);
    void storage.flush();
    expect(area.getItem(STORAGE_VERSION_KEY)).toBe(marker);
    expect(area.getItem(physicalKey('saved'))).toBe('preserved');
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('runs versionless and older migrations in order once, preserving unrelated keys', () => {
    const calls: number[] = [];
    const legacy = storageKey(scope, 'legacy');
    const current = storageKey(scope, 'current');
    registerStorageMigration(1, draft => {
      calls.push(1);
      draft.set(current, draft.get(legacy) + ' -> 2');
      draft.delete(legacy);
    });
    registerStorageMigration(0, draft => {
      calls.push(0);
      draft.set(legacy, draft.get(legacy) + ' -> 1');
    });
    area.setItem(physicalKey('legacy'), 'start');
    area.setItem(physicalKey('unrelated'), 'keep');

    const migrated = disposables.add(new BrowserStorageService(window, 2));
    const second = disposables.add(new BrowserStorageService(window, 2));
    expect(calls).toEqual([0, 1]);
    expect(migrated.get('legacy', scope)).toBeUndefined();
    expect(migrated.get('current', scope)).toBe('start -> 1 -> 2');
    expect(second.get('current', scope)).toBe('start -> 1 -> 2');
    expect(area.getItem(STORAGE_VERSION_KEY)).toBe('2');
    expect(area.getItem(physicalKey('legacy'))).toBeNull();
    expect(area.getItem(physicalKey('unrelated'))).toBe('keep');
  });

  test('preserves the database and version when a later migration throws', () => {
    area.setItem(STORAGE_VERSION_KEY, '4');
    area.setItem(physicalKey('saved'), 'original');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerStorageMigration(4, draft => {
      draft.delete(storageKey(scope, 'saved'));
      draft.set(storageKey(scope, 'new'), 'partially migrated');
    });
    registerStorageMigration(5, () => {
      throw new Error('migration failed');
    });

    const storage = disposables.add(new BrowserStorageService(window, 6));
    expect(storage.get('saved', scope)).toBeUndefined();
    expect(storage.get('new', scope)).toBeUndefined();
    expect(area.getItem(STORAGE_VERSION_KEY)).toBe('4');
    expect(area.getItem(physicalKey('saved'))).toBe('original');
    expect(area.getItem(physicalKey('new'))).toBeNull();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('restores applied migration writes when writing the new version fails', () => {
    area.setItem(STORAGE_VERSION_KEY, '8');
    area.setItem(physicalKey('saved'), 'original');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerStorageMigration(8, draft => {
      draft.set(storageKey(scope, 'new'), 'migrated');
      draft.delete(storageKey(scope, 'saved'));
    });
    const original = window.Storage.prototype.setItem;
    vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(function (this: globalThis.Storage, key, value) {
      if (key === STORAGE_VERSION_KEY) {
        throw new DOMException('Quota is full', 'QuotaExceededError');
      }
      original.call(this, key, value);
    });

    const storage = disposables.add(new BrowserStorageService(window, 9));
    expect(storage.get('new', scope)).toBeUndefined();
    expect(area.getItem(physicalKey('saved'))).toBe('original');
    expect(area.getItem(physicalKey('new'))).toBeNull();
    expect(area.getItem(STORAGE_VERSION_KEY)).toBe('8');
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('an already open older tab cannot write after a schema change', () => {
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
    area.setItem(physicalKey('saved'), 'old');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = disposables.add(new BrowserStorageService());
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION + 1));
    area.setItem(physicalKey('saved'), 'from newer build');
    storage.store('saved', 'local only', scope, target);
    void storage.flush();

    expect(storage.get('saved', scope)).toBe('local only');
    expect(area.getItem(physicalKey('saved'))).toBe('from newer build');
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe('fallback and browser events', () => {
  test.each(['QuotaExceededError', 'SecurityError'])('retains memory after a %s write failure and logs it once', errorName => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = disposables.add(new BrowserStorageService());
    const write = vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Unavailable', errorName);
    });
    storage.store('first', 'one', scope, target);
    void storage.flush();
    storage.store('second', 'two', scope, target);
    void storage.flush();
    expect(storage.get('first', scope)).toBe('one');
    expect(storage.get('second', scope)).toBe('two');
    expect(warning).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('works when reading the browser storage property itself throws', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getter = vi.spyOn(window, storageProperty, 'get').mockImplementation(() => {
      throw new DOMException('Access denied', 'SecurityError');
    });
    const storage = disposables.add(new BrowserStorageService());
    storage.store('key', 'memory', scope, target);
    void storage.flush();
    expect(storage.get('key', scope)).toBe('memory');
    expect(getter).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('accepts external inserts and deletions and ignores keys from outside the namespace', () => {
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
    const storage = disposables.add(new BrowserStorageService());
    const change = vi.fn();
    storage.onDidChangeValue(scope, undefined, disposables)(change);

    area.setItem('foreign', 'ignore');
    storageEvent('foreign', 'ignore');
    area.setItem(physicalKey('shared'), 'other tab');
    storageEvent(physicalKey('shared'), 'other tab');
    expect(storage.get('shared', scope)).toBe('other tab');
    expect(storage.get('foreign', scope)).toBeUndefined();
    area.removeItem(physicalKey('shared'));
    storageEvent(physicalKey('shared'), null);
    expect(storage.get('shared', scope)).toBeUndefined();
    const externalChange = { scope, key: 'shared', target: undefined, external: true };
    expect(change.mock.calls).toEqual([[externalChange], [externalChange]]);
  });

  test('keeps a queued local write and ignores an outdated event after it persists', () => {
    const storage = disposables.add(new BrowserStorageService());
    storage.store('shared', 'initial', scope, target);
    void storage.flush();
    const change = vi.fn();
    storage.onDidChangeValue(scope, undefined, disposables)(change);
    storage.store('shared', 'local', scope, target);
    area.setItem(physicalKey('shared'), 'remote');
    storageEvent(physicalKey('shared'), 'remote');
    expect(storage.get('shared', scope)).toBe('local');
    void storage.flush();

    storageEvent(physicalKey('shared'), 'remote');
    expect(area.getItem(physicalKey('shared'))).toBe('local');
    expect(storage.get('shared', scope)).toBe('local');
    expect(change.mock.calls).toEqual([[{ scope, key: 'shared', target }]]);
  });

  test('reconciles a cross-tab clear and persists again with a new version marker', () => {
    const storage = disposables.add(new BrowserStorageService());
    storage.store('previous', 'before clear', scope, target);
    void storage.flush();
    area.clear();
    storageEvent(null, null);
    expect(storage.get('previous', scope)).toBeUndefined();

    storage.store('next', 'after clear', scope, target);
    void storage.flush();
    expect(area.getItem(physicalKey('next'))).toBe('after clear');
    expect(area.getItem(STORAGE_VERSION_KEY)).toBe(String(STORAGE_SCHEMA_VERSION));
  });

  test('persists within visibilitychange and pagehide despite a failed save listener', () => {
    const storage = disposables.add(new BrowserStorageService());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    storage.onWillSaveState(() => { throw new Error('listener failed'); }, undefined, disposables);
    storage.onWillSaveState(({ reason }) => {
      const value = reason === WillSaveStateReason.SHUTDOWN ? 'pagehide' : 'hidden';
      storage.store('saved', value, scope, target);
    }, undefined, disposables);

    document.dispatchEvent(new Event('visibilitychange'));
    expect(area.getItem(physicalKey('saved'))).toBeNull();
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(area.getItem(physicalKey('saved'))).toBe('hidden');
    window.dispatchEvent(new Event('pagehide'));
    expect(area.getItem(physicalKey('saved'))).toBe('pagehide');
    expect(error).toHaveBeenCalledTimes(2);
  });

  test('saves periodically at idle and stops on disposal', () => {
    vi.useFakeTimers();
    const storage = disposables.add(new BrowserStorageService());
    const save = vi.fn(() => storage.store('idle', 'saved', scope, target));
    storage.onWillSaveState(save, undefined, disposables);
    vi.advanceTimersByTime(59_999);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(area.getItem(physicalKey('idle'))).toBe('saved');
    vi.advanceTimersByTime(59_999);
    expect(save).toHaveBeenCalledTimes(1);
    storage.dispose();
    vi.advanceTimersByTime(120_000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
