// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { InMemoryManuscriptRepository } from '../../../../../platform/manuscript/common/inMemoryManuscriptStore.js';
import { WindowManuscriptService } from '../../browser/windowManuscriptService.js';

it('chooses memory only explicitly and emits changes after successful tree mutations', async () => {
  const createRemote = vi.fn(() => new InMemoryManuscriptRepository().forUser('remote'));
  const service = new WindowManuscriptService('?store=memory', undefined, createRemote);
  expect(service.usesMemory).toBe(true);
  expect(service.availability).toBe('ready');
  expect(createRemote).not.toHaveBeenCalled();

  const changed = vi.fn();
  const deleted = vi.fn();
  const treeListener = service.onDidChangeTree(changed);
  const deleteListener = service.onDidDeleteDocuments(deleted);
  const { id } = await service.store.createWork({ title: 'Work' });
  const { node } = await service.store.createNode(id, { parentId: null, kind: 'document', title: '' }, 0);
  await expect(service.store.deleteNode(id, node.id, 0)).rejects.toMatchObject({ code: 'conflict' });
  expect(changed.mock.calls).toEqual([[id]]);
  expect(deleted).not.toHaveBeenCalled();
  await service.store.deleteNode(id, node.id, 1);
  expect(changed.mock.calls).toEqual([[id], [id]]);
  expect(deleted.mock.calls).toEqual([[{ workId: id, nodeIds: [node.id] }]]);

  const defaultService = new WindowManuscriptService('', undefined, createRemote);
  expect(defaultService.usesMemory).toBe(false);
  expect(createRemote).toHaveBeenCalledTimes(1);

  treeListener.dispose();
  deleteListener.dispose();
  defaultService.dispose();
  service.dispose();
});
