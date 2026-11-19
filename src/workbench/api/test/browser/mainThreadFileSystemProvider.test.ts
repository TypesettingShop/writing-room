// @vitest-environment node
import type * as vscode from 'vscode';
import { afterEach, expect, test } from 'vitest';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { FileSystemProviderCapabilities, FileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { NullExtensionService } from '../../../services/extensions/common/extensions.js';
import { MainThreadFileSystem } from '../../browser/mainThreadFileSystem.js';
import { ExtHostFileSystemProviderProxy, ExtHostFileSystemProxy, MainThreadFileSystemProxy } from '../../common/extHost.protocol.fileSystem.js';
import { FileSystemError } from '../../common/extHostFileSystemConsumer.js';
import { ExtHostFileSystemProvider } from '../../common/extHostFileSystemProvider.js';
import { createTestRpcPair } from '../common/testExtensionHost.js';

const disposables = new DisposableStore();
const scheme = 'mem-test';
const root = URI.parse(scheme + ':/');
const file = URI.joinPath(root, 'file.txt');
const owner: HostExtensionDescription = {
  id: 'test.owner', key: 'owner', location: '', entry: '', activationEvents: [],
  manifest: { name: 'owner', publisher: 'test', version: '1.0.0' },
};

function connect(files: FileService) {
  const pair = disposables.add(createTestRpcPair());
  const main = disposables.add(new MainThreadFileSystem(
    pair.main.getProxy(ExtHostFileSystemProxy), pair.main.getProxy(ExtHostFileSystemProviderProxy),
    key => key === owner.key || key === 'peer' ? { ...owner, key } : undefined,
    files, {
      _serviceBrand: undefined, getWorkspace: () => ({ id: 'writing-room', folders: [] }),
      getWorkbenchState: () => WorkbenchState.EMPTY, getWorkspaceFolder: () => null, onDidChangeWorkspaceFolders: Event.None,
    }, new NullExtensionService(), async () => {},
  ));
  pair.main.set(MainThreadFileSystemProxy, main);
  const proxy = pair.worker.getProxy(MainThreadFileSystemProxy);
  const worker = disposables.add(new ExtHostFileSystemProvider(proxy, () => undefined));
  pair.worker.set(ExtHostFileSystemProviderProxy, worker);
  return { main, proxy, worker };
}

function provider(stat: vscode.FileSystemProvider['stat'], watch: vscode.FileSystemProvider['watch'] = () => ({ dispose() {} })):
  vscode.FileSystemProvider {
  return {
    stat, watch, onDidChangeFile: Event.None, readDirectory: () => [], readFile: () => Uint8Array.of(4),
    createDirectory() {}, writeFile() {}, delete() {}, rename() {},
  };
}

afterEach(() => disposables.clear());

test('provider ownership is enforced on the main thread and removal rejects a pending request', async () => {
  const files = disposables.add(new FileService());
  const { main, proxy, worker } = connect(files);
  let arrived!: () => void;
  const began = new Promise<void>(resolve => { arrived = resolve; });
  let watchCount = 0;
  const registration = worker.register(owner.key, scheme, provider(() => {
    arrived();
    return new Promise(() => {});
  }, () => {
    watchCount++;
    return { dispose() { watchCount--; } };
  }), { isCaseSensitive: true });
  await proxy.$initializeFileSystem();
  expect(files.getProvider(scheme)?.capabilities).toBe(
    FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive);
  await expect(proxy.$registerFileSystemProvider('peer', 20, 'VSCODE-VFS', FileSystemProviderCapabilities.FileReadWrite)).rejects.toThrow('reserved');
  await expect(proxy.$registerFileSystemProvider('peer', 20, scheme, FileSystemProviderCapabilities.FileReadWrite)).rejects.toThrow('already registered');
  await proxy.$unregisterFileSystemProvider('peer', 0);
  expect(files.hasProvider(root)).toBe(true);

  const watch = files.watch(root);
  const pending = files.stat(file);
  const rejected = expect(pending).rejects.toMatchObject({ code: FileSystemProviderErrorCode.Unavailable });
  await began;
  expect(watchCount).toBe(1);
  main.remove(owner.key);
  await rejected;
  await proxy.$initializeFileSystem();
  expect(watchCount).toBe(0);
  expect(files.hasProvider(root)).toBe(false);
  await expect(proxy.$stat('peer', file)).rejects.toMatchObject({ code: FileSystemProviderErrorCode.Unavailable });
  registration.dispose();
  watch.dispose();
});

test('stopping the main customer detaches the proxy and a new host can register the same scheme', async () => {
  const files = disposables.add(new FileService());
  const first = connect(files);
  first.worker.register(owner.key, scheme, provider(() => {
    throw FileSystemError.FileNotFound(file);
  }));
  await first.proxy.$initializeFileSystem();
  await expect(files.stat(file)).rejects.toMatchObject({ code: FileSystemProviderErrorCode.FileNotFound });
  first.main.dispose();
  await expect(files.stat(file)).rejects.toMatchObject({ code: FileSystemProviderErrorCode.Unavailable });

  const second = connect(files);
  second.worker.register(owner.key, scheme, provider(() => ({ type: 1, ctime: 0, mtime: 0, size: 1 })));
  await second.proxy.$initializeFileSystem();
  await expect(files.readFile(file)).resolves.toMatchObject({ value: Uint8Array.of(4) });
});
