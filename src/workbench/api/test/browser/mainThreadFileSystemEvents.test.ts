import { afterEach, expect, test, vi } from 'vitest';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { FileChangeType } from '../../../../platform/files/common/files.js';
import type { IFileChange } from '../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { ExtensionFileAccess } from '../../browser/extensionFileAccess.js';
import { MainThreadFileSystemEventService } from '../../browser/mainThreadFileSystemEventService.js';
import type { ExtHostFileSystemShape } from '../../common/extHost.protocol.fileSystem.js';

const workspaceUri = URI.parse('vscode-vfs://writing-room/workspace');
const owner: HostExtensionDescription = {
  id: 'test.owner', key: 'key', location: '', entry: '', activationEvents: [],
  manifest: { name: 'owner', publisher: 'test', version: '1.0.0' },
};
const disposables = new DisposableStore();

afterEach(() => {
  disposables.clear();
  vi.useRealTimers();
});

test('batches change bursts, checks reader access and removes disposed watchers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const files = disposables.add(new FileService());
  const workspace = disposables.add(new InMemoryFileSystemProvider());
  const userdata = disposables.add(new InMemoryFileSystemProvider());
  const changed = disposables.add(new Emitter<readonly IFileChange[]>());
  const changedUserdata = disposables.add(new Emitter<readonly IFileChange[]>());
  Object.defineProperty(workspace, 'onDidChangeFile', { value: changed.event });
  Object.defineProperty(userdata, 'onDidChangeFile', { value: changedUserdata.event });
  files.registerProvider(workspaceUri.scheme, workspace);
  files.registerProvider('vscode-userdata', userdata);
  const access = new ExtensionFileAccess({
    id: 'writing-room', folders: [{ uri: workspaceUri, name: 'workspace', index: 0, toResource: path => URI.joinPath(workspaceUri, path) }],
  }, () => [], () => false);
  const send = vi.fn<ExtHostFileSystemShape['$acceptFileChanges']>().mockResolvedValue(undefined);
  const proxy: ExtHostFileSystemShape = {
    $acceptFileChanges: send, async $acceptFileOperation() {}, async $participateInFileOperation() {}, async $acceptFileSystemCapability() {},
  };
  const events = disposables.add(new MainThreadFileSystemEventService(
    files, proxy, access, key => key === owner.key ? owner : undefined, [workspaceUri],
  ));
  const file = (path: string) => ({ resource: URI.joinPath(workspaceUri, path), type: FileChangeType.ADDED });
  const privateFile = { resource: URI.parse('vscode-userdata:/User/globalStorage/test.peer/test.txt'), type: FileChangeType.ADDED };
  changed.fire([file('before')]);
  await vi.runAllTimersAsync();
  expect(send).not.toHaveBeenCalled();

  await events.watch(owner, 0);
  await events.watch(owner, 1, async () => URI.joinPath(workspaceUri, 'nested'));
  const expected = Array.from({ length: 1000 }, (_, index) => file((index % 2 === 0 ? 'nested/' : '') + index));
  for (const entry of expected) {
    changed.fire([entry]);
    await Promise.resolve();
  }
  changedUserdata.fire([privateFile]);
  changed.fire([{ resource: workspaceUri.with({ path: '/workspace-sibling/private' }), type: FileChangeType.ADDED }]);
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(1);
  const batches = send.mock.calls[0][0];
  expect(batches.flatMap(batch => batch.changes)).toEqual(expected);
  expect(batches.filter(batch => batch.handles.includes(1)).flatMap(batch => batch.changes))
    .toEqual(expected.filter((_, index) => index % 2 === 0));

  changed.fire([file('queued-before-dispose')]);
  await Promise.resolve();
  events.unwatch(owner.key, 0);
  events.remove(owner.key);
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(1);
});

test('a slow participant receives cancellation and the underlying operation completes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const files = disposables.add(new FileService());
  const workspace = disposables.add(new InMemoryFileSystemProvider());
  files.registerProvider(workspaceUri.scheme, workspace);
  const access = new ExtensionFileAccess({
    id: 'writing-room', folders: [{ uri: workspaceUri, name: 'workspace', index: 0, toResource: path => URI.joinPath(workspaceUri, path) }],
  }, () => [], () => false);
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let cancelled = false;
  const events = disposables.add(new MainThreadFileSystemEventService(files, {
    async $acceptFileChanges() {}, async $acceptFileOperation() {}, async $acceptFileSystemCapability() {},
    $participateInFileOperation(_extensions, _event, token) {
      token.onCancellationRequested(() => { cancelled = true; });
      started();
      return new Promise(() => {});
    },
  }, access, key => key === owner.key ? owner : undefined, [workspaceUri]));
  events.subscribe(owner.key, 'will:create', true);
  const uri = URI.joinPath(workspaceUri, 'waited');
  const creating = files.createFolder(uri);
  await began;
  await vi.advanceTimersByTimeAsync(4999);
  expect(cancelled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(cancelled).toBe(true);
  await expect(creating).resolves.toMatchObject({ resource: uri });
});

test('dropping access before a queued batch is sent prevents delivery', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const files = disposables.add(new FileService());
  const provider = disposables.add(new InMemoryFileSystemProvider());
  const changes = disposables.add(new Emitter<readonly IFileChange[]>());
  Object.defineProperty(provider, 'onDidChangeFile', { value: changes.event });
  files.registerProvider('memory', provider);
  const root = URI.parse('memory:/');
  let allowed = true;
  const access = new ExtensionFileAccess({ id: 'writing-room', folders: [] }, () => [], scheme => allowed && scheme === root.scheme);
  const send = vi.fn<ExtHostFileSystemShape['$acceptFileChanges']>().mockResolvedValue(undefined);
  const events = disposables.add(new MainThreadFileSystemEventService(files, {
    $acceptFileChanges: send, async $acceptFileOperation() {}, async $participateInFileOperation() {}, async $acceptFileSystemCapability() {},
  }, access, () => owner, []));
  await events.watch(owner, 0, async () => access.require(owner, root, false));
  changes.fire([{ type: FileChangeType.ADDED, resource: URI.joinPath(root, 'queued') }]);
  await Promise.resolve();
  allowed = false;
  await vi.runAllTimersAsync();
  expect(send).not.toHaveBeenCalled();
});
