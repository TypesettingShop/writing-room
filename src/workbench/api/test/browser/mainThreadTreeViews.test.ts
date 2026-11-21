import { expect, test, vi } from 'vitest';
import { URI } from '../../../../base/common/uri.js';
import { ExtensionTreeViews, MainThreadTreeViews } from '../../browser/mainThreadTreeViews.js';
import type { TreeItemDto } from '../../common/extHost.protocol.js';

const extensionFolder = 'https://example.com/extensions/a/';
const workspaceFolder = 'vscode-vfs://writing-room/workspace/';

function setup(items: TreeItemDto[]) {
  const views = new ExtensionTreeViews();
  const openView = vi.fn(async () => undefined);
  const trees = new MainThreadTreeViews({
    $getChildren: async () => items,
    $getTreeItem: async () => items[0],
  }, views, (key, id) => key === 'a' && id === 'tree', {
    iconFolders: key => key === 'a' ? [extensionFolder, workspaceFolder] : [],
    openView,
  });
  return { views, trees, openView };
}

test('keeps only icons inside the extension or the workspace, and theme icons with a codicon name', async () => {
  const row = (handle: string, icon: unknown): TreeItemDto => ({ handle, label: handle, collapsible: 0, icon } as TreeItemDto);
  const uri = (value: string) => ({ kind: 'uri', light: URI.parse(value), dark: URI.parse(value) });
  const { views, trees } = setup([
    row('inside', uri(extensionFolder + 'media/icon.svg')),
    row('workspace', uri(workspaceFolder + 'docs/icon.png')),
    row('escape', uri(extensionFolder + 'media/%2e%2e/%2e%2e/b/icon.svg')),
    row('other', uri('https://example.com/extensions/b/icon.svg')),
    row('pair', { kind: 'uri', light: URI.parse(extensionFolder + 'light.svg'), dark: URI.parse('https://evil.example/dark.svg') }),
    row('theme', { kind: 'theme', id: 'pass', color: 'charts.green' }),
    row('bad-theme', { kind: 'theme', id: 'pass"><img src=x>' }),
    row('bad-color', { kind: 'theme', id: 'pass', color: 'red;background:url(x)' }),
  ]);
  await trees.$registerTreeViewDataProvider('a', 'tree');
  const rows = await views.get('tree')!.getChildren();
  expect(Object.fromEntries(rows.map(item => [item.handle, item.icon && (item.icon.kind === 'uri' ? item.icon.light.toString() : item.icon)]))).toEqual({
    inside: extensionFolder + 'media/icon.svg',
    workspace: workspaceFolder + 'docs/icon.png',
    escape: undefined,
    other: undefined,
    pair: undefined,
    theme: { kind: 'theme', id: 'pass', color: 'charts.green' },
    'bad-theme': undefined,
    'bad-color': { kind: 'theme', id: 'pass', color: undefined },
  });
  trees.dispose();
  views.dispose();
});

test('reveal opens the view and hands the chain to its tree; title, message and badge reach the source', async () => {
  const { views, trees, openView } = setup([]);
  await trees.$registerTreeViewDataProvider('a', 'tree');
  const revealer = vi.fn(async () => {});
  views.registerRevealer('tree', revealer);
  await trees.$reveal('b', 'tree', ['x'], { select: true, focus: false, expand: 0 });
  expect(openView).not.toHaveBeenCalled();
  await trees.$reveal('a', 'tree', ['x', 'y'], { select: false, focus: true, expand: 7 });
  expect(openView).toHaveBeenCalledExactlyOnceWith('tree', true);
  expect(revealer).toHaveBeenCalledExactlyOnceWith(['x', 'y'], { select: false, focus: true, expand: 3 });

  const source = views.get('tree')!;
  const changed = vi.fn();
  source.onDidChangeState!(changed);
  await trees.$setTitle('a', 'tree', 'Title', 'Description');
  await trees.$setMessage('a', 'tree', 'Message');
  await trees.$setBadge('a', 'tree', { value: 3.7, tooltip: 'Three' });
  await trees.$setTitle('b', 'tree', 'Not mine', undefined);
  expect(changed).toHaveBeenCalledTimes(3);
  expect(source.state).toEqual({ title: 'Title', description: 'Description', message: 'Message', badge: { value: 3, tooltip: 'Three' } });
  trees.dispose();
  views.dispose();
});
