// @vitest-environment node
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileService } from '../../common/fileService.js';
import {
  FileChangeType, FileOperation, FileOperationResult, FileSystemProviderCapabilities,
  FileSystemProviderError, FileSystemProviderErrorCode, FileType,
} from '../../common/files.js';
import type { IFileChange, IFileSystemProvider } from '../../common/files.js';
import { InMemoryFileSystemProvider } from '../../common/inMemoryFilesystemProvider.js';

const Code = FileSystemProviderErrorCode;
const disposables = new DisposableStore();
const bytes = (text: string) => new TextEncoder().encode(text);
const file = (path: string) => URI.from({ scheme: 'mem', path });

afterEach(() => disposables.clear());

function setup() {
  const service = disposables.add(new FileService());
  const provider = disposables.add(new InMemoryFileSystemProvider());
  const registration = service.registerProvider('mem', provider);
  return { service, provider, registration };
}

describe('file service', () => {
  test('activates a missing provider once for concurrent accesses and detaches it on unregister', async () => {
    const service = disposables.add(new FileService());
    const provider = disposables.add(new InMemoryFileSystemProvider());
    let registration: { dispose(): void } | undefined;
    const activate = vi.fn(({ scheme, join }) => {
      expect(scheme).toBe('mem');
      join(Promise.resolve().then(() => { registration = service.registerProvider(scheme, provider); }));
    });
    const subscription = service.onWillActivateFileSystemProvider(activate);
    await Promise.all([service.stat(file('/')), service.stat(file('/'))]);
    expect(activate).toHaveBeenCalledTimes(1);
    subscription.dispose();
    registration?.dispose();
    await expect(service.stat(file('/'))).rejects.toMatchObject({ code: Code.Unavailable });
  });

  test('writes parents atomically, honors the etag and rejects descent through a file', async () => {
    const { service } = setup();
    const path = file('/a/b/c.md');
    const first = await service.writeFile(path, bytes('one'));
    expect((await service.resolve(file('/a/b'))).children?.map(child => child.name)).toEqual(['c.md']);
    const second = await service.writeFile(path, bytes('two'), { etag: first.etag });
    expect(second.etag).not.toBe(first.etag);
    await expect(service.writeFile(path, bytes('old'), { etag: first.etag }))
      .rejects.toMatchObject({ fileOperationResult: FileOperationResult.FILE_MODIFIED_SINCE });
    await expect(service.writeFile(file('/a/b/c.md/child'), bytes('fail'))).rejects.toMatchObject({ code: Code.FileNotADirectory });
    await expect(service.del(file('/a'))).rejects.toMatchObject({ code: Code.NoPermissions });
    await expect(service.readFile(path, { limits: { size: 2 } })).rejects.toMatchObject({ code: Code.FileTooLarge });
    expect((await service.readFile(path)).value).toEqual(bytes('two'));
    await service.del(file('/a'), { recursive: true });
    await expect(service.exists(path)).resolves.toBe(false);
  });

  test('refuses to copy a folder onto itself through an unnormalized path and reports paths below a file as missing', async () => {
    const { service, provider } = setup();
    await service.writeFile(file('/a/dir/child.md'), bytes('keep'));
    await expect(service.copy(file('/a/./dir'), file('/a/dir'), true)).rejects.toMatchObject({ code: Code.NoPermissions });
    expect(await provider.readdir(file('/a/dir'))).toEqual([['child.md', FileType.File]]);
    await expect(service.exists(file('/a/dir/child.md/below'))).resolves.toBe(false);
  });

  test('uses stat for conditional writes on a generic provider', async () => {
    const { provider, service, registration } = setup();
    Object.defineProperty(provider, 'capabilities', { value: FileSystemProviderCapabilities.FileReadWrite });
    registration.dispose();
    service.registerProvider('mem', provider);
    const path = file('/a/file.md');
    const initial = await service.writeFile(path, bytes('old'));
    const write = vi.spyOn(provider, 'writeFile');
    await expect(service.writeFile(path, bytes('new'), { etag: 'wrong' }))
      .rejects.toMatchObject({ fileOperationResult: FileOperationResult.FILE_MODIFIED_SINCE });
    expect(write).not.toHaveBeenCalled();
    await service.writeFile(path, bytes('new'), { etag: initial.etag });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('waits for operation participants and groups provider changes once', async () => {
    const { service } = setup();
    let allowOperation!: () => void;
    let signalWillRun!: () => void;
    const proceed = new Promise<void>(resolve => { allowOperation = resolve; });
    const will = new Promise<void>(resolve => { signalWillRun = resolve; });
    const events: string[] = [];
    service.onWillRunOperation(event => {
      events.push('will:' + FileOperation[event.operation]);
      if (event.resource.path === '/a/b') {
        event.waitUntil(proceed);
        signalWillRun();
      }
    });
    service.onDidRunOperation(event => events.push('did:' + FileOperation[event.operation]));
    service.onDidFilesChange(event => {
      events.push('changes:' + event.changes.map(change => FileChangeType[change.type] + change.resource.path).join(','));
    });
    const result = service.createFile(file('/a/b'), bytes('x'));
    await will;
    expect(events).toEqual(['will:CREATE']);
    await expect(service.exists(file('/a'))).resolves.toBe(false);
    allowOperation();
    await result;
    await service.createFolder(file('/folder'));
    await service.copy(file('/a/b'), file('/folder/new'));
    await service.move(file('/folder/new'), file('/new'));
    await service.del(file('/new'));
    expect(events).toEqual([
      'will:CREATE', 'changes:ADDED/a,ADDED/a/b', 'did:CREATE',
      'will:CREATE', 'changes:ADDED/folder', 'did:CREATE',
      'will:COPY', 'changes:ADDED/folder/new', 'did:COPY',
      'will:MOVE', 'changes:ADDED/new,DELETED/folder/new', 'did:MOVE',
      'will:DELETE', 'changes:DELETED/new', 'did:DELETE',
    ]);
  });

  test('orders a batch by the last report of a repeated change', async () => {
    const service = disposables.add(new FileService());
    const changes = disposables.add(new Emitter<readonly IFileChange[]>());
    service.registerProvider('mem', { capabilities: 0, onDidChangeFile: changes.event } as unknown as IFileSystemProvider);
    const batches: string[][] = [];
    service.onDidFilesChange(event => batches.push(event.changes.map(change => FileChangeType[change.type])));
    for (const type of [FileChangeType.ADDED, FileChangeType.DELETED, FileChangeType.ADDED]) {
      changes.fire([{ resource: file('/x'), type }]);
    }
    await Promise.resolve();
    expect(batches).toEqual([['DELETED', 'ADDED']]);
  });

  test('vetoes failed participants and preserves both trees when a cross-provider move cannot copy', async () => {
    const { service, provider } = setup();
    const other = disposables.add(new InMemoryFileSystemProvider());
    service.registerProvider('other', other);
    await service.createFile(file('/source/a'), bytes('keep me'));
    await service.createFile(file('/source/b'), bytes('fails'));
    const target = URI.from({ scheme: 'other', path: '/target' });
    await service.createFile(URI.joinPath(target, 'old'), bytes('keep me too'));
    const original = other.writeFile.bind(other);
    const fail = vi.spyOn(other, 'writeFile').mockImplementation(async (resource, value, options) => {
      if (resource.path.endsWith('/b')) {
        throw new FileSystemProviderError('test failure', Code.FileExceedsStorageQuota);
      }
      return original(resource, value, options);
    });
    await expect(service.move(file('/source'), target, true)).rejects.toMatchObject({ code: Code.FileExceedsStorageQuota });
    expect((await service.resolve(file('/source'))).children?.map(child => child.name)).toEqual(['a', 'b']);
    expect((await service.resolve(target)).children?.map(child => child.name)).toEqual(['old']);
    expect(await other.readdir(target.with({ path: '/' }))).toEqual([['target', FileType.Directory]]);
    fail.mockRestore();

    const listener = service.onWillRunOperation(event => event.waitUntil(Promise.reject(new Error('veto'))));
    const deletion = vi.spyOn(provider, 'delete');
    await expect(service.del(file('/source/a'))).rejects.toThrow('veto');
    expect(deletion).not.toHaveBeenCalled();
    listener.dispose();

    await service.move(file('/source'), target, true);
    expect(await service.exists(file('/source'))).toBe(false);
    expect((await service.resolve(target)).children?.map(child => child.name)).toEqual(['a', 'b']);
  });
});
