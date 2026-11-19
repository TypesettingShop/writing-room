import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import type { IFileStat } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextService as IWorkspace, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { MAX_EXPLORER_CHILDREN } from '../../common/explorerModel.js';
import { validateExplorerName } from '../../browser/explorerActions.js';
import { EXPLORER_VIEW_STATE_KEY, ExplorerService } from '../../browser/explorerService.js';
import { ExplorerView } from '../../browser/views/explorerView.js';

const root = URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace' });
const file = (path: string) => URI.joinPath(root, path);
const folder: IWorkspaceFolder = { uri: root, name: 'workspace', index: 0, toResource: path => URI.joinPath(root, path) };
const workspace: IWorkspace = {
  _serviceBrand: undefined,
  onDidChangeWorkspaceFolders: Event.None,
  getWorkbenchState: () => 2,
  getWorkspace: () => ({ id: 'test', folders: [folder] }),
  getWorkspaceFolder: resource => resource.path.startsWith('/workspace') ? folder : null,
};

const disposables = new DisposableStore();
let files: FileService;
let provider: InMemoryFileSystemProvider;
let storage: InMemoryStorageService;

function createExplorer(): ExplorerService {
  const instantiation = new InstantiationService(new ServiceCollection(
    [IFileService, files],
    [IWorkspaceContextService, workspace],
    [IStorageService, storage],
  ));
  return disposables.add(instantiation.createInstance(ExplorerService));
}

const names = (items: readonly { name: string }[] | undefined) => items?.map(item => item.name);
const write = (path: string, text = '') => files.writeFile(file(path), new TextEncoder().encode(text));
/** Lets the file service's batched change event and the reads it starts run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

beforeEach(async () => {
  files = disposables.add(new FileService());
  provider = disposables.add(new InMemoryFileSystemProvider());
  files.registerProvider('vscode-vfs', provider);
  storage = disposables.add(new InMemoryStorageService());
  await files.createFolder(root);
});

afterEach(() => {
  disposables.clear();
  vi.restoreAllMocks();
});

describe('ExplorerService', () => {
  test('a read that ends after a newer one does not replace it, even when it succeeds', async () => {
    await write('old.md');
    const realResolve = files.resolve.bind(files);
    let releaseFirst!: (stat: IFileStat) => void;
    const staleStat = await realResolve(root);
    vi.spyOn(files, 'resolve')
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockImplementation(resource => realResolve(resource));
    const explorer = createExplorer();
    await files.del(file('old.md'));
    await write('new.md');
    await explorer.resolveFolder(explorer.root);
    expect(names(explorer.root.children)).toEqual(['new.md']);
    releaseFirst(staleStat);
    await settle();
    expect(names(explorer.root.children)).toEqual(['new.md']);
  });

  test('a change re-reads the folders on screen and makes collapsed ones read again when shown', async () => {
    await files.createFolder(file('open'));
    await files.createFolder(file('closed'));
    const explorer = createExplorer();
    await explorer.setExpanded(explorer.root, true);
    const open = explorer.find(file('open'))!;
    const closed = explorer.find(file('closed'))!;
    await explorer.setExpanded(open, true);
    await explorer.setExpanded(closed, true);
    await explorer.setExpanded(closed, false);
    expect(closed.isResolved).toBe(true);

    const readdir = vi.spyOn(provider, 'readdir');
    await write('open/x.md');
    await write('closed/y.md');
    await settle();
    expect(readdir.mock.calls.map(([resource]) => resource.path)).toEqual(['/workspace/open']);
    expect(names(open.children)).toEqual(['x.md']);
    expect(closed.isResolved).toBe(false);

    await explorer.setExpanded(closed, true);
    expect(names(closed.children)).toEqual(['y.md']);
  });

  test('keeps expanded folders in the workspace storage and reads them back', async () => {
    await files.createFolder(file('docs'));
    await files.createFolder(file('docs/deep'));
    await write('docs/deep/a.md');
    const first = createExplorer();
    await first.setExpanded(first.root, true);
    await first.setExpanded(first.find(file('docs'))!, true);
    await first.setExpanded(first.find(file('docs/deep'))!, true);
    expect(JSON.parse(storage.get(EXPLORER_VIEW_STATE_KEY, StorageScope.WORKSPACE)!)).toEqual({
      expanded: [file('docs').toString(), file('docs/deep').toString()],
    });

    const second = createExplorer();
    await second.setExpanded(second.root, true);
    await settle();
    const docs = second.find(file('docs'))!;
    expect(second.isExpanded(docs)).toBe(true);
    expect(names(second.find(file('docs/deep'))?.children)).toEqual(['a.md']);

    second.collapseAll();
    expect(createExplorer().isExpanded(docs)).toBe(false);
  });

  test.each([
    ['not JSON', '{'],
    ['the wrong shape', JSON.stringify({ expanded: 'docs' })],
    ['entries outside the workspace folder', JSON.stringify({ expanded: ['vscode-vfs://writing-room/elsewhere', 42, root.toString()] })],
  ])('starts collapsed from stored state that is %s', async (_name, value) => {
    await files.createFolder(file('docs'));
    storage.store(EXPLORER_VIEW_STATE_KEY, value, StorageScope.WORKSPACE, StorageTarget.MACHINE);
    const explorer = createExplorer();
    await explorer.setExpanded(explorer.root, true);
    expect(explorer.isExpanded(explorer.find(file('docs'))!)).toBe(false);
  });

  test('a read that fails for another reason than a missing folder keeps the listing and the expansion', async () => {
    await files.createFolder(file('docs'));
    await write('docs/a.md');
    const explorer = createExplorer();
    await explorer.setExpanded(explorer.root, true);
    const docs = explorer.find(file('docs'))!;
    await explorer.setExpanded(docs, true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(files, 'resolve').mockRejectedValueOnce(new Error('The storage is busy.'));

    await explorer.resolveFolder(explorer.root);
    expect(names(explorer.root.children)).toEqual(['docs']);
    expect(explorer.isExpanded(docs)).toBe(true);
    expect(JSON.parse(storage.get(EXPLORER_VIEW_STATE_KEY, StorageScope.WORKSPACE)!)).toEqual({ expanded: [file('docs').toString()] });
  });

  test('a deleted folder leaves the stored expansion', async () => {
    await files.createFolder(file('gone'));
    const explorer = createExplorer();
    await explorer.setExpanded(explorer.root, true);
    await explorer.setExpanded(explorer.find(file('gone'))!, true);
    await files.del(file('gone'), { recursive: true });
    await settle();
    expect(JSON.parse(storage.get(EXPLORER_VIEW_STATE_KEY, StorageScope.WORKSPACE)!)).toEqual({ expanded: [] });
  });

  test('select expands the collapsed folders above a file, and a later select wins', async () => {
    await files.createFolder(file('a'));
    await files.createFolder(file('b'));
    await files.createFolder(file('b/c'));
    await write('a/x.md');
    await write('b/c/y.md');
    const explorer = createExplorer();
    const reveals: string[] = [];
    disposables.add(explorer.onDidRequestReveal(({ item }) => reveals.push(item.name)));
    expect(await explorer.select(file('b/c/y.md'))).toBe(true);
    expect(explorer.selection?.name).toBe('y.md');
    expect(explorer.isExpanded(explorer.find(file('b'))!)).toBe(true);
    expect(explorer.isExpanded(explorer.find(file('b/c'))!)).toBe(true);

    const realResolve = files.resolve.bind(files);
    let release!: () => void;
    vi.spyOn(files, 'resolve').mockImplementation(async resource => {
      if (resource.path === '/workspace/a') {
        await new Promise<void>(resolve => { release = resolve; });
      }
      return realResolve(resource);
    });
    const slow = explorer.select(file('a/x.md'));
    await settle();
    expect(await explorer.select(file('b/c/y.md'))).toBe(true);
    release();
    expect(await slow).toBe(false);
    expect(explorer.selection?.name).toBe('y.md');
    expect(reveals).toEqual(['y.md', 'y.md']);
  });

  test('moves the expansion below a renamed folder', async () => {
    await files.createFolder(file('old'));
    await files.createFolder(file('old/sub'));
    const explorer = createExplorer();
    await explorer.select(file('old/sub'));
    await explorer.setExpanded(explorer.find(file('old/sub'))!, true);
    explorer.moveExpanded(file('old'), file('new'));
    expect(JSON.parse(storage.get(EXPLORER_VIEW_STATE_KEY, StorageScope.WORKSPACE)!).expanded.sort())
      .toEqual([file('new').toString(), file('new/sub').toString()]);
  });
});

describe('validateExplorerName', () => {
  test('refuses names no file can have and names taken in the folder', async () => {
    await write('taken.md');
    await files.createFolder(file('dir'));
    const explorer = createExplorer();
    await explorer.setExpanded(explorer.root, true);
    const rootItem = explorer.root;
    for (const name of ['', 'a/b', 'a\\b', '.', '..', 'tab\there', 'x'.repeat(256)]) {
      expect(validateExplorerName(name, rootItem), JSON.stringify(name)).toBeTruthy();
    }
    expect(validateExplorerName('taken.md', rootItem)).toMatch(/already exists/);
    expect(validateExplorerName('dir', rootItem)).toMatch(/already exists/);
    expect(validateExplorerName('x'.repeat(255), rootItem)).toBeUndefined();
    expect(validateExplorerName('fresh.md', rootItem)).toBeUndefined();
    // A rename may keep its own name.
    expect(validateExplorerName('taken.md', rootItem, rootItem.getChild('taken.md'))).toBeUndefined();
  });
});

describe('ExplorerView', () => {
  test(`draws ${MAX_EXPLORER_CHILDREN} entries of a folder and a row for the rest`, async () => {
    const explorer = createExplorer();
    const stats = Array.from({ length: MAX_EXPLORER_CHILDREN + 2 }, (_, index) => ({ name: `f${index}.md`, isDirectory: false }));
    vi.spyOn(files, 'resolve').mockImplementation(async () => ({
      resource: root, name: 'workspace', isFile: false, isDirectory: true, isSymbolicLink: false, readonly: false,
      type: 2, ctime: 0, mtime: 0, size: 0, etag: '',
      children: stats.map(stat => ({
        resource: file(stat.name), name: stat.name, isFile: true, isDirectory: false, isSymbolicLink: false, readonly: false,
        type: 1, ctime: 0, mtime: 0, size: 0, etag: '',
      })),
    }));
    await explorer.resolveFolder(explorer.root);
    const parent = document.body.appendChild(document.createElement('div'));
    const unused = {} as never;
    const view = disposables.add(new ExplorerView(parent, explorer, unused, unused, unused, unused, unused, unused, unused, unused));
    await settle();
    const tree = parent.querySelector('[role="tree"]')!;
    expect(tree.getAttribute('aria-label')).toBe('Files Explorer');
    const rows = tree.querySelectorAll('[role="treeitem"]');
    expect(rows).toHaveLength(MAX_EXPLORER_CHILDREN + 1);
    expect(rows[rows.length - 1].textContent).toBe('2 more items are not shown');
    expect(rows[rows.length - 1].getAttribute('aria-disabled')).toBe('true');
    view.dispose();
    parent.remove();
  }, 60_000);
});
