// @vitest-environment node
import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { URI } from '../../../../base/common/uri.js';
import { ExtHostTreeViews, TreeItem, TreeItemCheckboxState } from '../../common/extHostTreeViews.js';
import { CancellationTokenSource, DataTransferItem, EventEmitter, ThemeColor, ThemeIcon, TreeItemCollapsibleState } from '../../common/extHostTypes.js';
import type { MainThreadTreeViewsShape } from '../../common/extHost.protocol.js';

interface Node { readonly name: string; readonly children?: Node[]; parent?: Node }

function mainThread() {
  return {
    $registerTreeViewDataProvider: vi.fn(async () => {}),
    $refresh: vi.fn(async () => {}),
    $disposeTree: vi.fn(async () => {}),
    $reveal: vi.fn(async () => {}),
    $setMessage: vi.fn(async () => {}),
    $setTitle: vi.fn(async () => {}),
    $setBadge: vi.fn(async () => {}),
  } satisfies MainThreadTreeViewsShape;
}

function tree(...names: [string, string[]][]): Node[] {
  return names.map(([name, children]) => {
    const node: Node = { name, children: children.map(child => ({ name: child })) };
    node.children!.forEach(child => child.parent = node);
    return node;
  });
}

function provider(roots: () => Node[], options: { getParent?: boolean; ids?: boolean } = {}) {
  const changes = new EventEmitter<Node | undefined>();
  const result: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changes.event,
    getChildren: element => element ? element.children ?? [] : roots(),
    getTreeItem: element => {
      const item = new TreeItem(element.name, element.children ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
      if (options.ids) {
        item.id = element.name;
      }
      return item;
    },
  };
  if (options.getParent !== false) {
    result.getParent = element => element.parent;
  }
  return { provider: result, changes };
}

test('reveal needs getParent and rejects with the VS Code message without it', async () => {
  const proxy = mainThread();
  const trees = new ExtHostTreeViews(proxy, () => ['tree']);
  const roots = tree(['Fruit', ['Apple']]);
  const view = trees.createTreeView('e', 'tree', provider(() => roots, { getParent: false }).provider);
  await expect(view.reveal(roots[0].children![0])).rejects.toThrow(
    "Required registered TreeDataProvider to implement 'getParent' method to access 'reveal' method");
  expect(proxy.$reveal).not.toHaveBeenCalled();
});

test('reveal lists the unknown ancestors and sends their handles with the options', async () => {
  const proxy = mainThread();
  const trees = new ExtHostTreeViews(proxy, () => ['tree']);
  const roots = tree(['Fruit', ['Apple', 'Pear']], ['Vegetables', ['Leek']]);
  const view = trees.createTreeView('e', 'tree', provider(() => roots).provider);
  const leek = roots[1].children![0];
  await view.reveal(leek, { expand: 9, focus: true });
  const [, , chain, options] = proxy.$reveal.mock.calls[0] as unknown as [string, string, string[], unknown];
  expect(options).toEqual({ select: true, focus: true, expand: 3 });
  expect(chain).toHaveLength(2);
  // The handles are the ones the workbench later gets for the same elements.
  const rootRows = await trees.$getChildren('e', 'tree');
  expect(rootRows[1].handle).toBe(chain[0]);
  expect((await trees.$getChildren('e', 'tree', chain[0]))[0]).toMatchObject({ handle: chain[1], label: 'Leek' });
  await view.reveal(roots[0], { select: false, expand: true });
  expect(proxy.$reveal).toHaveBeenLastCalledWith('e', 'tree', [rootRows[0].handle], { select: false, focus: false, expand: 1 });
  await view.reveal(roots[0]);
  expect(proxy.$reveal).toHaveBeenLastCalledWith('e', 'tree', [rootRows[0].handle], { select: true, focus: false, expand: 0 });
});

test('selection, expansion and visibility events carry the extension\'s own elements', async () => {
  const proxy = mainThread();
  const trees = new ExtHostTreeViews(proxy, () => ['tree']);
  const roots = tree(['Fruit', ['Apple', 'Pear']]);
  const view = trees.createTreeView('e', 'tree', provider(() => roots).provider);
  const [fruit] = await trees.$getChildren('e', 'tree');
  const [apple, pear] = await trees.$getChildren('e', 'tree', fruit.handle);
  const selections: unknown[][] = [];
  view.onDidChangeSelection(event => selections.push([...event.selection]));
  const expanded = vi.fn();
  const collapsed = vi.fn();
  const visibility = vi.fn();
  view.onDidExpandElement(expanded);
  view.onDidCollapseElement(collapsed);
  view.onDidChangeVisibility(visibility);

  await trees.$setSelection('e', 'tree', [apple.handle, pear.handle]);
  expect(selections).toEqual([[roots[0].children![0], roots[0].children![1]]]);
  expect(selections[0][0]).toBe(roots[0].children![0]);
  expect(view.selection[1]).toBe(roots[0].children![1]);
  await trees.$setSelection('e', 'tree', [apple.handle, pear.handle]);
  expect(selections).toHaveLength(1);
  // Another extension cannot drive this view.
  await trees.$setSelection('other', 'tree', [fruit.handle]);
  expect(selections).toHaveLength(1);

  await trees.$setExpanded('e', 'tree', fruit.handle, true);
  await trees.$setExpanded('e', 'tree', fruit.handle, false);
  expect(expanded).toHaveBeenCalledExactlyOnceWith({ element: roots[0] });
  expect(expanded.mock.calls[0][0].element).toBe(roots[0]);
  expect(collapsed).toHaveBeenCalledExactlyOnceWith({ element: roots[0] });

  expect(view.visible).toBe(false);
  await trees.$setVisible('e', 'tree', true);
  await trees.$setVisible('e', 'tree', true);
  expect(view.visible).toBe(true);
  expect(visibility).toHaveBeenCalledExactlyOnceWith({ visible: true });
});

test('a full refresh lets a node with a stable id move to another parent (wr-5r5z)', async () => {
  const trees = new ExtHostTreeViews(mainThread(), () => ['tree']);
  let roots = tree(['A', ['Moving', 'Staying']], ['B', []]);
  const { provider: data, changes } = provider(() => roots, { ids: true });
  trees.createTreeView('e', 'tree', data);
  const [a, b] = await trees.$getChildren('e', 'tree');
  expect((await trees.$getChildren('e', 'tree', a.handle)).map(row => row.label)).toEqual(['Moving', 'Staying']);
  expect(await trees.$getChildren('e', 'tree', b.handle)).toEqual([]);

  roots = tree(['A', ['Staying']], ['B', ['Moving']]);
  changes.fire(undefined);
  await trees.$getChildren('e', 'tree');
  // The new parent may be listed before the old one.
  const moved = await trees.$getChildren('e', 'tree', b.handle);
  expect(moved.map(row => row.label)).toEqual(['Moving']);
  expect((await trees.$getChildren('e', 'tree', a.handle)).map(row => row.label)).toEqual(['Staying']);
  // Listing the old parent did not drop the node that moved away from it.
  expect(trees.resolveArgument('e', { kind: 'extensionTreeItem', extension: 'e', view: 'tree', handle: moved[0].handle }))
    .toBe(roots[1].children![0]);

  // Without a full refresh, the same id under two parents is still an error.
  roots = tree(['A', ['Moving', 'Staying']], ['B', ['Moving']]);
  await trees.$getChildren('e', 'tree');
  await expect(trees.$getChildren('e', 'tree', a.handle)).rejects.toThrow("has duplicate item id 'Moving'");
});

test('items carry icons, a label from their resource, accessibility and a late tooltip', async () => {
  const trees = new ExtHostTreeViews(mainThread(), () => ['tree']);
  const folder = URI.parse('https://example.com/extension/');
  const icons: vscode.TreeItem['iconPath'][] = [
    new ThemeIcon('pass', new ThemeColor('charts.green')),
    URI.joinPath(folder, 'a.svg'),
    { light: URI.joinPath(folder, 'light.svg'), dark: URI.joinPath(folder, 'dark.svg') },
    '/not/a/browser/path.svg',
  ];
  const resolve = vi.fn(async (item: vscode.TreeItem) => {
    item.tooltip = 'Resolved ' + item.label;
    return item;
  });
  trees.createTreeView('e', 'tree', {
    getChildren: () => [0, 1, 2, 3],
    getTreeItem: index => {
      const item = index === 1 ? new TreeItem(URI.parse('https://example.com/docs/readme.md')) : new TreeItem('Item ' + index);
      item.iconPath = icons[index];
      if (index === 0) {
        item.accessibilityInformation = { label: 'First item', role: 'treeitem' };
        item.tooltip = 'Known';
      }
      return item;
    },
    resolveTreeItem: resolve,
  });
  const rows = await trees.$getChildren('e', 'tree');
  expect(rows[0]).toMatchObject({ icon: { kind: 'theme', id: 'pass', color: 'charts.green' },
    accessibilityInformation: { label: 'First item', role: 'treeitem' }, tooltip: 'Known' });
  expect(rows[0].resolvable).toBeUndefined();
  expect(rows[1].label).toBe('readme.md');
  expect(rows[1].icon).toEqual({ kind: 'uri', light: icons[1], dark: icons[1] });
  expect(rows[2].icon).toMatchObject({ kind: 'uri', light: { path: '/extension/light.svg' }, dark: { path: '/extension/dark.svg' } });
  expect(rows[3].icon).toBeUndefined();
  expect(rows[1].resolvable).toBe(true);
  const token = new CancellationTokenSource();
  expect(await trees.$resolveTreeItem('e', 'tree', rows[1].handle, token.token)).toBe('Resolved undefined');
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ resourceUri: expect.anything() }), 1, token.token);
  expect(await trees.$resolveTreeItem('other', 'tree', rows[1].handle)).toBeUndefined();
});

test('title, description, message and badge go to the workbench; the title starts as the view name', () => {
  const proxy = mainThread();
  const trees = new ExtHostTreeViews(proxy, () => ['tree'], (_extension, view) => view === 'tree' ? 'Contributed' : undefined);
  const view = trees.createTreeView('e', 'tree', { getChildren: () => [], getTreeItem: () => new TreeItem('') });
  expect(view.title).toBe('Contributed');
  view.title = 'Renamed';
  view.description = 'Details';
  expect(proxy.$setTitle).toHaveBeenLastCalledWith('e', 'tree', 'Renamed', 'Details');
  view.message = 'Nothing yet';
  expect(proxy.$setMessage).toHaveBeenCalledWith('e', 'tree', 'Nothing yet');
  view.badge = { value: -4.6, tooltip: 'Four' };
  expect(view.badge).toEqual({ value: 4, tooltip: 'Four' });
  expect(proxy.$setBadge).toHaveBeenLastCalledWith('e', 'tree', { value: 4, tooltip: 'Four' });
  view.badge = { value: 'x' } as unknown as vscode.ViewBadge;
  expect(proxy.$setBadge).toHaveBeenCalledOnce();
  view.badge = undefined;
  expect(proxy.$setBadge).toHaveBeenLastCalledWith('e', 'tree', undefined);
  view.dispose();
  view.title = 'Gone';
  expect(proxy.$setTitle).toHaveBeenCalledTimes(2);
});

test('the item constructor takes a resource and the check box state enum exists', () => {
  const resource = URI.parse('https://example.com/a/b.txt');
  const item = new TreeItem(resource, TreeItemCollapsibleState.Expanded);
  expect(item.resourceUri).toBe(resource);
  expect(item.label).toBeUndefined();
  expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
  expect(TreeItemCheckboxState.Checked).toBe(1);
});

test('a check box change updates the item and reports the extension\'s element', async () => {
  const trees = new ExtHostTreeViews(mainThread(), () => ['tree']);
  const elements = [{ name: 'Plain' }, { name: 'Detailed' }];
  const items = new Map<object, TreeItem>();
  const view = trees.createTreeView('e', 'tree', {
    getChildren: () => elements,
    getTreeItem: element => {
      const item = new TreeItem(element.name);
      item.checkboxState = element === elements[0] ? TreeItemCheckboxState.Unchecked
        : { state: TreeItemCheckboxState.Checked, tooltip: 'Done', accessibilityInformation: { label: 'Mark done' } };
      items.set(element, item);
      return item;
    },
  });
  const rows = await trees.$getChildren('e', 'tree');
  expect(rows.map(row => row.checkbox)).toEqual([
    { checked: false },
    { checked: true, tooltip: 'Done', accessibilityInformation: { label: 'Mark done', role: undefined } },
  ]);
  const events: unknown[] = [];
  view.onDidChangeCheckboxState(event => events.push(event.items));
  await trees.$changeCheckboxState('e', 'tree', [[rows[0].handle, true], [rows[1].handle, false]]);
  expect(events).toEqual([[[elements[0], TreeItemCheckboxState.Checked], [elements[1], TreeItemCheckboxState.Unchecked]]]);
  expect((events[0] as [unknown][])[0][0]).toBe(elements[0]);
  expect(items.get(elements[0])!.checkboxState).toBe(TreeItemCheckboxState.Checked);
  expect(items.get(elements[1])!.checkboxState).toEqual({ state: TreeItemCheckboxState.Unchecked, tooltip: 'Done', accessibilityInformation: { label: 'Mark done' } });
  await trees.$changeCheckboxState('other', 'tree', [[rows[0].handle, false]]);
  expect(events).toHaveLength(1);
});

test('handleDrop gets what handleDrag put in for the same extension, and strings for another', async () => {
  const proxy = mainThread();
  const trees = new ExtHostTreeViews(proxy, () => ['source', 'target', 'foreign']);
  const payload = { kind: 'notes', count: 2 };
  const dropped: { target: unknown; values: [string, unknown][] }[] = [];
  const controller = (name: string): vscode.TreeDragAndDropController<string> => ({
    dragMimeTypes: ['application/vnd.test.notes'],
    dropMimeTypes: ['application/vnd.test.notes', 'files'],
    handleDrag: (source, transfer) => {
      transfer.set('application/vnd.test.notes', new DataTransferItem({ ...payload, source }));
    },
    handleDrop: async (target, transfer) => {
      const values: [string, unknown][] = [];
      for (const [mimeType, item] of transfer) {
        values.push([mimeType, item.asFile() ? await item.asFile()!.data().then(data => data.length, error => error.message) : item.value]);
      }
      dropped.push({ target: name + ':' + target, values });
    },
  });
  const provider = (names: string[]): vscode.TreeDataProvider<string> => ({ getChildren: () => names, getTreeItem: name => new TreeItem(name) });
  trees.createTreeView('e', 'source', provider(['a', 'b']), { dragAndDropController: controller('source') });
  trees.createTreeView('e', 'target', provider(['t']), { dragAndDropController: controller('target') });
  trees.createTreeView('f', 'foreign', provider(['x']), { dragAndDropController: controller('foreign') });
  expect(proxy.$registerTreeViewDataProvider).toHaveBeenCalledWith('e', 'source', expect.objectContaining({
    dragMimeTypes: ['application/vnd.test.notes'], hasHandleDrag: true, hasHandleDrop: true,
  }));
  const [a, b] = await trees.$getChildren('e', 'source');
  const [t] = await trees.$getChildren('e', 'target');
  await trees.$getChildren('f', 'foreign');

  const strings = await trees.$handleDrag('e', 'source', [a.handle, b.handle], 'drag-1');
  expect(strings).toEqual([{ mimeType: 'application/vnd.test.notes', value: JSON.stringify({ ...payload, source: ['a', 'b'] }) }]);
  await trees.$handleDrop('e', 'target', t.handle, strings, 'drag-1');
  expect(dropped[0].target).toBe('target:t');
  // The very value the source put in, not its JSON text.
  expect(dropped[0].values).toEqual([['application/vnd.test.notes', { ...payload, source: ['a', 'b'] }]]);

  await trees.$handleDrag('e', 'source', [a.handle], 'drag-2');
  // Another extension names the drag but gets only the strings.
  await trees.$handleDrop('f', 'foreign', undefined, strings, 'drag-2');
  expect(dropped[1].values).toEqual([['application/vnd.test.notes', JSON.stringify({ ...payload, source: ['a', 'b'] })]]);
  await trees.$releaseDrag('e', 'drag-2');
  await trees.$handleDrop('e', 'target', undefined, [], 'drag-2');
  expect(dropped[2].values).toEqual([]);

  // Files from the operating system: their bytes, or an error when they were over the limit.
  await trees.$handleDrop('e', 'target', undefined, [
    { mimeType: 'text/plain', value: '', file: { name: 'small.txt', data: new Uint8Array(3) } },
    { mimeType: 'image/png', value: '', file: { name: 'huge.png' } },
  ], undefined);
  expect(dropped[3].values).toEqual([['text/plain', 3], ['image/png', "The file 'huge.png' is too large to drop."]]);

  // Releasing the extension forgets its drags.
  await trees.$handleDrag('e', 'source', [a.handle], 'drag-3');
  trees.remove('e');
  trees.createTreeView('e', 'target', provider(['t']), { dragAndDropController: controller('target') });
  const [again] = await trees.$getChildren('e', 'target');
  await trees.$handleDrop('e', 'target', again.handle, [], 'drag-3');
  expect(dropped[4].values).toEqual([]);
});
