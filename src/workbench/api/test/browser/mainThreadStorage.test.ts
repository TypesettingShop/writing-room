import { expect, test, vi } from 'vitest';
import { Schemas } from '../../../../base/common/network.js';
import { InMemoryStorageDatabase } from '../../../../base/parts/storage/common/storage.js';
import { BrowserFileDatabase, IndexedDBFileSystemProvider } from '../../../../platform/files/browser/indexedDBFileSystemProvider.js';
import type { IFileService, IFileSystemProvider } from '../../../../platform/files/common/files.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InMemoryStorageService, StorageScope, StorageTarget, storageKey } from '../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { extensionGlobalStorageUri, extensionLogUri, extensionWorkspaceStorageUri } from '../../../services/extensions/common/extensionStoragePaths.js';
import { ExtensionStorage, MainThreadStorage } from '../../browser/mainThreadStorage.js';

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
  // Seed both scopes directly so this setup only exercises clearing.
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

class FailingWrites extends InMemoryStorageDatabase {
  fail = false;

  override updateItems(update: Parameters<InMemoryStorageDatabase['updateItems']>[0]): void {
    if (this.fail) {
      throw new Error('quota exceeded');
    }
    super.updateItems(update);
  }
}

function fallBackAfterWriteFailure(storage: InMemoryStorageService, database: FailingWrites): void {
  database.fail = true;
  storage.store('unrelated', 'value', StorageScope.PROFILE, StorageTarget.USER);
  void storage.flush();
  database.fail = false;
  expect(storage.usesMemory).toBe(true);
}

const profile = StorageScope.PROFILE;
const workspaceScope = StorageScope.WORKSPACE;
const target = StorageTarget.USER;
const stateKey = 'extensions.state.' + extensionId;
const installation = { identifier: extensionId, installedAt: 1, location: 'https://example.test/' };

test('after a quota fallback, session, built-in and previously installed extensions write only to this tab', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const database = new FailingWrites();
  const storage = new InMemoryStorageService(database);
  const state = new ExtensionStorage(storage, {} as IFileService, workspace);
  const request = vi.fn(async (_name: string, callback: () => Promise<void>) => callback());
  vi.stubGlobal('navigator', { locks: { request } });
  const previous = { ...installation, identifier: 'test.persisted' };
  const previousKey = 'extensions.state.' + previous.identifier;
  const previousList = JSON.stringify([previous]);
  const previousState = '{"name":"persisted"}';
  try {
    storage.storeImmediately('extensions.user', previousList, profile, target);
    storage.storeImmediately(previousKey, previousState, profile, target);
    fallBackAfterWriteFailure(storage, database);
    storage.store('extensions.user', JSON.stringify([previous, installation]), profile, target);
    const immediate = vi.spyOn(storage, 'storeImmediately');
    const open = vi.spyOn(database, 'getItems');
    const write = vi.spyOn(database, 'updateItems');

    await state.update(extensionId, 'global', 'key', '1', () => true, installation);
    await state.update(extensionId, 'workspace', 'key', '2', () => true, installation);
    await state.update('test.builtin', 'global', 'key', '3', () => true);
    await state.update(previous.identifier, 'global', 'name', '"session"', () => true, previous);
    expect(state.read(extensionId, 'global')).toBe('{"key":1}');
    expect(state.read(extensionId, 'workspace')).toBe('{"key":2}');
    expect(state.read('test.builtin', 'global')).toBe('{"key":3}');
    expect(state.read(previous.identifier, 'global')).toBe('{"name":"session"}');
    expect(request).not.toHaveBeenCalled();
    expect(immediate).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(database.getItems()).toEqual(new Map([
      [storageKey(profile, 'extensions.user'), previousList],
      [storageKey(profile, previousKey), previousState],
    ]));
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});

test('with a blocked backend and denied locks, the host receives ordered writes and clearing removes both scopes', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const database = new BlockedDatabase();
  const open = vi.spyOn(database, 'getItems');
  const storage = new InMemoryStorageService(database);
  const { files, state } = await clearSetup(storage, new InMemoryFileSystemProvider());
  const request = denyLocks();
  const acceptState = vi.fn();
  const extension: HostExtensionDescription = {
    id: extensionId, key: 'session', location: installation.location, entry: 'extension.js',
    manifest: { publisher: 'test', name: 'sample', version: '1.0.0' }, activationEvents: [],
  };
  const host = new MainThreadStorage(state, key => key === extension.key ? extension : undefined,
    { $acceptState: acceptState, $acceptSecretChange: vi.fn() }, () => [installation]);
  try {
    storage.store('extensions.user', JSON.stringify([installation]), profile, target);
    await host.$initialize(extension.key);
    await Promise.all([
      host.$update(extension.key, 'global', 'name', '"first"'),
      host.$update(extension.key, 'global', 'name', '"second"'),
      host.$update(extension.key, 'workspace', 'name', '"session"'),
    ]);
    expect(acceptState.mock.calls).toEqual([
      [extension.key, 'global', '{"name":"first"}'],
      [extension.key, 'global', '{"name":"second"}'],
      [extension.key, 'workspace', '{"name":"session"}'],
    ]);

    await state.update('test.builtin', 'global', 'key', '1', () => true);
    expect(state.read('test.builtin', 'global')).toBe('{"key":1}');
    await state.update('test.builtin', 'global', 'key', undefined, () => true);
    expect(storage.get('extensions.state.test.builtin', profile)).toBeUndefined();

    await state.clear(extensionId);
    expect(storage.get(stateKey, profile)).toBeUndefined();
    expect(storage.get(stateKey, workspaceScope)).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    host.dispose();
    state.dispose();
    files.dispose();
    storage.dispose();
  }
});

test('memory mode rejects late writes after removal and replacement of an installation', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = new InMemoryStorageService(new BlockedDatabase());
  const state = new ExtensionStorage(storage, {} as IFileService, workspace);
  const install = (records: (typeof installation)[]) =>
    storage.store('extensions.user', JSON.stringify(records), profile, target);
  const update = (json: string, record = installation) =>
    state.update(extensionId, 'global', 'key', json, () => true, record);
  try {
    install([installation]);
    await update('1');
    install([]);
    await expect(update('2')).rejects.toThrow('is no longer installed');
    expect(state.read(extensionId, 'global')).toBe('{"key":1}');

    const replacement = { ...installation, installedAt: 2 };
    install([replacement]);
    await update('3', replacement);
    await expect(update('4')).rejects.toThrow('is no longer installed');
    expect(state.read(extensionId, 'global')).toBe('{"key":3}');
  } finally {
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});

test('in memory mode an update after the storage closed rejects, as it does while persistent', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = new InMemoryStorageService(new BlockedDatabase());
  const state = new ExtensionStorage(storage, {} as IFileService, workspace);
  try {
    await state.update(extensionId, 'global', 'key', '1', () => true);
    storage.dispose();
    await expect(state.update(extensionId, 'global', 'key', '2', () => true)).rejects.toThrow('Workbench storage is closed.');
    await expect(state.update(extensionId, 'global', 'key', undefined, () => true)).rejects.toThrow('Workbench storage is closed.');
    expect(state.read(extensionId, 'global')).toBe('{"key":1}');
  } finally {
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});

test('memory mode counts cached state across both scopes and allows a write that shrinks an over-limit total', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const database = new FailingWrites();
  const storage = new InMemoryStorageService(database);
  const state = new ExtensionStorage(storage, {} as IFileService, workspace);
  const update = (value: string) => state.update(extensionId, 'global', 'value', JSON.stringify(value), () => true);
  const limit = 256 * 1024;
  const boundary = 'abcdefgh';
  const fullState = (size: number) => JSON.stringify({ value: 'x'.repeat(size - '{"value":""}'.length) });
  try {
    // Seed persisted state before the fallback. The workspace entry for the same extension also counts.
    for (let index = 0; index < 7; index++) {
      storage.storeImmediately('extensions.state.older' + index, fullState(limit), profile, target);
    }
    const workspaceSize = limit - JSON.stringify({ value: boundary }).length;
    storage.storeImmediately(stateKey, fullState(workspaceSize - 20), workspaceScope, target);
    storage.storeImmediately(stateKey, '{"value":"x"}', profile, target);
    fallBackAfterWriteFailure(storage, database);
    storage.store(stateKey, fullState(workspaceSize), workspaceScope, target);
    storage.store('extensions.state.ignored', fullState(limit), StorageScope.APPLICATION, target);
    storage.store('other', fullState(limit), profile, target);

    await update(boundary);
    await expect(update(boundary + 'x')).rejects.toThrow('2 MiB');
    await expect(update('한'.repeat(100_000))).rejects.toThrow('256 KiB');
    expect(state.read(extensionId, 'global')).toBe('{"value":"abcdefgh"}');

    storage.store('extensions.state.existing', '{"value":"over"}', workspaceScope, target);
    await update('shorter');
    expect(state.read(extensionId, 'global')).toBe('{"value":"shorter"}');
  } finally {
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});

test.each([false, true])('a write uses the cache after a quota fallback (while waiting for a lock: %s)', async inLock => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const database = new FailingWrites();
  const storage = new InMemoryStorageService(database);
  const state = new ExtensionStorage(storage, {} as IFileService, workspace);
  const request = vi.fn(async (_name: string, callback: () => Promise<void>) => {
    await Promise.resolve();
    fallBackAfterWriteFailure(storage, database);
    return callback();
  });
  vi.stubGlobal('navigator', { locks: { request } });
  const immediate = vi.spyOn(storage, 'storeImmediately');
  try {
    const result = state.update(extensionId, 'global', 'key', '1', () => true);
    if (!inLock) {
      fallBackAfterWriteFailure(storage, database);
    }
    await result;
    expect(request).toHaveBeenCalledTimes(inLock ? 1 : 0);
    expect(immediate).not.toHaveBeenCalled();
    expect(database.getItems().has(storageKey(profile, stateKey))).toBe(false);
    expect(state.read(extensionId, 'global')).toBe('{"key":1}');
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});

test('persistent state writes take the cross-tab lock and a backend write error rejects the update', async () => {
  const database = new FailingWrites();
  const storage = new InMemoryStorageService(database);
  const state = new ExtensionStorage(storage, {} as IFileService, workspace);
  const immediate = vi.spyOn(storage, 'storeImmediately');
  const request = vi.fn(async (_name: string, callback: () => Promise<void>) => {
    expect(immediate).not.toHaveBeenCalled();
    return callback();
  });
  vi.stubGlobal('navigator', { locks: { request } });
  try {
    database.fail = true;
    await expect(state.update(extensionId, 'global', 'key', '1', () => true)).rejects.toThrow('quota exceeded');
    expect(request).toHaveBeenCalledExactlyOnceWith('writing-room:extensions.state', expect.any(Function));
    expect(immediate).toHaveBeenCalledExactlyOnceWith(stateKey, expect.any(Function), profile, target);
    expect(state.read(extensionId, 'global')).toBe('{}');
    expect(storage.usesMemory).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.dispose();
    storage.dispose();
  }
});

test('while persistent, a state write checks the installation and the total against what another tab saved', async () => {
  const database = new InMemoryStorageDatabase();
  const storage = new InMemoryStorageService(database);
  const state = new ExtensionStorage(storage, {} as IFileService, workspace);
  // Written straight to the backend, as another tab would: this tab's cache does not see it.
  const writeFromOtherTab = (key: string, value: string, scope = profile) =>
    database.updateItems({ insert: new Map([[storageKey(scope, key), value]]), delete: new Set() });
  try {
    storage.storeImmediately('extensions.user', JSON.stringify([installation]), profile, target);
    await state.update(extensionId, 'global', 'key', '1', () => true, installation);
    writeFromOtherTab('extensions.user', '[]');
    await expect(state.update(extensionId, 'global', 'key', '2', () => true, installation))
      .rejects.toThrow('is no longer installed');
    expect(state.read(extensionId, 'global')).toBe('{"key":1}');

    // Neither scope alone passes 2 MiB, so both have to be counted.
    const large = JSON.stringify({ value: 'x'.repeat(250 * 1024) });
    for (let index = 0; index < 9; index++) {
      writeFromOtherTab('extensions.state.test.large' + index, large, index < 4 ? profile : workspaceScope);
    }
    await expect(state.update('test.builtin', 'global', 'key', '1', () => true)).rejects.toThrow('2 MiB');
    expect(state.read('test.builtin', 'global')).toBe('{}');
  } finally {
    state.dispose();
    storage.dispose();
  }
});
