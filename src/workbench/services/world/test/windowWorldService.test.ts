// @vitest-environment node

import { expect, it, vi } from 'vitest';
import { isManuscriptId } from '../../../../platform/manuscript/common/manuscript.js';
import { getGregorianCalendar } from '../../../../platform/world/common/calendar.js';
import { worldLimits, worldNodeTypes, WorldStoreError } from '../../../../platform/world/common/world.js';
import { buildWorldPresetNodes, worldPresetIds } from '../../../../platform/world/common/worldPresets.js';
import { buildIndex } from '../../../common/navigator/navigatorTree.js';
import { HttpManuscriptStore } from '../../manuscript/browser/httpManuscriptStore.js';
import { WindowManuscriptService } from '../../manuscript/browser/windowManuscriptService.js';
import { HttpWorldStore } from '../browser/httpWorldStore.js';
import { WindowWorldService } from '../browser/windowWorldService.js';

it.each(worldPresetIds)('opens the %s preset in the navigator', preset => {
  const nodes = buildWorldPresetNodes(preset, () => globalThis.crypto.randomUUID(), 100);
  expect(buildIndex(nodes, {
    types: worldNodeTypes,
    label: node => node.title,
    maxNodes: worldLimits.nodes,
    isId: isManuscriptId,
    invalidTree: 'Invalid world preset',
  })).toMatchObject({ ok: true });
});

it('shares in-memory works and emits tree, calendar and subtree deletion events', async () => {
  const manuscript = new WindowManuscriptService('?store=memory', undefined, status => new HttpManuscriptStore(status));
  const createRemote = vi.fn(status => new HttpWorldStore(status));
  const world = new WindowWorldService(manuscript, createRemote);
  try {
    expect(world.usesMemory).toBe(true);
    expect(createRemote).not.toHaveBeenCalled();
    const tree = vi.fn();
    const calendar = vi.fn();
    const deleted = vi.fn();
    world.onDidChangeTree(tree);
    world.onDidChangeCalendar(calendar);
    world.onDidDeleteNodes(deleted);
    const { id } = await manuscript.store.createWork({ title: 'World' });
    expect(await world.store.getTree(id)).toEqual({ revision: 0, nodes: [] });
    const { nodes } = await world.store.applyPreset(id, 'blank', 0);
    const category = nodes[0];
    const { node: item } = await world.store.createNode(id, { kind: 'item', parentId: category.id, title: '' }, 1);
    await world.store.updateNode(id, item.id, {}, 2);
    await world.store.moveNodes(id, [item.id], { parentId: category.id }, 2);
    await expect(world.store.deleteNode(id, category.id, 1)).rejects.toMatchObject({ code: 'conflict' });
    expect(await world.store.getCalendar(id)).toMatchObject({ revision: 0 });
    expect(calendar).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
    expect(tree.mock.calls).toEqual([[id], [id]]);
    const definition = { ...getGregorianCalendar(), hoursPerDay: 25 };
    expect(await world.store.putCalendar(id, definition, 0)).toEqual({ revision: 1, calendar: definition });
    await expect(world.store.putCalendar(id, definition, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect(calendar.mock.calls).toEqual([[id]]);
    expect(tree.mock.calls).toEqual([[id], [id]]);
    expect(await world.store.deleteNode(id, category.id, 2))
      .toEqual({ revision: 3, deletedNodeIds: [category.id, item.id] });
    expect(tree.mock.calls).toEqual([[id], [id], [id]]);
    expect(deleted.mock.calls).toEqual([[{ workId: id, nodeIds: [category.id, item.id] }]]);
    expect(calendar.mock.calls).toEqual([[id]]);
  } finally {
    world.dispose();
    manuscript.dispose();
  }
});

it('uses the manuscript session and reports world HTTP 401 responses through it', async () => {
  const manuscript = new WindowManuscriptService('', undefined, status =>
    new HttpManuscriptStore(status, async () => Response.json({ works: [] })));
  const world = new WindowWorldService(manuscript, status =>
    new HttpWorldStore(status, async () => new Response(null, { status: 401 })));
  try {
    expect(world.usesMemory).toBe(false);
    await manuscript.store.listWorks();
    expect(manuscript.signedIn).toBe(true);
    const error = await world.store.getCalendar(globalThis.crypto.randomUUID()).catch(error => error);
    expect(error).toBeInstanceOf(WorldStoreError);
    expect(error).toMatchObject({ code: 'unauthorized' });
    expect(manuscript.availability).toBe('signedOut');
    expect(manuscript.signedIn).toBe(false);
  } finally {
    world.dispose();
    manuscript.dispose();
  }
});
