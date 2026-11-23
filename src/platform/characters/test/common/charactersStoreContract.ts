import { beforeEach, describe, expect, it } from 'vitest';
import { isManuscriptId } from '../../../manuscript/common/manuscript.js';
import type { ManuscriptStore } from '../../../manuscript/common/manuscriptStore.js';
import { characterLimits } from '../../common/characters.js';
import type { CharactersStore, CreateCharacterNode, UpdateCharacterNode } from '../../common/charactersStore.js';

interface ContractStores {
  owner: CharactersStore;
  other: CharactersStore;
  ownerWorks: ManuscriptStore;
  otherWorks: ManuscriptStore;
  seedFullWork?(workId: string): Promise<number>;
  seedValuesBudget?(workId: string): Promise<{ revision: number; emptyNodeId: string; fullNodeId: string }>;
}

export async function fillCharacterTree(store: CharactersStore, workId: string): Promise<number> {
  let revision = 0;
  for (let position = 0; position < characterLimits.nodes; position++) {
    ({ revision } = await store.createNode(workId, { kind: 'folder', parentId: null, title: '' }, revision));
  }
  return revision;
}

// {"note":""} adds 11 bytes to the ASCII string.
export const maxCharacterValue = { note: 'x'.repeat(characterLimits.values - 11) };

export async function fillCharacterValues(store: CharactersStore, workId: string) {
  let revision = 0;
  let fullNodeId = '';
  for (let slot = 0; slot < characterLimits.workValues / characterLimits.values; slot++) {
    const created = await store.createNode(workId, { kind: 'character', parentId: null, title: '' }, revision);
    ({ revision } = await store.updateNode(workId, created.node.id, { values: maxCharacterValue }, created.revision));
    fullNodeId = created.node.id;
  }
  const empty = await store.createNode(workId, { kind: 'character', parentId: null, title: '' }, revision);
  return { revision: empty.revision, emptyNodeId: empty.node.id, fullNodeId };
}

export function charactersStoreContract(name: string, makeStores: () => Promise<ContractStores> | ContractStores): void {
  describe(name, () => {
    let stores: ContractStores;
    let owner: CharactersStore;
    let workId: string;
    beforeEach(async () => {
      stores = await makeStores();
      owner = stores.owner;
      workId = (await stores.ownerWorks.createWork({ title: 'Characters contract' })).id;
    });

    function create(revision: number, input: Partial<CreateCharacterNode> = {}) {
      return owner.createNode(workId, { kind: 'character', title: '', parentId: null, ...input }, revision);
    }

    it('round-trips the navigator shape, timestamps, type and independent values', async () => {
      expect(await owner.getTree(workId)).toEqual({ revision: 0, nodes: [] });
      const folder = await create(0, { kind: 'folder', title: 'Notes' });
      expect(folder.node).not.toHaveProperty('type');
      expect(folder.node).not.toHaveProperty('values');
      const { node } = await create(1, { title: '  Cafe\u0301 🐈  ', parentId: folder.node.id });
      expect(node).toMatchObject({ title: 'Café 🐈', kind: 'character', parentId: folder.node.id, position: 0, type: 'unknown', values: {} });
      expect(isManuscriptId(node.id)).toBe(true);
      expect(node.updatedAt).toBe(node.createdAt);

      const values = { retired: '  가\n', role: 'old option' };
      const updated = await owner.updateNode(workId, node.id, { title: 'New name', type: 'animal', values }, 2);
      expect(updated).toMatchObject({ revision: 3, node: { title: 'New name', type: 'animal', values } });
      values.retired = 'changed';
      updated.node.values!.role = 'changed';
      const tree = await owner.getTree(workId);
      expect(tree.nodes[1].values).toEqual({ retired: '  가\n', role: 'old option' });
      tree.nodes[1].values!.retired = 'changed again';
      expect((await owner.getTree(workId)).nodes[1].values!.retired).toBe('  가\n');
      const replacement = await owner.updateNode(workId, node.id, { values: { newField: '' } }, 3);
      expect(replacement.node.values).toEqual({ newField: '' });
      expect(replacement.node.type).toBe('animal');
    });

    it('preserves preorder and sibling positions across moves and returns only deleted character IDs', async () => {
      const { node: folder } = await create(0, { kind: 'folder' });
      const { node: child } = await create(1, { kind: 'folder', parentId: folder.id });
      const { node: nested } = await create(2, { parentId: child.id });
      const { node: sibling } = await create(3, { parentId: folder.id, beforeId: child.id });
      const { node: root } = await create(4, { type: 'female' });
      const before = await owner.getTree(workId);
      expect(before.nodes.map(node => node.id)).toEqual([folder.id, sibling.id, child.id, nested.id, root.id]);
      await expect(owner.moveNodes(workId, [folder.id], { parentId: child.id }, 5)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.moveNodes(workId, [folder.id], { parentId: root.id }, 5)).rejects.toMatchObject({ code: 'invalid' });
      await expect(create(5, { parentId: root.id })).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.moveNodes(workId, [folder.id], { parentId: null, beforeId: nested.id }, 5)).rejects.toMatchObject({ code: 'invalid' });
      expect(await owner.getTree(workId)).toEqual(before);

      expect(await owner.moveNodes(workId, [child.id, nested.id, sibling.id], { parentId: null, beforeId: root.id }, 5))
        .toEqual({ revision: 6 });
      expect((await owner.getTree(workId)).nodes.map(({ id, parentId, position }) => [id, parentId, position])).toEqual([
        [folder.id, null, 0], [sibling.id, null, 1], [child.id, null, 2], [nested.id, child.id, 0], [root.id, null, 3],
      ]);
      expect(await owner.moveNodes(workId, [root.id], { parentId: null }, 6)).toEqual({ revision: 6 });
      expect(await owner.moveNodes(workId, [sibling.id], { parentId: child.id }, 6)).toEqual({ revision: 7 });
      expect(await owner.deleteNode(workId, child.id, 7)).toEqual({ revision: 8, deletedCharacterIds: [nested.id, sibling.id] });
      expect((await owner.getTree(workId)).nodes.map(({ id, position }) => [id, position])).toEqual([[folder.id, 0], [root.id, 1]]);
    });

    it('checks the revision for every write and admits only one concurrent mutation', async () => {
      const { node } = await create(0);
      expect(await owner.updateNode(workId, node.id, {}, 1)).toEqual({ revision: 1, node });
      for (const write of [
        () => create(0),
        () => owner.updateNode(workId, node.id, {}, 0),
        () => owner.moveNodes(workId, [node.id], { parentId: null }, 0),
        () => owner.deleteNode(workId, node.id, 0),
      ]) {
        await expect(write()).rejects.toMatchObject({ code: 'conflict', currentRevision: 1 });
      }
      await expect(create(-1)).rejects.toMatchObject({ code: 'invalid' });
      const outcomes = await Promise.allSettled([
        owner.updateNode(workId, node.id, { type: 'male' }, 1),
        owner.updateNode(workId, node.id, { title: 'Edited' }, 1),
      ]);
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes).toContainEqual({
        status: 'rejected', reason: expect.objectContaining({ code: 'conflict', currentRevision: 2 }),
      });
      expect(await owner.getTree(workId)).toMatchObject({ revision: 2 });
      expect((await stores.ownerWorks.getTree(workId)).revision).toBe(0);
    });

    it('returns not_found across owners, works and malformed resource IDs', async () => {
      const { node } = await create(0, { kind: 'folder' });
      const ownWork = await stores.ownerWorks.createWork({ title: 'Second' });
      const otherWork = await stores.otherWorks.createWork({ title: 'Private' });
      const attempt = { kind: 'character', parentId: null, title: '' } as const;
      for (const access of [
        () => stores.other.getTree(workId),
        () => stores.other.createNode(workId, attempt, 1),
        () => stores.other.updateNode(workId, node.id, { title: 'Other' }, 1),
        () => stores.other.moveNodes(workId, [node.id], { parentId: null }, 1),
        () => stores.other.deleteNode(workId, node.id, 1),
        () => owner.getTree(otherWork.id),
        () => owner.getTree('bad-id'),
        () => owner.createNode(node.id, attempt, 0),
        () => owner.updateNode(ownWork.id, node.id, {}, 0),
        () => owner.deleteNode(workId, 'bad-id', 1),
        () => owner.moveNodes(ownWork.id, [node.id], { parentId: null }, 0),
        () => owner.moveNodes(workId, ['bad-id'], { parentId: null }, 1),
        () => owner.createNode(ownWork.id, { ...attempt, parentId: node.id }, 0),
        () => owner.createNode(ownWork.id, { ...attempt, beforeId: node.id }, 0),
      ]) {
        await expect(access()).rejects.toMatchObject({ code: 'not_found' });
      }
      expect(await owner.getTree(ownWork.id)).toEqual({ revision: 0, nodes: [] });
    });

    it('validates name, node and field values without mutating on error', async () => {
      const { node: folder } = await create(0, { kind: 'folder' });
      const { node: character } = await create(1, { title: '🐈'.repeat(200) });
      const before = await owner.getTree(workId);
      await expect(create(2, { title: 'a'.repeat(201) })).rejects.toMatchObject({ code: 'invalid' });
      await expect(create(2, { title: 'a\n' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(create(2, { kind: 'folder', type: 'animal' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(create(2, { kind: 'document' } as unknown as CreateCharacterNode)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.updateNode(workId, folder.id, { values: {} }, 2)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.updateNode(workId, folder.id, { type: 'male' }, 2)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.updateNode(workId, character.id, { type: 'robot' } as unknown as UpdateCharacterNode, 2))
        .rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.updateNode(workId, character.id, { values: { 'bad key': '' } }, 2))
        .rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.updateNode(workId, character.id, { values: { note: maxCharacterValue.note + 'x' } }, 2))
        .rejects.toMatchObject({ code: 'too_large' });
      expect(await owner.getTree(workId)).toEqual(before);
    });

    it('enforces the work-wide values limit and releases room on deletion', async () => {
      const { revision, emptyNodeId, fullNodeId } = await (stores.seedValuesBudget
        ? stores.seedValuesBudget(workId)
        : fillCharacterValues(owner, workId));
      await expect(owner.updateNode(workId, emptyNodeId, { values: { note: 'x' } }, revision))
        .rejects.toMatchObject({ code: 'too_large' });
      expect(await owner.updateNode(workId, fullNodeId, { values: maxCharacterValue }, revision))
        .toMatchObject({ revision: revision + 1 });
      await owner.deleteNode(workId, fullNodeId, revision + 1);
      await expect(owner.updateNode(workId, emptyNodeId, { values: maxCharacterValue }, revision + 2))
        .resolves.toMatchObject({ revision: revision + 3 });
    }, 60_000);

    it('enforces the shared node limit for both kinds', async () => {
      const revision = await (stores.seedFullWork ? stores.seedFullWork(workId) : fillCharacterTree(owner, workId));
      await expect(create(revision)).rejects.toMatchObject({ code: 'limit' });
      const tree = await owner.getTree(workId);
      expect(tree.revision).toBe(revision);
      expect(tree.nodes).toHaveLength(10_000);
    }, 60_000);
  });
}
