// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IndexedDB, idbRequest } from '../../../../base/browser/indexedDB.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { BrowserFileDatabase, IndexedDBFileSystemProvider } from '../../browser/indexedDBFileSystemProvider.js';
import {
  etag, FileChangeType, FileOperationResult, FileSystemProviderErrorCode, FileType,
} from '../../common/files.js';

const Code = FileSystemProviderErrorCode;
const schemes = [Schemas.vscodeVfs, Schemas.vscodeUserData];
const disposables = new DisposableStore();
const bytes = (text: string) => new TextEncoder().encode(text);
const resource = (path: string) => URI.from({ scheme: Schemas.vscodeVfs, authority: 'writing-room', path });
const write = { create: true, overwrite: true, createParents: true };
let name: string;

beforeEach(() => { name = 'test-files-' + crypto.randomUUID(); });
afterEach(() => {
  vi.restoreAllMocks();
  disposables.clear();
});

function setup(version = 1) {
  const warn = vi.fn();
  const open = vi.fn(() => IndexedDB.open(name, version, schemes));
  const database = disposables.add(new BrowserFileDatabase(open, warn));
  const provider = disposables.add(new IndexedDBFileSystemProvider(database, Schemas.vscodeVfs));
  return { database, open, provider, warn };
}

test('persists a file and a normalized empty folder across connections without alias keys', async () => {
  const first = setup();
  await first.provider.mkdir(resource('/workspace//folder/../empty/'), { recursive: true });
  await first.provider.writeFile(resource('/workspace//some/../a.md/'), bytes('hello'), write);
  first.provider.dispose();
  first.database.dispose();

  const second = setup();
  expect(await second.provider.readdir(resource('/workspace'))).toEqual([
    ['a.md', FileType.File], ['empty', FileType.Directory],
  ]);
  expect(await second.provider.readdir(resource('/workspace/empty'))).toEqual([]);
  expect(await second.provider.readFile(resource('/workspace/a.md'))).toEqual(bytes('hello'));

  const db = await second.database.get();
  expect(await db?.runInTransaction(Schemas.vscodeVfs, 'readonly', store => idbRequest(store.getAllKeys())))
    .toEqual(['/workspace', '/workspace/a.md', '/workspace/empty']);
});

test('uses one winning conditional write even with equal sizes and a fixed clock', async () => {
  const first = setup();
  const second = setup();
  const path = resource('/workspace/file.md');
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  await Promise.all([
    first.provider.mkdir(resource('/workspace'), { recursive: true }),
    second.provider.mkdir(resource('/workspace'), { recursive: true }),
  ]);
  await first.provider.writeFile(path, bytes('old'), write);
  const { stat, value } = await second.provider.readFileWithStat(path);
  expect(value).toEqual(bytes('old'));
  const options = { ...write, etag: etag(stat) };
  const results = await Promise.allSettled([
    first.provider.writeFile(path, bytes('one'), options),
    second.provider.writeFile(path, bytes('two'), options),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({
    reason: { fileOperationResult: FileOperationResult.FILE_MODIFIED_SINCE },
  });
  expect((await second.provider.stat(path)).mtime).toBe(1001);
});

test('rolls back a recursive rename on storage failure, keeps neighbors and maps a quota error', async () => {
  const { provider } = setup();
  const from = resource('/workspace/source');
  const to = resource('/workspace/target');
  await provider.writeFile(URI.joinPath(from, 'nested/a'), bytes('original'), write);
  await provider.mkdir(URI.joinPath(from, 'empty/'));
  await provider.writeFile(URI.joinPath(to, 'old'), bytes('existing'), write);
  await provider.writeFile(resource('/workspace/sources/untouched'), bytes('neighbor'), write);
  const changed = vi.fn();
  provider.onDidChangeFile(changed);
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (key === '/workspace/target/nested/a') {
      throw new DOMException('Injected quota failure', 'QuotaExceededError');
    }
    return put.call(this, value, key);
  });
  await expect(provider.rename(from, to, { overwrite: true })).rejects.toMatchObject({ code: Code.FileExceedsStorageQuota });
  expect(spy.mock.calls.length).toBeGreaterThan(1);
  expect(changed).not.toHaveBeenCalled();
  spy.mockRestore();
  expect(await provider.readFile(URI.joinPath(from, 'nested/a'))).toEqual(bytes('original'));
  expect(await provider.readFile(URI.joinPath(to, 'old'))).toEqual(bytes('existing'));
  await expect(provider.stat(URI.joinPath(to, 'nested'))).rejects.toMatchObject({ code: Code.FileNotFound });

  await provider.rename(from, to, { overwrite: true });
  expect(await provider.readFile(URI.joinPath(to, 'nested/a'))).toEqual(bytes('original'));
  expect(await provider.readdir(URI.joinPath(to, 'empty'))).toEqual([]);
  await expect(provider.stat(from)).rejects.toMatchObject({ code: Code.FileNotFound });
  await expect(provider.delete(to, { recursive: false })).rejects.toMatchObject({ code: Code.NoPermissions });
  const deleteRecord = IDBObjectStore.prototype.delete;
  const failDelete = vi.spyOn(IDBObjectStore.prototype, 'delete')
    .mockImplementation(function (this: IDBObjectStore, key) {
      if (key === '/workspace/target/nested') {
        throw new DOMException('Injected transaction failure', 'AbortError');
      }
      return deleteRecord.call(this, key);
    });
  await expect(provider.delete(to, { recursive: true })).rejects.toMatchObject({ code: Code.Unavailable });
  expect(failDelete.mock.calls.length).toBeGreaterThan(1);
  failDelete.mockRestore();
  expect(await provider.readdir(URI.joinPath(to, 'empty'))).toEqual([]);
  expect(await provider.readFile(URI.joinPath(to, 'nested/a'))).toEqual(bytes('original'));
  await provider.delete(to, { recursive: true });
  await expect(provider.stat(URI.joinPath(to, 'nested/a'))).rejects.toMatchObject({ code: Code.FileNotFound });
  expect(await provider.readFile(resource('/workspace/sources/untouched'))).toEqual(bytes('neighbor'));
  expect(changed).toHaveBeenCalledTimes(2);
});

test('rejects ambiguous and wrong-scope resources and bounds large reads before consuming the blob', async () => {
  const { provider } = setup();
  const file = resource('/workspace/file');
  await provider.writeFile(file, bytes('123'), write);
  const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
  await expect(provider.readFile(file, { limits: { size: 2 } })).rejects.toMatchObject({ code: Code.FileTooLarge });
  expect(read).not.toHaveBeenCalled();
  await expect(provider.writeFile(URI.joinPath(file, 'nested/a'), bytes('x'), write))
    .rejects.toMatchObject({ code: Code.FileNotADirectory });
  for (const unsafe of [
    URI.parse('vscode-vfs://writing-room/workspace%2Ffile'),
    URI.parse('vscode-vfs://writing-room/workspace/%252f'),
    URI.parse('vscode-vfs://writing-room/workspace/%0a'),
    file.with({ authority: 'other' }),
    file.with({ query: 'one' }),
    file.with({ scheme: Schemas.vscodeUserData, authority: '' }),
  ]) {
    await expect(provider.readFile(unsafe)).rejects.toMatchObject({ code: Code.NoPermissions });
  }
});

test('ignores invalid stored records and leaves a higher schema untouched during shared memory fallback', async () => {
  const newest = setup(2);
  const db = (await newest.database.get())!;
  const path = resource('/workspace/kept');
  await newest.provider.writeFile(path, bytes('newer'), write);
  await db.runInTransaction(Schemas.vscodeVfs, 'readwrite', async store => {
    await idbRequest(store.put({ type: FileType.File, size: 999 }, '/workspace/invalid'));
  });
  expect(await newest.provider.readdir(resource('/workspace'))).toEqual([['kept', FileType.File]]);
  const blocked = setup(1);
  const userData = disposables.add(new IndexedDBFileSystemProvider(blocked.database, Schemas.vscodeUserData));
  await Promise.all([
    blocked.provider.writeFile(path, bytes('memory'), write),
    userData.writeFile(URI.from({ scheme: Schemas.vscodeUserData, path: path.path }), bytes('other'), write),
  ]);
  expect(blocked.open).toHaveBeenCalledTimes(1);
  expect(blocked.warn).toHaveBeenCalledTimes(1);
  expect(await blocked.provider.readFile(path)).toEqual(bytes('memory'));
  expect(await newest.provider.readFile(path)).toEqual(bytes('newer'));
});

test('discards malformed tab messages and emits valid normalized paths', async () => {
  const { provider } = setup();
  await provider.stat(resource('/'));
  const sender = new BroadcastChannel('writing-room-files/vscode-vfs');
  try {
    const notified = new Promise<readonly string[]>(resolve => provider.onDidChangeFile(changes =>
      resolve(changes.map(change => change.resource.path))));
    sender.postMessage({ version: 2, changes: [{ path: '/workspace/future', type: FileChangeType.ADDED }] });
    sender.postMessage({ version: 1, changes: [{ path: '/workspace/../invalid', type: FileChangeType.ADDED }] });
    sender.postMessage({ version: 1, changes: [{ path: '/workspace/type', type: 'added' }] });
    sender.postMessage({ version: 1, changes: [{ path: '/workspace/valid', type: FileChangeType.ADDED }] });
    expect(await notified).toEqual(['/workspace/valid']);
  } finally {
    sender.close();
  }
});

test('reopens a closed database once and falls back after another tab upgrades it', async () => {
  const first = setup();
  const path = resource('/workspace/file');
  await first.provider.writeFile(path, bytes('original'), write);
  (await first.database.get())!.dispose();
  await Promise.all([first.provider.readFile(path), first.provider.stat(path)]);
  expect(first.open).toHaveBeenCalledTimes(2);
  expect(first.warn).not.toHaveBeenCalled();

  const newest = setup(2);
  await newest.provider.writeFile(path, bytes('version two'), write);
  await first.provider.writeFile(path, bytes('memory'), write);
  expect(await first.provider.readFile(path)).toEqual(bytes('memory'));
  expect(await newest.provider.readFile(path)).toEqual(bytes('version two'));
  expect(first.open).toHaveBeenCalledTimes(3);
  expect(first.warn).toHaveBeenCalledTimes(1);
});

test('times out a stalled open and closes any database that arrives late', async () => {

  const factory = Object.getOwnPropertyDescriptor(IDBFactory.prototype, 'open');
  // Capture the native fake request without connecting it to the factory's queue.
  const request = {} as IDBOpenDBRequest;
  Object.defineProperty(IDBFactory.prototype, 'open', {
    configurable: true, value: () => request,
  });
  const warn = vi.fn();
  const db = disposables.add(new BrowserFileDatabase(() => IndexedDB.open(name, 1, schemes, 10), warn));
  const provider = disposables.add(new IndexedDBFileSystemProvider(db, Schemas.vscodeVfs));
  try {
    await provider.mkdir(resource('/workspace'), { recursive: true });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('timed out') }));
    expect(await provider.readdir(resource('/workspace'))).toEqual([]);
    const close = vi.fn();
    Object.defineProperty(request, 'result', { value: { close } });
    request.onsuccess?.call(request, new Event('success'));
    expect(close).toHaveBeenCalledOnce();
  } finally {
    Object.defineProperty(IDBFactory.prototype, 'open', factory!);
  }
});

test('lists immediate children by cursor and removes invalid or orphaned records with their tree', async () => {
  const { database, provider } = setup();
  const root = resource('/workspace');
  const empty = URI.joinPath(root, 'empty');
  const from = URI.joinPath(root, 'from');
  const to = URI.joinPath(root, 'to');
  await provider.mkdir(empty, { recursive: true });
  await provider.writeFile(URI.joinPath(from, 'child/note'), bytes('good'), write);
  await provider.mkdir(URI.joinPath(root, 'from0'));
  const db = (await database.get())!;
  await db.runInTransaction(Schemas.vscodeVfs, 'readwrite', async store => {
    const orphan = { type: FileType.File, ctime: 1, mtime: 1, size: 1, bytes: new Blob(['x']) };
    await idbRequest(store.put({ type: FileType.File }, '/workspace/empty/invalid'));
    await idbRequest(store.put(orphan, '/workspace/empty/orphan/child'));
    await idbRequest(store.put(orphan, '/workspace/from/orphan/child'));
  });

  const scan = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys');
  expect(await provider.readdir(root)).toEqual([
    ['empty', FileType.Directory], ['from', FileType.Directory], ['from0', FileType.Directory],
  ]);
  expect(await provider.readdir(empty)).toEqual([]);
  expect(scan).not.toHaveBeenCalled();
  scan.mockRestore();
  await expect(provider.stat(URI.joinPath(empty, 'orphan/child'))).rejects.toMatchObject({ code: Code.FileNotFound });
  await provider.delete(empty, { recursive: false });
  await provider.rename(from, to, { overwrite: false });
  expect(await provider.readFile(URI.joinPath(to, 'child/note'))).toEqual(bytes('good'));
  expect(await db.runInTransaction(Schemas.vscodeVfs, 'readonly', store => idbRequest(store.getAllKeys())))
    .toEqual(['/workspace', '/workspace/from0', '/workspace/to', '/workspace/to/child', '/workspace/to/child/note']);
});

test('reserves settings.json for the configuration store', async () => {
  const { database } = setup();
  const userData = disposables.add(new IndexedDBFileSystemProvider(database, Schemas.vscodeUserData));
  const settings = URI.parse('vscode-userdata:/User/./settings.json');
  await expect(userData.stat(settings)).rejects.toMatchObject({ code: Code.NoPermissions });
  await expect(userData.writeFile(settings, bytes('{}'), write)).rejects.toMatchObject({ code: Code.NoPermissions });
  await expect(userData.mkdir(URI.joinPath(settings, 'child'), { recursive: true }))
    .rejects.toMatchObject({ code: Code.NoPermissions });
  await userData.writeFile(URI.parse('vscode-userdata:/User/globalStorage/test'), bytes('ok'), write);
});

test('says whether its files fall back to memory, for both schemes sharing the database', async () => {
  const opened = setup();
  expect(opened.provider.usesMemory).toBe(false);
  await opened.provider.writeFile(resource('/workspace/file'), bytes('kept'), write);
  expect(opened.provider.usesMemory).toBe(false);

  const warn = vi.fn();
  const blocked = disposables.add(new BrowserFileDatabase(() => Promise.reject(new DOMException('denied', 'UnknownError')), warn));
  const vfs = disposables.add(new IndexedDBFileSystemProvider(blocked, Schemas.vscodeVfs));
  const userData = disposables.add(new IndexedDBFileSystemProvider(blocked, Schemas.vscodeUserData));
  expect(vfs.usesMemory).toBe(false);
  await vfs.writeFile(resource('/workspace/file'), bytes('memory'), write);
  expect(vfs.usesMemory).toBe(true);
  expect(userData.usesMemory).toBe(true);
  expect(warn).toHaveBeenCalledTimes(1);
});

test('starts using memory when a closed database cannot be reopened after another tab upgrades it', async () => {
  const first = setup();
  const path = resource('/workspace/file');
  await first.provider.writeFile(path, bytes('original'), write);
  (await first.database.get())!.dispose();
  const newest = setup(2);
  await newest.provider.writeFile(path, bytes('version two'), write);
  expect(first.provider.usesMemory).toBe(false);
  await first.provider.writeFile(path, bytes('memory'), write);
  expect(first.provider.usesMemory).toBe(true);
  expect(newest.provider.usesMemory).toBe(false);
});
