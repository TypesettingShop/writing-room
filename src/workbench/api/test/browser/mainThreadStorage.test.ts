import { expect, test, vi } from 'vitest';
import { Schemas } from '../../../../base/common/network.js';
import { InMemoryStorageDatabase } from '../../../../base/parts/storage/common/storage.js';
import { BrowserFileDatabase, IndexedDBFileSystemProvider } from '../../../../platform/files/browser/indexedDBFileSystemProvider.js';
import type { IFileService, IFileSystemProvider } from '../../../../platform/files/common/files.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { extensionGlobalStorageUri, extensionLogUri, extensionWorkspaceStorageUri } from '../../../services/extensions/common/extensionStoragePaths.js';
import { ExtensionStorage } from '../../browser/mainThreadStorage.js';

test('rejects per-extension and aggregate overflow without changing old state', async () => {
  const storage = new InMemoryStorageService();
  const state = new ExtensionStorage(storage, {} as IFileService, {} as IWorkspaceContextService);
  const write = (id: string, name: string, json: string) => state.update(id, 'global', name, json, () => true);
  try {
    await Promise.all([write('test.first', 'one', '1'), write('test.first', 'two', '2')]);
    await expect(write('test.first', 'one', JSON.stringify('한'.repeat(100_000)))).rejects.toThrow('256 KiB');
    expect(JSON.parse(state.read('test.first', 'global'))).toEqual({ one: 1, two: 2 });

    const value = JSON.stringify('x'.repeat(250 * 1024));
    await Promise.all(Array.from({ length: 8 }, (_, index) => write(`test.large${index}`, 'value', value)));
    await expect(write('test.first', 'another', value)).rejects.toThrow('2 MiB');
    expect(JSON.parse(state.read('test.first', 'global'))).toEqual({ one: 1, two: 2 });
    expect(storage.get('extensions.state.test.first', StorageScope.WORKSPACE)).toBeUndefined();
  } finally {
    state.dispose();
    storage.dispose();
  }
});

test('rejects a late writer from an uninstalled generation', async () => {
  const storage = new InMemoryStorageService();
  const state = new ExtensionStorage(storage, {} as IFileService, {} as IWorkspaceContextService);
  const installation = { identifier: 'test.sample', installedAt: 1, location: 'https://example.test/' };
  try {
    storage.storeImmediately('extensions.user', JSON.stringify([installation]), StorageScope.PROFILE, StorageTarget.USER);
    await state.update(installation.identifier, 'global', 'name', '"before"', () => true, installation);
    storage.storeImmediately('extensions.user', '[]', StorageScope.PROFILE, StorageTarget.USER);
    await expect(state.update(installation.identifier, 'global', 'name', '"after"', () => true, installation))
      .rejects.toThrow('is no longer installed');
    expect(JSON.parse(state.read(installation.identifier, 'global'))).toEqual({ name: 'before' });
  } finally {
    state.dispose();
    storage.dispose();
  }
});

test('queues a second write before it requests the browser lock', async () => {
  const storage = new InMemoryStorageService();
  const state = new ExtensionStorage(storage, {} as IFileService, {} as IWorkspaceContextService);
  let allowFirst!: () => void;
  const held = new Promise<void>(resolve => { allowFirst = resolve; });
  let calls = 0;
  const request = vi.fn(async (_name: string, callback: () => Promise<void>) => {
    if (++calls === 1) {
      await held;
    }
    return callback();
  });
  vi.stubGlobal('navigator', { locks: { request } });
  const first = state.update('test.sample', 'global', 'key', '"first"', () => true);
  const second = state.update('test.sample', 'global', 'key', '"second"', () => true);
  try {
    await Promise.resolve();
    expect(request).toHaveBeenCalledExactlyOnceWith('writing-room:extensions.state', expect.any(Function));
    expect(state.read('test.sample', 'global')).toBe('{}');
    allowFirst();
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(state.read('test.sample', 'global'))).toEqual({ key: 'second' });
  } finally {
    allowFirst();
    await Promise.allSettled([first, second]);
    vi.unstubAllGlobals();
    state.dispose();
    storage.dispose();
  }
});

/** A storage backend that cannot be opened, so the storage starts in memory mode. */
class BlockedDatabase extends InMemoryStorageDatabase {
  override getItems(): Map<string, string> {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  }
}

const workspace = { getWorkspace: () => ({ id: 'workspace-id' }) } as IWorkspaceContextService;
const extensionId = 'test.sample';
const folders = [extensionGlobalStorageUri(extensionId), extensionWorkspaceStorageUri('workspace-id', extensionId), extensionLogUri(extensionId)];

async function clearSetup(storage: InMemoryStorageService, provider: IFileSystemProvider) {
  const files = new FileService();
  files.registerProvider(Schemas.vscodeUserData, provider);
  const state = new ExtensionStorage(storage, files, workspace);
  // Written directly: a state update is still refused in memory mode.
  storage.store('extensions.state.' + extensionId, '{"name":"global"}', StorageScope.PROFILE, StorageTarget.USER);
  storage.store('extensions.state.' + extensionId, '{"name":"workspace"}', StorageScope.WORKSPACE, StorageTarget.USER);
  state.setSecret(extensionId, 'token', 'secret');
  for (const folder of folders) {
    await files.writeFile(folder.with({ path: folder.path + '/file' }), new Uint8Array([1]));
  }
  const exists = async () => Promise.all(folders.map(folder => files.exists(folder)));
  return { files, state, exists };
}

function denyLocks() {
  const request = vi.fn(() => Promise.reject(new DOMException('The request was denied.', 'SecurityError')));
  vi.stubGlobal('navigator', { locks: { request } });
  return request;
}

test('in a window that blocks storage, clearing removes this tab\'s state, secrets and session folders without a lock', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = new InMemoryStorageService(new BlockedDatabase());
  const provider = new IndexedDBFileSystemProvider(new BrowserFileDatabase(() => Promise.reject(new Error('blocked')), () => {}), Schemas.vscodeUserData);
  const { state, exists } = await clearSetup(storage, provider);
  const request = denyLocks();
  const immediate = vi.spyOn(storage, 'storeImmediately');
  try {
    expect(JSON.parse(state.read(extensionId, 'global'))).toEqual({ name: 'global' });
    await expect(state.clear(extensionId)).resolves.toBeUndefined();
    expect(storage.get('extensions.state.' + extensionId, StorageScope.PROFILE)).toBeUndefined();
    expect(storage.get('extensions.state.' + extensionId, StorageScope.WORKSPACE)).toBeUndefined();
    expect(state.getSecret(extensionId, 'token')).toBeUndefined();
    expect(await exists()).toEqual([false, false, false]);
    expect(request).not.toHaveBeenCalled();
    expect(immediate).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});

test('in memory mode with persistent files, clearing keeps the storage folders the persisted list may still use', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = new InMemoryStorageService(new BlockedDatabase());
  const { state, exists } = await clearSetup(storage, new InMemoryFileSystemProvider());
  const request = denyLocks();
  try {
    await state.clear(extensionId);
    expect(request).not.toHaveBeenCalled();
    expect(storage.get('extensions.state.' + extensionId, StorageScope.PROFILE)).toBeUndefined();
    expect(state.getSecret(extensionId, 'token')).toBeUndefined();
    expect(await exists()).toEqual([true, true, true]);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});

test('while persistent, clearing takes the lock, removes the saved state and the storage folders', async () => {
  const storage = new InMemoryStorageService();
  const { state, exists } = await clearSetup(storage, new InMemoryFileSystemProvider());
  const request = vi.fn(async (_name: string, callback: () => Promise<void>) => callback());
  vi.stubGlobal('navigator', { locks: { request } });
  const immediate = vi.spyOn(storage, 'storeImmediately');
  try {
    expect(JSON.parse(state.read(extensionId, 'global'))).toEqual({ name: 'global' });
    await state.clear(extensionId);
    expect(request).toHaveBeenCalledExactlyOnceWith('writing-room:extensions.state', expect.any(Function));
    expect(immediate).toHaveBeenCalledTimes(2);
    expect(storage.get('extensions.state.' + extensionId, StorageScope.PROFILE)).toBeUndefined();
    expect(storage.get('extensions.state.' + extensionId, StorageScope.WORKSPACE)).toBeUndefined();
    expect(await exists()).toEqual([false, false, false]);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});

test('in memory mode a state update, which still reaches the persistent backend, keeps the cross-tab lock', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  class FailingWrites extends InMemoryStorageDatabase {
    fail = false;
    override updateItems(update: Parameters<InMemoryStorageDatabase['updateItems']>[0]): void {
      if (this.fail) {
        throw new Error('quota exceeded');
      }
      super.updateItems(update);
    }
  }
  const database = new FailingWrites();
  const storage = new InMemoryStorageService(database);
  database.fail = true;
  storage.store('unrelated', 'value', StorageScope.PROFILE, StorageTarget.USER);
  void storage.flush();
  database.fail = false;
  expect(storage.usesMemory).toBe(true);
  const state = new ExtensionStorage(storage, {} as IFileService, workspace);
  const request = vi.fn(async (_name: string, callback: () => Promise<void>) => callback());
  vi.stubGlobal('navigator', { locks: { request } });
  try {
    await state.update('test.builtin', 'global', 'key', '1', () => true);
    expect(request).toHaveBeenCalledExactlyOnceWith('writing-room:extensions.state', expect.any(Function));
    expect(database.getItems().get(`${StorageScope.PROFILE}:extensions.state.test.builtin`)).toBe('{"key":1}');
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});
