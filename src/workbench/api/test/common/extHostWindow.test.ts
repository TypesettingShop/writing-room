// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { ExtHostTreeViews } from '../../common/extHostTreeViews.js';
import { ExtHostStatusBar } from '../../common/extHostStatusBar.js';
import { ExtHostMessageService } from '../../common/extHostMessageService.js';
import { EventEmitter, TreeItem, TreeItemCollapsibleState } from '../../common/extHostTypes.js';

test('isolates provider elements, refreshes by handle and disposes tree registrations', async () => {
  const refresh = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const trees = new ExtHostTreeViews({
    $registerTreeViewDataProvider: vi.fn(async () => {}),
    $refresh: refresh,
    $disposeTree: dispose,
  }, () => ['tree']);
  const events = new EventEmitter<{ label: string }>();
  const root = { label: 'Parent' };
  const child = { label: 'Child' };
  const provider = {
    onDidChangeTreeData: events.event,
    getChildren: (element?: typeof root) => element === root ? [child] : [root],
    getTreeItem: (element: typeof root) => {
      const item = new TreeItem(element.label, element === root
        ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
      if (element === child) {
        item.id = 'child';
        item.command = { title: 'Select', command: 'test.select', arguments: [child] };
      }
      return item;
    },
  };
  expect(() => trees.createTreeView('e', 'missing', provider)).toThrow('No view is registered with id: missing');
  const registration = trees.createTreeView('e', 'tree', provider);
  const [parent] = await trees.$getChildren('e', 'tree');
  const [row] = await trees.$getChildren('e', 'tree', parent.handle);
  expect(trees.resolveArgument('e', row.command?.args?.[0])).toBe(child);
  child.label = 'Updated';
  events.fire(child);
  expect(refresh).toHaveBeenCalledWith('e', 'tree', [row.handle]);
  expect(await trees.$getTreeItem('e', 'tree', row.handle)).toMatchObject({ handle: row.handle, label: 'Updated' });
  expect((await trees.$getChildren('e', 'tree', parent.handle))[0].handle).toBe(row.handle);
  registration.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  expect(await trees.$getChildren('e', 'tree')).toEqual([]);
  trees.createTreeView('e', 'tree', {
    getChildren: () => ['bad'],
    getTreeItem: () => ({
      label: 'Bad', command: { title: 'Bad', command: 'test.bad', arguments: [() => {}] },
    }),
  });
  await expect(trees.$getChildren('e', 'tree')).rejects.toThrow('command arguments must be structured-cloneable');
  trees.remove('e');
  expect(dispose).toHaveBeenCalledTimes(2);
});

test('batches visible status updates and removes hidden and disposed entries', async () => {
  const set = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const service = new ExtHostStatusBar({ $setEntry: set, $disposeEntry: dispose });
  const entry = service.createStatusBarItem('extension');
  entry.show();
  entry.text = '$(beaker) test';
  entry.tooltip = 'tip';
  await Promise.resolve();
  expect(set).toHaveBeenCalledExactlyOnceWith('extension', entry.id, expect.objectContaining({
    text: '$(beaker) test', tooltip: 'tip',
  }));
  entry.hide();
  expect(dispose).toHaveBeenCalledExactlyOnceWith('extension', entry.id);
  entry.show();
  await Promise.resolve();
  service.remove('extension');
  expect(dispose).toHaveBeenCalledTimes(2);
  entry.show();
  await Promise.resolve();
  expect(set).toHaveBeenCalledTimes(2);
});

test('returns the original message item or undefined when dismissed', async () => {
  const show = vi.fn(async (_extension, _severity, _message, _items) => 1 as number | undefined);
  const service = new ExtHostMessageService({ $showMessage: show });
  const choices = [{ title: 'First' }, { title: 'Second' }];
  expect(await service.showMessage('e', 'warning', 'Pick one', choices)).toBe(choices[1]);
  expect(show).toHaveBeenCalledWith('e', 'warning', 'Pick one', ['First', 'Second']);
  show.mockResolvedValueOnce(undefined);
  expect(await service.showMessage('e', 'info', 'Dismiss me', ['OK'])).toBeUndefined();
});
