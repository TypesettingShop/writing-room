import { afterEach, expect, test, vi } from 'vitest';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { FileType } from '../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { MainThreadWorkspace } from '../../browser/mainThreadWorkspace.js';

const disposables = new DisposableStore();
const root = URI.parse('vscode-vfs://writing-room/workspace');
const uri = (path: string) => URI.joinPath(root, path);
const folder = { uri: root, index: 0, name: 'workspace', toResource: uri };

function setup() {
  const files = disposables.add(new FileService());
  const provider = disposables.add(new InMemoryFileSystemProvider());
  files.registerProvider(root.scheme, provider);
  const workspace = new MainThreadWorkspace({
    _serviceBrand: undefined, getWorkspace: () => ({ id: 'writing-room', folders: [folder] }),
    getWorkbenchState: () => WorkbenchState.FOLDER, getWorkspaceFolder: () => folder,
    onDidChangeWorkspaceFolders: Event.None,
  }, files);
  return { files, provider, workspace };
}

afterEach(() => {
  vi.useRealTimers();
  disposables.clear();
});

test('search is breadth first and prunes excluded paths before listing them', async () => {
  const { files, provider, workspace } = setup();
  for (const path of ['foo/a.md', 'top.md', 'node_modules/lib/a.md', '.git/notes.md', 'foo/no.txt']) {
    await files.writeFile(uri(path), new Uint8Array());
  }
  const read = vi.spyOn(provider, 'readdir');
  await expect(workspace.findFiles('**/*.md', '**/node_modules/**', 1)).resolves.toEqual([uri('top.md')]);
  expect(read.mock.calls.map(([resource]) => resource.path)).toEqual([root.path]);
  read.mockClear();
  const paths = (await workspace.findFiles('**/*.md')).map(result => result.path);
  expect(paths).toEqual([uri('top.md').path, uri('foo/a.md').path]);
  expect(read.mock.calls.map(([resource]) => resource.path)).toEqual([root.path, uri('foo').path]);
  const all = (await workspace.findFiles('**/*.md', null)).map(result => result.path);
  expect(all).toContain(uri('node_modules/lib/a.md').path);
  const relative = await workspace.findFiles({ base: uri('foo'), pattern: '*.md' });
  expect(relative).toEqual([uri('foo/a.md')]);
});

test('cancels an outstanding directory listing and keeps the results already found', async () => {
  const { provider, workspace } = setup();
  const token = disposables.add(new CancellationTokenSource());
  let listing!: () => void;
  const started = new Promise<void>(resolve => { listing = resolve; });
  let finish!: (entries: [string, FileType][]) => void;
  const delayed = new Promise<[string, FileType][]>(resolve => { finish = resolve; });
  const read = vi.spyOn(provider, 'readdir')
    .mockResolvedValueOnce([['matched.md', FileType.File], ['slow', FileType.Directory], ['other', FileType.Directory]])
    .mockImplementationOnce(() => { listing(); return delayed; });
  const searching = workspace.findFiles('**/*.md', null, undefined, token.token);
  await started;
  token.cancel();
  await expect(searching).resolves.toEqual([uri('matched.md')]);
  finish([['late.md', FileType.File]]);
  expect(read).toHaveBeenCalledTimes(2);
});

test('search stops at the result and visit limits even for one large directory', async () => {
  vi.useFakeTimers();
  const { provider, workspace } = setup();
  const entries: [string, FileType][] = Array.from({ length: 20_001 }, (_, index) => [index + '.md', FileType.File]);
  const read = vi.spyOn(provider, 'readdir').mockResolvedValueOnce(entries);
  const results = workspace.findFiles('**/*.md', null, 30_000);
  await vi.runAllTimersAsync();
  expect(await results).toHaveLength(20_000);
  const many: [string, FileType][] = Array.from({ length: 100_000 }, () => ['x.txt', FileType.Unknown]);
  many.push(['late.md', FileType.File]);
  read.mockResolvedValueOnce(many);
  const search = workspace.findFiles('**/*.md', null);
  await vi.runAllTimersAsync();
  expect(await search).toEqual([]);
});
