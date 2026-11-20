import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InMemoryStorageDatabase } from '../../../../../base/parts/storage/common/storage.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService, STORAGE_SCHEMA_VERSION, STORAGE_VERSION_KEY } from '../../../storage/browser/storageService.js';
import { userExtensionsKey, WebExtensionsScannerService } from '../../browser/webExtensionsScannerService.js';
import type { InstalledListLocks } from '../../browser/webExtensionsScannerService.js';
import type { StoredWebExtension } from '../../common/extensionManagementService.js';

const area = window[`${'local'}Storage` as const];
const physicalKey = 'writing-room:storage:0:' + userExtensionsKey;
const disposables = new DisposableStore();
const manifest = (name: string, version = '1.0.0') => ({ name, publisher: 'tester', version, browser: 'web.js' });
const folderRecord = (name: string): StoredWebExtension => ({
  identifier: 'tester.' + name, location: 'http://127.0.0.1:5000/' + name + '/', manifest: manifest(name),
  installedAt: 1, source: 'location', version: '1.0.0',
});
const packageRecord = (name: string, location = 'vscode-userdata:/extensions/tester.' + name + '-1.0.0/') => ({
  identifier: 'tester.' + name, location, manifest: manifest(name), installedAt: 1, source: 'vsix',
  version: '1.0.0', packageSha256: 'a'.repeat(64), signature: 'unsigned',
});

beforeEach(() => area.clear());
afterEach(() => {
  disposables.clear();
  vi.restoreAllMocks();
});

test('migrates schema 1 records to records with a source and a version', () => {
  const v1 = { identifier: 'tester.old', location: 'http://127.0.0.1:5000/old/', manifest: manifest('old', '2.0.0'), installedAt: 5 };
  area.setItem(STORAGE_VERSION_KEY, '1');
  area.setItem(physicalKey, JSON.stringify([v1]));
  const storage = disposables.add(new BrowserStorageService());
  expect(STORAGE_SCHEMA_VERSION).toBe(2);
  expect(area.getItem(STORAGE_VERSION_KEY)).toBe('2');
  expect(new WebExtensionsScannerService(null, storage).scanUserExtensions())
    .toEqual([{ ...v1, source: 'location', version: '2.0.0' }]);
  expect(JSON.parse(area.getItem(physicalKey)!)).toEqual([{ ...v1, source: 'location', version: '2.0.0' }]);
});

test('keeps an unreadable schema 1 list as it was', () => {
  area.setItem(STORAGE_VERSION_KEY, '1');
  area.setItem(physicalKey, 'not json');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = disposables.add(new BrowserStorageService());
  expect(area.getItem(STORAGE_VERSION_KEY)).toBe('2');
  expect(area.getItem(physicalKey)).toBe('not json');
  expect(new WebExtensionsScannerService(null, storage).scanUserExtensions()).toEqual([]);
});

test('skips records whose location is not their own package folder or a folder URL', () => {
  const storage = new InMemoryStorageService();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  storage.store(userExtensionsKey, [
    packageRecord('good'),
    packageRecord('other', 'vscode-userdata:/extensions/tester.good-1.0.0/'),
    packageRecord('workspace', 'vscode-vfs://writing-room/workspace/'),
    packageRecord('data', 'vscode-userdata:/User/globalStorage/tester.data/'),
    packageRecord('remote', 'http://127.0.0.1:5000/remote/'),
    { ...packageRecord('nohash'), packageSha256: undefined },
    { ...folderRecord('version'), version: '9.9.9' },
    { ...folderRecord('local'), location: 'vscode-userdata:/extensions/tester.local-1.0.0/' },
    folderRecord('folder'),
  ], StorageScope.PROFILE, StorageTarget.USER);
  expect(new WebExtensionsScannerService(null, storage).scanUserExtensions().map(record => record.identifier))
    .toEqual(['tester.good', 'tester.folder']);
  expect(warn).toHaveBeenCalledTimes(7);
});

test('lower-cases the identifiers of schema 1 records, which were compared without case', () => {
  const v1 = { identifier: 'Tester.Old', location: 'http://127.0.0.1:5000/old/', manifest: manifest('old'), installedAt: 5 };
  area.setItem(STORAGE_VERSION_KEY, '1');
  area.setItem(physicalKey, JSON.stringify([v1]));
  const storage = disposables.add(new BrowserStorageService());
  expect(new WebExtensionsScannerService(null, storage).scanUserExtensions().map(record => record.identifier)).toEqual(['tester.old']);
});

test('names the locations of invalid records too, and none for an unreadable list', async () => {
  const storage = new InMemoryStorageService();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const scanner = new WebExtensionsScannerService(null, storage);
  storage.store(userExtensionsKey, [packageRecord('good'), { ...packageRecord('bad'), packageSha256: undefined }, 'junk'],
    StorageScope.PROFILE, StorageTarget.USER);
  await scanner.locked(async (read, _write, locations) => {
    expect(read().map(record => record.identifier)).toEqual(['tester.good']);
    expect(locations()).toEqual(new Set([packageRecord('good').location, packageRecord('bad').location]));
  });
  storage.store(userExtensionsKey, 'corrupt', StorageScope.PROFILE, StorageTarget.USER);
  await scanner.locked(async (read, _write, locations) => {
    expect(read()).toEqual([]);
    expect(locations()).toBeUndefined();
  });
  storage.remove(userExtensionsKey, StorageScope.PROFILE);
  await scanner.locked(async (_read, _write, locations) => expect(locations()).toEqual(new Set()));
});

function serializingLocks(): InstalledListLocks & { readonly requests: string[] } {
  let tail = Promise.resolve();
  const requests: string[] = [];
  return {
    requests,
    request(name, callback) {
      requests.push(name);
      const result = tail.then(callback);
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
}

test('a tab whose cache missed another tab write still keeps that record', async () => {
  const locks = serializingLocks();
  // Two workbench storages over one origin. Neither hears the other's storage events in this test.
  const first = new WebExtensionsScannerService(locks, disposables.add(new BrowserStorageService()));
  const second = new WebExtensionsScannerService(locks, disposables.add(new BrowserStorageService()));
  await first.locked(async (read, write) => write([...read(), folderRecord('one')]));
  expect(second.scanUserExtensions()).toEqual([]);
  await second.locked(async (read, write) => write([...read(), folderRecord('two')]));
  expect(JSON.parse(area.getItem(physicalKey)!).map((record: StoredWebExtension) => record.identifier))
    .toEqual(['tester.one', 'tester.two']);
  expect(locks.requests).toEqual(['writing-room:extensions.user', 'writing-room:extensions.user']);

  // A removal in one tab is seen by the other tab's next locked read, and the stale cached copy goes too.
  await first.locked(async (_read, write) => write([]));
  expect(area.getItem(physicalKey)).toBeNull();
  await second.locked(async read => expect(read()).toEqual([]));
  expect(second.scanUserExtensions()).toEqual([]);
});

test('holds the lock across the whole task so tabs do not interleave', async () => {
  const locks = serializingLocks();
  const first = new WebExtensionsScannerService(locks, disposables.add(new BrowserStorageService()));
  const second = new WebExtensionsScannerService(locks, disposables.add(new BrowserStorageService()));
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const one = first.locked(async (read, write) => {
    order.push('first read');
    const installed = read();
    await gate;
    await write([...installed, folderRecord('one')]);
    order.push('first write');
  });
  const two = second.locked(async (read, write) => {
    order.push('second read');
    await write([...read(), folderRecord('two')]);
  });
  await Promise.resolve();
  release();
  await Promise.all([one, two]);
  expect(order).toEqual(['first read', 'first write', 'second read']);
  expect(JSON.parse(area.getItem(physicalKey)!)).toHaveLength(2);
});

test('queues the tasks of one tab without Web Locks and refuses use after release', async () => {
  const scanner = new WebExtensionsScannerService(null, new InMemoryStorageService());
  let leaked: (() => readonly StoredWebExtension[]) | undefined;
  await Promise.all([
    scanner.locked(async (read, write) => {
      leaked = read;
      const installed = read();
      await new Promise(resolve => setTimeout(resolve, 5));
      await write([...installed, folderRecord('one')]);
    }),
    scanner.locked(async (read, write) => write([...read(), folderRecord('two')])),
  ]);
  expect(scanner.scanUserExtensions()).toHaveLength(2);
  expect(() => leaked!()).toThrow('released');
});

/** A backend that cannot be opened, so the storage starts in memory mode. */
class BlockedDatabase extends InMemoryStorageDatabase {
  override getItems(): Map<string, string> {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  }
}

/** Denies every request without calling back, as a browser that blocks site data does. */
function denyingLocks(): InstalledListLocks & { readonly requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    request(name) {
      requests.push(name);
      return Promise.reject(new DOMException('The request was denied.', 'SecurityError'));
    },
  };
}

function memoryStorage(): InMemoryStorageService {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return disposables.add(new InMemoryStorageService(new BlockedDatabase()));
}

test('in memory mode works on this tab\'s list without a Web Lock or reopening the backend', async () => {
  const storage = memoryStorage();
  const locks = denyingLocks();
  const scanner = new WebExtensionsScannerService(locks, storage);
  const immediate = vi.spyOn(storage, 'storeImmediately');
  expect(scanner.sessionOnly).toBe(true);

  await scanner.locked(async (read, write, locations) => {
    expect(read()).toEqual([]);
    expect(locations()).toBeUndefined();
    await write([folderRecord('one')]);
  });
  expect(scanner.scanUserExtensions()).toEqual([folderRecord('one')]);
  await scanner.locked(async (read, write) => {
    expect(read()).toEqual([folderRecord('one')]);
    await write([]);
  });
  expect(scanner.scanUserExtensions()).toEqual([]);
  expect(storage.get(userExtensionsKey, StorageScope.PROFILE)).toBeUndefined();
  expect(locks.requests).toEqual([]);
  expect(immediate).not.toHaveBeenCalled();
});

test('in memory mode still keeps the tasks of one tab in order', async () => {
  const scanner = new WebExtensionsScannerService(denyingLocks(), memoryStorage());
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const one = scanner.locked(async (read, write) => {
    order.push('first read');
    const installed = read();
    await gate;
    await write([...installed, folderRecord('one')]);
    order.push('first write');
  });
  const two = scanner.locked(async (read, write) => {
    order.push('second read');
    await write([...read(), folderRecord('two')]);
  });
  await Promise.resolve();
  release();
  await Promise.all([one, two]);
  expect(order).toEqual(['first read', 'first write', 'second read']);
  expect(scanner.scanUserExtensions()).toHaveLength(2);
});

test('a browser that blocks storage and Web Locks still keeps the list for the session', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const getter = vi.spyOn(window, `${'local'}Storage` as const, 'get').mockImplementation(() => {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  });
  const scanner = new WebExtensionsScannerService(denyingLocks(), disposables.add(new BrowserStorageService()));
  await scanner.locked(async (read, write) => write([...read(), folderRecord('one')]));
  expect(scanner.scanUserExtensions()).toEqual([folderRecord('one')]);
  expect(getter).toHaveBeenCalledTimes(1);
});

test('while persistent takes the Web Lock, and a locked read writes nothing', async () => {
  area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
  area.setItem(physicalKey, JSON.stringify([folderRecord('one')]));
  const locks = serializingLocks();
  const scanner = new WebExtensionsScannerService(locks, disposables.add(new BrowserStorageService()));
  expect(scanner.sessionOnly).toBe(false);
  const set = vi.spyOn(window.Storage.prototype, 'setItem');
  const remove = vi.spyOn(window.Storage.prototype, 'removeItem');
  await scanner.locked(async (read, _write, locations) => {
    expect(read()).toEqual([folderRecord('one')]);
    expect(locations()).toEqual(new Set([folderRecord('one').location]));
  });
  expect(locks.requests).toEqual(['writing-room:extensions.user']);
  expect(set).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test('while persistent a denied Web Lock fails the task', async () => {
  const scanner = new WebExtensionsScannerService(denyingLocks(), disposables.add(new BrowserStorageService()));
  const task = vi.fn(async () => {});
  await expect(scanner.locked(task)).rejects.toThrow('denied');
  expect(task).not.toHaveBeenCalled();
});

test('while persistent a failed write of the empty list is reported', async () => {
  area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
  area.setItem(physicalKey, JSON.stringify([folderRecord('one')]));
  const scanner = new WebExtensionsScannerService(null, disposables.add(new BrowserStorageService()));
  const original = window.Storage.prototype.setItem;
  vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(function (this: globalThis.Storage, key, value) {
    if (key === physicalKey) {
      throw new DOMException('Quota is full', 'QuotaExceededError');
    }
    original.call(this, key, value);
  });
  await expect(scanner.locked(async (_read, write) => write([]))).rejects.toThrow('Quota');
  expect(JSON.parse(area.getItem(physicalKey)!)).toEqual([folderRecord('one')]);
});

test('a task that read while persistent and writes after the storage fell back keeps the list in this tab', async () => {
  area.setItem(STORAGE_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
  area.setItem(physicalKey, JSON.stringify([folderRecord('one')]));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = disposables.add(new BrowserStorageService());
  const scanner = new WebExtensionsScannerService(serializingLocks(), storage);
  await scanner.locked(async (read, write, locations) => {
    const installed = read();
    vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota is full', 'QuotaExceededError');
    });
    storage.store('other', 'value', StorageScope.PROFILE, StorageTarget.USER);
    void storage.flush();
    expect(scanner.sessionOnly).toBe(true);
    await write([...installed, folderRecord('two')]);
    expect(locations()).toBeUndefined();
  });
  expect(scanner.scanUserExtensions().map(record => record.identifier)).toEqual(['tester.one', 'tester.two']);
  expect(JSON.parse(area.getItem(physicalKey)!)).toEqual([folderRecord('one')]);
});
