import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { InMemoryStorageDatabase } from '../../../../base/parts/storage/common/storage.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { BrowserStorageService, STORAGE_PREFIX } from '../../../services/storage/browser/storageService.js';
import { machineIdLockName, resolveMachineId } from '../../browser/mainThreadRuntime.js';
import type { MachineIdLock } from '../../browser/mainThreadRuntime.js';

const area = window[`${'local'}Storage` as const];
const savedKey = STORAGE_PREFIX + `${StorageScope.PROFILE}:extensions.machineId`;
const disposables = new DisposableStore();

/** A backend that cannot be opened, so the storage starts in memory mode. */
class BlockedDatabase extends InMemoryStorageDatabase {
  override getItems(): Map<string, string> {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  }
}

function serializingLock(): MachineIdLock & { readonly requests: string[] } {
  let tail = Promise.resolve();
  const requests: string[] = [];
  const lock = (name: string, callback: () => string) => {
    requests.push(name);
    const result = tail.then(callback);
    tail = result.then(() => {}, () => {});
    return result;
  };
  return Object.assign(lock, { requests });
}

/** Denies every request without calling back, as a browser that blocks site data does. */
const denyingLock = vi.fn<MachineIdLock>(() => Promise.reject(new DOMException('The request was denied.', 'SecurityError')));

beforeEach(() => area.clear());
afterEach(() => {
  disposables.clear();
  vi.restoreAllMocks();
  denyingLock.mockClear();
});

test('a denied Web Lock still answers, with one value for the page that is not saved', async () => {
  const storage = disposables.add(new BrowserStorageService());
  const first = await resolveMachineId(storage, denyingLock);
  const second = await resolveMachineId(storage, denyingLock);
  expect(first).toMatch(/\S/);
  expect(second).toBe(first);
  expect(denyingLock).toHaveBeenCalledTimes(2);
  expect(area.getItem(savedKey)).toBeNull();
});

test('in memory mode answers the page value without a lock or reopening the backend', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = disposables.add(new InMemoryStorageService(new BlockedDatabase()));
  const immediate = vi.spyOn(storage, 'storeImmediately');
  const lock = serializingLock();
  const [first, second] = await Promise.all([resolveMachineId(storage, lock), resolveMachineId(storage, lock)]);
  expect(first).toMatch(/\S/);
  expect(second).toBe(first);
  expect(await resolveMachineId(disposables.add(new BrowserStorageService()), denyingLock)).toBe(first);
  expect(lock.requests).toEqual([]);
  expect(immediate).not.toHaveBeenCalled();
});

test('uses the id this tab already holds, in any mode', async () => {
  const storage = disposables.add(new InMemoryStorageService());
  storage.store('extensions.machineId', 'saved-id', StorageScope.PROFILE, StorageTarget.MACHINE);
  const lock = serializingLock();
  expect(await resolveMachineId(storage, lock)).toBe('saved-id');
  expect(await resolveMachineId(storage, denyingLock)).toBe('saved-id');
  expect(lock.requests).toEqual([]);
});

test('saves a new id under the lock, and two tabs opening together agree on it', async () => {
  const lock = serializingLock();
  const first = disposables.add(new BrowserStorageService());
  const second = disposables.add(new BrowserStorageService());
  const [one, two] = await Promise.all([resolveMachineId(first, lock), resolveMachineId(second, lock)]);
  expect(one).toMatch(/\S/);
  expect(two).toBe(one);
  expect(area.getItem(savedKey)).toBe(one);
  expect(lock.requests).toEqual([machineIdLockName, machineIdLockName]);
});

test('answers the page value when saving the new id fails', async () => {
  const storage = disposables.add(new BrowserStorageService());
  vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota is full', 'QuotaExceededError');
  });
  const machineId = await resolveMachineId(storage, serializingLock());
  expect(machineId).toBe(await resolveMachineId(storage, denyingLock));
  expect(area.getItem(savedKey)).toBeNull();
});
