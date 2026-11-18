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
