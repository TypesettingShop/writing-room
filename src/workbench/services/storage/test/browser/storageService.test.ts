import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { StorageScope, StorageTarget, storageKey, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ExtensionStorage } from '../../../../api/browser/mainThreadStorage.js';
import {
  BrowserStorageService, registerStorageMigration, STORAGE_PREFIX, STORAGE_SCHEMA_VERSION, STORAGE_VERSION_KEY,
} from '../../browser/storageService.js';

// These tests install their own migrations. Use the installed extension address without registering the production migration.
vi.mock('../../../extensionManagement/browser/webExtensionsScannerService.js', () => ({ userExtensionsKey: 'extensions.user' }));

const storageProperty = `${'local'}Storage` as const;
const scope = StorageScope.PROFILE;
const target = StorageTarget.USER;
const physicalKey = (key: string) => STORAGE_PREFIX + storageKey(scope, key);
const area = window[storageProperty];
const disposables = new DisposableStore();

function storageEvent(key: string | null, newValue: string | null): void {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: area }));
}

function failSetItem(...failing: string[]): void {
  const original = window.Storage.prototype.setItem;
  vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(function (this: globalThis.Storage, key, value) {
    if (failing.includes(key)) {
      throw new DOMException('Quota is full', 'QuotaExceededError');
    }
    original.call(this, key, value);
  });
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
    let returnedDraft: Map<string, string> | undefined;
    const legacy = storageKey(scope, 'legacy');
    const current = storageKey(scope, 'current');
    disposables.add(registerStorageMigration(1, draft => {
      calls.push(1);
      returnedDraft = draft;
      draft.set(current, draft.get(legacy) + ' -> 2');
      draft.delete(legacy);
    }));
    disposables.add(registerStorageMigration(0, draft => {
      calls.push(0);
      draft.set(legacy, draft.get(legacy) + ' -> 1');
    }));
    area.setItem(physicalKey('legacy'), 'start');
    area.setItem(physicalKey('unrelated'), 'keep');

    const migrated = disposables.add(new BrowserStorageService(window, 2));
    const second = disposables.add(new BrowserStorageService(window, 2));
    expect(calls).toEqual([0, 1]);
    returnedDraft?.set(current, 'mutated draft');
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
    disposables.add(registerStorageMigration(4, draft => {
      draft.delete(storageKey(scope, 'saved'));
      draft.set(storageKey(scope, 'new'), 'partially migrated');
    }));
    disposables.add(registerStorageMigration(5, () => {
      throw new Error('migration failed');
    }));

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
    disposables.add(registerStorageMigration(8, draft => {
      draft.set(storageKey(scope, 'new'), 'migrated');
      draft.delete(storageKey(scope, 'saved'));
    }));
    failSetItem(STORAGE_VERSION_KEY);

    const storage = disposables.add(new BrowserStorageService(window, 9));
    expect(storage.get('new', scope)).toBeUndefined();
    expect(area.getItem(physicalKey('saved'))).toBe('original');
    expect(area.getItem(physicalKey('new'))).toBeNull();
    expect(area.getItem(STORAGE_VERSION_KEY)).toBe('8');
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('keeps restoring the other migration writes when one restore fails', () => {
    area.setItem(STORAGE_VERSION_KEY, '10');
    area.setItem(physicalKey('first'), 'one');
    area.setItem(physicalKey('second'), 'two');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    disposables.add(registerStorageMigration(10, draft => {
      draft.delete(storageKey(scope, 'first'));
      draft.delete(storageKey(scope, 'second'));
    }));
    failSetItem(STORAGE_VERSION_KEY, physicalKey('second'));

    disposables.add(new BrowserStorageService(window, 11));
    expect(area.getItem(physicalKey('first'))).toBe('one');
    expect(area.getItem(STORAGE_VERSION_KEY)).toBe('10');
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

describe('Work scope', () => {
  const workA = '12345678-abcd-4000-8000-123456789abc';
  const workB = '23456789-abcd-4000-8000-123456789abc';
  const workspace = StorageScope.WORKSPACE;
  const editor = 'editor:state';
  const workspaceKey = storageKey(workspace, editor);
  const legacyKey = STORAGE_PREFIX + workspaceKey;
  const workKey = (id: string) => `${STORAGE_PREFIX}work:${id}:${workspaceKey}`;

  function openWorkStorage(id: string): BrowserStorageService {
    const { href } = window.location;
    const { state } = window.history;
    try {
      window.history.replaceState(state, '', `?work=${id}`);
      return disposables.add(new BrowserStorageService());
    } finally {
      window.history.replaceState(state, '', href);
    }
  }

  test('restores only the active Work scope and preserves the legacy and shared key names', () => {
    const legacy = disposables.add(new BrowserStorageService());
    const first = openWorkStorage(workA);
    const second = openWorkStorage(workB);
    legacy.store(editor, 'legacy state', workspace, target);
    first.store(editor, 'state A', workspace, target);
    second.store(editor, 'state B', workspace, target);
    first.store('preferences', 'shared profile', scope, target);
    second.store('install', 'shared application', StorageScope.APPLICATION, target);
    void legacy.flush();
    void first.flush();
    void second.flush();

    expect(Object.keys(area).sort()).toEqual([
      'writing-room:storage:-1:install',
      'writing-room:storage:0:preferences',
      'writing-room:storage:1:editor:state',
      'writing-room:storage:version',
      `writing-room:storage:work:${workA}:1:editor:state`,
      `writing-room:storage:work:${workB}:1:editor:state`,
    ]);
    const reopened = openWorkStorage(workA);
    expect(reopened.get(editor, workspace)).toBe('state A');
    expect(openWorkStorage(workB).get(editor, workspace)).toBe('state B');
    expect(disposables.add(new BrowserStorageService()).get(editor, workspace)).toBe('legacy state');
    expect(reopened.get('preferences', scope)).toBe('shared profile');
    expect(reopened.get('install', StorageScope.APPLICATION)).toBe('shared application');

    area.setItem(workKey(workA), 'new state A');
    expect(reopened.getPersisted(editor, workspace)).toBe('new state A');
    reopened.storeImmediately(editor, (stored, snapshot) => {
      expect(stored).toBe('new state A');
      expect(snapshot.get(workspaceKey)).toBe(stored);
      return undefined;
    }, workspace, target);
    expect(area.getItem(workKey(workA))).toBeNull();
    expect(area.getItem(workKey(workB))).toBe('state B');
    expect(area.getItem(legacyKey)).toBe('legacy state');
  });

  test('counts persisted Profile, legacy and Work state once across the origin without exposing it in other Works', async () => {
    const owner = 'test.sample';
    const key = 'extensions.state.' + owner;
    const fullValue = 'x'.repeat(256 * 1024 - '{"value":""}'.length);
    const full = JSON.stringify({ value: fullValue });
    const small = '{"value":"a"}';
    const legacyPrefix = STORAGE_PREFIX + storageKey(workspace, '');
    const workPrefix = (id: string) => STORAGE_PREFIX + 'work:' + id + ':' + storageKey(workspace, '');

    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
    area.setItem(workPrefix(workA) + key, small);
    const first = openWorkStorage(workA);
    const firstState = disposables.add(new ExtensionStorage(first, {} as IFileService, {} as IWorkspaceContextService));
    const second = openWorkStorage(workB);
    const events = vi.fn();
    first.onDidChangeValue(workspace, undefined, disposables)(events);

    // Seed the physical backend without updating A's cache. Only the persisted data should decide the limit.
    area.setItem(workPrefix(workA) + key, full);
    const profilePrefix = STORAGE_PREFIX + storageKey(scope, '');
    for (const prefix of [profilePrefix, legacyPrefix, workPrefix(workA), workPrefix(workB)]) {
      area.setItem(prefix + 'extensions.state.test.first', full);
      if (prefix !== workPrefix(workA)) {
        area.setItem(prefix + 'extensions.state.test.second', full);
      }
    }
    const foreignKey = 'extensions.state.test.second';
    storageEvent(workPrefix(workB) + foreignKey, full);
    expect(second.get(foreignKey, workspace)).toBe(full);
    expect(first.get(foreignKey, workspace)).toBeUndefined();
    expect(events).not.toHaveBeenCalled();

    const update = (name: string, json: string | undefined) => firstState.update(owner, 'workspace', name, json, () => true);
    // At exactly 2 MiB, a new key would exceed the limit. The target itself must not be counted twice.
    await expect(firstState.update('test.new', 'global', 'value', '"x"', () => true)).rejects.toThrow('2 MiB');
    expect(first.get(key, workspace)).toBe(small);
    expect(area.getItem(workPrefix(workA) + key)).toBe(full);
    expect(first.usesMemory).toBe(false);
    await update('value', JSON.stringify(fullValue.slice(1)));
    await update('value', JSON.stringify(fullValue));
    area.setItem(legacyPrefix + 'extensions.state.test.over', small);
    await update('value', '"shorter"');
    expect(first.get(key, workspace)).toBe('{"value":"shorter"}');
    await update('value', undefined);
    expect(area.getItem(workPrefix(workA) + key)).toBeNull();
    expect(area.getItem(workPrefix(workB) + foreignKey)).toBe(full);
  });

  test('ignores other workspace events while a same-work event reads the latest persisted value', () => {
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
    area.setItem(workKey(workA), 'cached A');
    area.setItem(workKey(workB), 'cached B');
    area.setItem(legacyKey, 'cached legacy');
    const first = openWorkStorage(workA);
    const second = openWorkStorage(workB);
    const legacy = disposables.add(new BrowserStorageService());
    const change = vi.fn();
    first.onDidChangeValue(workspace, undefined, disposables)(change);

    area.setItem(workKey(workA), 'persisted A');
    area.setItem(workKey(workB), 'persisted B');
    storageEvent(workKey(workB), 'event B');
    area.setItem(legacyKey, 'persisted legacy');
    storageEvent(legacyKey, 'event legacy');
    expect(first.get(editor, workspace)).toBe('cached A');
    expect(change).not.toHaveBeenCalled();

    storageEvent(workKey(workA), 'stale event A');
    expect(first.get(editor, workspace)).toBe('persisted A');
    expect(second.get(editor, workspace)).toBe('persisted B');
    expect(legacy.get(editor, workspace)).toBe('persisted legacy');
    expect(change.mock.calls).toEqual([[{ scope: workspace, key: editor, target: undefined, external: true }]]);

    // The null-key event also rescans through the Work boundary.
    area.removeItem(workKey(workA));
    storageEvent(null, null);
    expect(first.get(editor, workspace)).toBeUndefined();
    expect(second.get(editor, workspace)).toBe('persisted B');
    expect(legacy.get(editor, workspace)).toBe('persisted legacy');
  });

  test('a Work window can migrate older legacy state without adopting its workspace keys', () => {
    area.setItem(STORAGE_VERSION_KEY, '1');
    area.setItem(legacyKey, 'old legacy state');
    disposables.add(registerStorageMigration(1, draft => {
      expect(draft.get(workspaceKey)).toBe('old legacy state');
      draft.set(workspaceKey, 'migrated legacy state');
    }));
    const work = openWorkStorage(workA);
    expect(work.usesMemory).toBe(false);
    expect(work.get(editor, workspace)).toBeUndefined();
    expect(area.getItem(legacyKey)).toBe('migrated legacy state');
    expect(area.getItem(workKey(workA))).toBeNull();
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

  test('waits until a hidden tab becomes visible before saving at idle again', () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const storage = disposables.add(new BrowserStorageService());
    const save = vi.fn();
    storage.onWillSaveState(save, undefined, disposables);

    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(save).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(2);
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
    // flush() is a no-op once disposed, so only the timer count shows that disposal cancelled the schedule.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('memory mode and persisted reads', () => {
  test('a service that opened the browser storage is not in memory mode', () => {
    const storage = disposables.add(new BrowserStorageService());
    expect(storage.usesMemory).toBe(false);
  });

  test('reads another tab\'s value before its storage event arrives, writes nothing and reads only that key', () => {
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
    area.setItem(physicalKey('unrelated'), 'other');
    const reader = disposables.add(new BrowserStorageService());
    const writer = disposables.add(new BrowserStorageService());
    const change = vi.fn();
    reader.onDidChangeValue(scope, undefined, disposables)(change);
    writer.store('shared', 'from writer', scope, target);
    void writer.flush();

    const read = vi.spyOn(window.Storage.prototype, 'getItem');
    const write = vi.spyOn(window.Storage.prototype, 'setItem');
    const remove = vi.spyOn(window.Storage.prototype, 'removeItem');
    expect(reader.getPersisted('shared', scope)).toBe('from writer');
    expect(reader.get('shared', scope)).toBe('from writer');
    expect(read.mock.calls).toEqual([[STORAGE_VERSION_KEY], [physicalKey('shared')]]);
    expect(change.mock.calls).toEqual([[{ scope, key: 'shared', target: undefined, external: true }]]);

    writer.remove('shared', scope);
    void writer.flush();
    remove.mockClear();
    expect(reader.getPersisted('shared', scope)).toBeUndefined();
    expect(reader.get('shared', scope)).toBeUndefined();
    expect(change).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test('does not mark an empty origin when reading', () => {
    const storage = disposables.add(new BrowserStorageService());
    expect(storage.getPersisted('missing', scope)).toBeUndefined();
    expect(area.length).toBe(0);
  });

  test('keeps a value this tab queued and persists it afterwards', async () => {
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
    const storage = disposables.add(new BrowserStorageService());
    storage.store('queued', 'local', scope, target);
    area.setItem(physicalKey('queued'), 'other tab');
    expect(storage.getPersisted('queued', scope)).toBe('local');
    await Promise.resolve();
    expect(area.getItem(physicalKey('queued'))).toBe('local');
  });

  test('throws when another tab moved the schema on while this tab persists', () => {
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
    const storage = disposables.add(new BrowserStorageService());
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION + 1));
    area.setItem(physicalKey('saved'), 'from newer build');
    expect(() => storage.getPersisted('saved', scope)).toThrow(/schema/);
    expect(storage.get('saved', scope)).toBeUndefined();
  });

  test('a blocked browser storage property puts the service in memory mode, and reads answer this tab without reopening it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getter = vi.spyOn(window, storageProperty, 'get').mockImplementation(() => {
      throw new DOMException('Access denied', 'SecurityError');
    });
    const storage = disposables.add(new BrowserStorageService());
    expect(storage.usesMemory).toBe(true);
    storage.store('key', 'session', scope, target);
    expect(storage.getPersisted('key', scope)).toBe('session');
    expect(storage.getPersisted('missing', scope)).toBeUndefined();
    expect(getter).toHaveBeenCalledTimes(1);
  });

  test('a newer saved schema puts the service in memory mode, and reads do not return the saved value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION + 1));
    area.setItem(physicalKey('future'), 'preserved');
    const storage = disposables.add(new BrowserStorageService());
    expect(storage.usesMemory).toBe(true);
    expect(storage.getPersisted('future', scope)).toBeUndefined();
  });

  test('a failed write puts the service in memory mode', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = disposables.add(new BrowserStorageService());
    failSetItem(physicalKey('key'));
    storage.store('key', 'session', scope, target);
    void storage.flush();
    expect(storage.usesMemory).toBe(true);
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    area.setItem(physicalKey('key'), 'other tab');
    expect(storage.getPersisted('key', scope)).toBe('session');
  });

  test('a schema change seen in a storage event puts the service in memory mode', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
    const storage = disposables.add(new BrowserStorageService());
    expect(storage.usesMemory).toBe(false);
    area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION + 1));
    storageEvent(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION + 1));
    expect(storage.usesMemory).toBe(true);
  });
});
