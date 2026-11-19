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

function source(children: (parent?: string) => Promise<TreeItemDto[]>) {
  const refresh = new Emitter<readonly string[] | undefined>();
  const model = new TreeViewModel({
    getChildren: vi.fn(children), getItem: async () => undefined, onDidRefresh: refresh.event,
    reference: handle => ({ handle, view: 'tree', extension: 'e', kind: 'extensionTreeItem' }),
  });
  return { model, refresh };
}

test('reveal loads and expands the ancestors and then the asked levels below', async () => {
  const folder = (handle: string): TreeItemDto => ({ handle, label: handle, collapsible: 1 });
  const { model, refresh } = source(async parent => {
    switch (parent) {
      case undefined: return [folder('a'), folder('b')];
      case 'b': return [folder('b1')];
      case 'b1': return [folder('b2')];
      case 'b2': return [{ handle: 'leaf', label: 'leaf', collapsible: 0 }];
      default: return [];
    }
  });
  const expansions: unknown[] = [];
  model.onDidChangeExpansion(change => expansions.push(change));
  expect(await model.reveal(['b', 'b1'], 2)).toBe(true);
  expect(model.rows.map(({ item, expanded }) => item.handle + (expanded ? '+' : ''))).toEqual(['a', 'b+', 'b1+', 'b2+', 'leaf']);
  expect(expansions).toEqual([
    { handle: 'b', expanded: true }, { handle: 'b1', expanded: true }, { handle: 'b2', expanded: true },
  ]);
  expect(await model.reveal(['a', 'missing'], 0)).toBe(false);
  model.dispose();
  refresh.dispose();
});

test('a full refresh shows a node that moved to another parent once, whichever parent loads first (wr-5r5z)', async () => {
  for (const first of ['old', 'new']) {
    let moved = false;
    const release = new Map<string, () => void>();
    const { model, refresh } = source(async parent => {
      const node = (handle: string, collapsible: 0 | 1 = 0): TreeItemDto => ({ handle, label: handle, collapsible });
      if (parent === undefined) {
        return [node('old', 1), node('new', 1)];
      }
      if (parent === 'id:moving') {
        return [node('grandchild')];
      }
      if (moved) {
        // Hold each parent's answer so the test picks which one lands first.
        await new Promise<void>(resolve => release.set(parent, resolve));
      }
      return (parent === 'old') !== moved ? [node('id:moving', 1), node(parent + '-child')] : [node(parent + '-child')];
    });
    const labels = () => model.rows.map(({ item }) => item.label);
    await vi.waitFor(() => expect(labels()).toEqual(['old', 'new']));
    model.setExpanded('old', true);
    model.setExpanded('new', true);
    await vi.waitFor(() => expect(labels()).toEqual(['old', 'id:moving', 'old-child', 'new', 'new-child']));
    model.setExpanded('id:moving', true);
    await vi.waitFor(() => expect(labels()).toEqual(['old', 'id:moving', 'grandchild', 'old-child', 'new', 'new-child']));
    moved = true;
    refresh.fire(undefined);
    await vi.waitFor(() => expect(release.size).toBe(2));
    release.get(first)!();
    await vi.waitFor(() => expect(labels()).not.toEqual(['old', 'id:moving', 'grandchild', 'old-child', 'new', 'new-child']));
    expect(labels().filter(label => label === 'id:moving').length).toBeLessThanOrEqual(1);
    release.get(first === 'old' ? 'new' : 'old')!();
    // Listed in its new place first, the node keeps its expanded state there.
    const kept = first === 'new' ? ['grandchild'] : [];
    await vi.waitFor(() => expect(labels()).toEqual(['old', 'old-child', 'new', 'id:moving', ...kept, 'new-child']));
    model.dispose();
    refresh.dispose();
  }
});
