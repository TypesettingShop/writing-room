import { afterEach, expect, test, vi } from 'vitest';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { FileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import type { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { MainThreadFileSystem } from '../../browser/mainThreadFileSystem.js';
import type { ExtHostFileSystemProviderShape, ExtHostFileSystemShape, FileOperationDto } from '../../common/extHost.protocol.fileSystem.js';

const disposables = new DisposableStore();
const root = URI.parse('vscode-vfs://writing-room/workspace');
const uri = (path: string) => URI.joinPath(root, path);
const folder = { uri: root, index: 0, name: 'workspace', toResource: uri };
const owner: HostExtensionDescription = {
  id: 'test.owner', key: 'owner', location: '', entry: '', activationEvents: [],
  manifest: { name: 'owner', publisher: 'test', version: '1.0.0' },
};
const peerPackage = 'vscode-userdata:/extensions/test.peer-1.0.0/';

afterEach(() => disposables.clear());

function setup() {
  const files = disposables.add(new FileService());
  files.registerProvider(root.scheme, disposables.add(new InMemoryFileSystemProvider()));
  files.registerProvider('vscode-userdata', disposables.add(new InMemoryFileSystemProvider()));
  const participate = vi.fn<ExtHostFileSystemShape['$participateInFileOperation']>().mockResolvedValue(undefined);
  const announce = vi.fn<ExtHostFileSystemShape['$acceptFileOperation']>().mockResolvedValue(undefined);
  const proxy: ExtHostFileSystemShape = {
    async $acceptFileChanges() {}, $acceptFileOperation: announce, $participateInFileOperation: participate,
    async $acceptFileSystemCapability() {},
  };
  const extensions: IExtensionService = {
    _serviceBrand: undefined, extensions: [{ location: peerPackage } as IExtensionDescription],
    async activateByEvent() {}, activationEventIsDone: () => true, async whenInstalledExtensionsRegistered() { return true; },
  };
  const main = disposables.add(new MainThreadFileSystem(proxy, {} as ExtHostFileSystemProviderShape,
    key => key === owner.key ? owner : undefined, files, {
      _serviceBrand: undefined, getWorkspace: () => ({ id: 'writing-room', folders: [folder] }),
      getWorkbenchState: () => WorkbenchState.FOLDER, getWorkspaceFolder: () => folder, onDidChangeWorkspaceFolders: Event.None,
    }, extensions, async () => {}));
  return { files, main, participate, announce };
}

function operations(calls: readonly (readonly [readonly string[], FileOperationDto, ...unknown[]])[]): string[] {
  return calls.map(([, event]) => event.kind + ' ' + event.resource.path + (event.kind === 'rename' ? ' ' + event.target.path : ''));
}

test('workspace.fs runs no file operation participants and fires no operation events, as in VS Code', async () => {
  const { files, main, participate, announce } = setup();
  for (const kind of ['create', 'delete', 'rename'] as const) {
    await main.$subscribeFileOperation(owner.key, `will:${kind}`, true);
    await main.$subscribeFileOperation(owner.key, `did:${kind}`, true);
  }
  await main.$writeFile(owner.key, uri('a.txt'), Uint8Array.of(1));
  await main.$createDirectory(owner.key, uri('dir'));
  await main.$copy(owner.key, uri('a.txt'), uri('b.txt'));
  await main.$rename(owner.key, uri('b.txt'), uri('c.txt'));
  await main.$delete(owner.key, uri('c.txt'));
  expect(participate).not.toHaveBeenCalled();
  expect(announce).not.toHaveBeenCalled();

  // The same operations from the workbench still reach participants and listeners.
  await files.copy(uri('a.txt'), uri('b.txt'));
  await files.move(uri('b.txt'), uri('c.txt'));
  await files.del(uri('c.txt'));
  const expected = ['create /workspace/b.txt', 'rename /workspace/b.txt /workspace/c.txt', 'delete /workspace/c.txt'];
  expect(operations(announce.mock.calls)).toEqual(expected);
  expect(operations(participate.mock.calls)).toEqual(expected);
});

test('rename and copy check both ends and where a copy across providers stages its data', async () => {
  const { files, main } = setup();
  const peer = URI.parse('vscode-userdata:/User/globalStorage/test.peer/file');
  const own = URI.parse('vscode-userdata:/User/globalStorage/test.owner');
  const packaged = URI.parse(peerPackage + 'package.json');
  for (const resource of [peer, packaged, uri('a.txt')]) {
    await files.writeFile(resource, Uint8Array.of(1));
  }
  const denied = { code: FileSystemProviderErrorCode.NoPermissions };
  await expect(main.$rename(owner.key, uri('a.txt'), peer, { overwrite: true })).rejects.toMatchObject(denied);
  await expect(main.$rename(owner.key, peer, uri('b.txt'))).rejects.toMatchObject(denied);
  await expect(main.$copy(owner.key, peer, uri('b.txt'))).rejects.toMatchObject(denied);
  // An installed package is readable, so it can be copied but not moved away.
  await expect(main.$rename(owner.key, packaged, uri('b.txt'))).rejects.toMatchObject(denied);
  await main.$copy(owner.key, packaged, uri('b.txt'));
  // Across providers the file service stages next to the target, here in the shared globalStorage folder.
  await expect(main.$copy(owner.key, uri('a.txt'), own)).rejects.toMatchObject(denied);
  await expect(main.$rename(owner.key, uri('a.txt'), own)).rejects.toMatchObject(denied);
  await main.$copy(owner.key, uri('a.txt'), URI.joinPath(own, 'copy.txt'));

  expect(await files.exists(URI.joinPath(own, 'copy.txt'))).toBe(true);
  expect((await files.resolve(URI.parse('vscode-userdata:/User/globalStorage'))).children?.map(({ name }) => name).sort())
    .toEqual(['test.owner', 'test.peer']);
  for (const resource of [peer, packaged, uri('a.txt'), uri('b.txt')]) {
    expect(await files.exists(resource)).toBe(true);
  }
});
