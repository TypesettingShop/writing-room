import { expect, test, vi } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { TreeViewModel } from '../../../../browser/parts/views/treeViewModel.js';
import type { TreeItemDto } from '../../../../api/common/extHost.protocol.js';

test('refreshes an expanded node in place without requesting the root', async () => {
  const refresh = new Emitter<readonly string[] | undefined>();
  const root: TreeItemDto = { handle: 'parent', label: 'Parent', collapsible: 1 };
  const child: TreeItemDto = { handle: 'child', label: 'Child', collapsible: 0 };
  const getChildren = vi.fn(async (handle?: string) => handle ? [child] : [root]);
  const getItem = vi.fn(async () => ({ ...root, label: 'Updated parent' }));
  const model = new TreeViewModel({
    getChildren, getItem, onDidRefresh: refresh.event,
    reference: handle => ({ handle, view: 'tree', extension: 'e', kind: 'extensionTreeItem' }),
  });
  await vi.waitFor(() => expect(model.rows).toHaveLength(1));
  model.setExpanded('parent', true);
  await vi.waitFor(() => expect(model.rows).toHaveLength(2));
  getChildren.mockClear();
  refresh.fire(['parent']);
  await vi.waitFor(() => expect(model.rows.map(({ item }) => item.label)).toEqual(['Updated parent', 'Child']));
  expect(getItem).toHaveBeenCalledExactlyOnceWith('parent');
  expect(getChildren).toHaveBeenCalledExactlyOnceWith('parent');
  expect(model.rows[0].expanded).toBe(true);
  model.dispose();
  refresh.dispose();
});

test('asks for a collapsed subtree again after a full refresh', async () => {
  const refresh = new Emitter<readonly string[] | undefined>();
  const parent: TreeItemDto = { handle: 'parent', label: 'Parent', collapsible: 1 };
  const group: TreeItemDto = { handle: 'group', label: 'Group', collapsible: 1 };
  let leaf: TreeItemDto = { handle: 'old', label: 'Old', collapsible: 0 };
  const model = new TreeViewModel({
    getChildren: async handle => handle === 'parent' ? [group] : handle === 'group' ? [leaf] : [parent],
    getItem: async () => undefined,
    onDidRefresh: refresh.event,
    reference: handle => ({ handle, view: 'tree', extension: 'e', kind: 'extensionTreeItem' }),
  });
  const labels = () => model.rows.map(({ item }) => item.label);
  await vi.waitFor(() => expect(labels()).toEqual(['Parent']));
  model.setExpanded('parent', true);
  await vi.waitFor(() => expect(labels()).toEqual(['Parent', 'Group']));
  model.setExpanded('group', true);
  await vi.waitFor(() => expect(labels()).toEqual(['Parent', 'Group', 'Old']));
  model.setExpanded('parent', false);
  leaf = { handle: 'new', label: 'New', collapsible: 0 };
  const reloaded = new Promise<void>(resolve => {
    const listener = model.onDidChange(() => {
      listener.dispose();
      resolve();
    });
  });
  refresh.fire(undefined);
  await reloaded;
  model.setExpanded('parent', true);
  await vi.waitFor(() => expect(labels()).toEqual(['Parent', 'Group', 'New']));
  model.dispose();
  refresh.dispose();
});
