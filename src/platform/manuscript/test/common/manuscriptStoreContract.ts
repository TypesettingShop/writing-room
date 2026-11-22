import { beforeEach, describe, expect, it } from 'vitest';
import { etag } from '../../../files/common/files.js';
import { documentEtag, isManuscriptId, manuscriptLimits } from '../../common/manuscript.js';
import type { ManuscriptStore } from '../../common/manuscriptStore.js';

export const contractOwner = '00000000-0000-4000-8000-000000000001';
export const contractOther = '00000000-0000-4000-8000-000000000002';
export const contractTime = 1_790_000_000_000;

interface ContractStores {
  owner: ManuscriptStore;
  other: ManuscriptStore;
  seedFullWork?(workId: string): Promise<number>;
}

export async function fillWork(store: ManuscriptStore, workId: string): Promise<number> {
  let revision = 0;
  for (let position = 0; position < manuscriptLimits.nodes; position++) {
    ({ revision } = await store.createNode(workId, { kind: 'part', parentId: null, title: '' }, revision));
  }
  return revision;
}

export function manuscriptStoreContract(
  name: string,
  makeStores: () => Promise<ContractStores>,
): void {
  describe(name, () => {
    let owner: ManuscriptStore;
    let other: ManuscriptStore;
    let workId: string;
    let seedFullWork: ContractStores['seedFullWork'];

    beforeEach(async () => {
      ({ owner, other, seedFullWork } = await makeStores());
      workId = (await owner.createWork({ title: ' 한글 ' })).id;
    });

    const add = (revision: number, title: string, parentId: string | null = null) =>
      owner.createNode(workId, { kind: 'document', title, parentId }, revision);

    it('normalizes titles, assigns canonical IDs and keeps copies', async () => {
      expect(isManuscriptId(workId)).toBe(true);
      const work = await owner.getWork(workId);
      expect(work.title).toBe('한글');
      work.title = 'changed';
      expect(await owner.listWorks()).toContainEqual({ ...work, title: '한글' });
      expect(await owner.getTree(workId)).toEqual({ revision: 0, nodes: [] });
      const { node } = await add(0, ' 한글 ');
      const metadata = { labels: ['draft'] };
      const update = await owner.updateNode(workId, node.id, { metadata }, 1);
      metadata.labels[0] = 'changed';
      update.node.title = 'changed';
      (update.node.metadata.labels as string[]).push('changed');
      const tree = await owner.getTree(workId);
      expect(tree).toMatchObject({ revision: 2, nodes: [{ title: '한글', metadata: { labels: ['draft'] } }] });
      tree.nodes[0].title = 'changed';
      expect((await owner.getTree(workId)).nodes[0].title).toBe('한글');
    });

    it('returns not found for another owner and a document ID from another work', async () => {
      const { node } = await add(0, '');
      const otherWork = await other.createWork({ title: 'Private' });
      expect(await other.listWorks()).toContainEqual(otherWork);
      expect((await other.listWorks()).some(work => work.id === workId)).toBe(false);
      for (const access of [
        () => other.getWork(workId),
        () => other.getTree(workId),
        () => other.createNode(workId, { parentId: null, kind: 'document', title: '' }, 1),
        () => other.updateNode(workId, node.id, { title: 'changed' }, 1),
        () => other.moveNodes(workId, [node.id], { parentId: null }, 1),
        () => other.deleteNode(workId, node.id, 1),
        () => other.statDocument(workId, node.id),
        () => other.readDocument(workId, node.id),
        () => other.writeDocument(workId, node.id, 'changed'),
        () => other.readDocument(otherWork.id, node.id),
      ]) {
        await expect(access()).rejects.toMatchObject({ code: 'not_found' });
      }
      expect((await owner.readDocument(workId, node.id)).content).toBe('');
      expect((await owner.getTree(workId)).revision).toBe(1);
    });

    it('applies only one same-revision move and preserves the tree on validation failure', async () => {
      const { node: a } = await add(0, 'a');
      const { node: b } = await add(1, 'b');
      const { node: c } = await add(2, 'c');
      const outcomes = await Promise.allSettled([
        owner.moveNodes(workId, [c.id], { parentId: null, beforeId: a.id }, 3),
        owner.moveNodes(workId, [a.id], { parentId: null }, 3),
      ]);
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes).toContainEqual({ status: 'rejected', reason: expect.objectContaining({ code: 'conflict', currentRevision: 4 }) });
      const tree = await owner.getTree(workId);
      await expect(owner.moveNodes(workId, [a.id, b.id], { parentId: null, beforeId: workId }, 4))
        .rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.updateNode(workId, a.id, { title: 'stale' }, 3))
        .rejects.toMatchObject({ code: 'conflict', currentRevision: 4 });
      expect(await owner.getTree(workId)).toEqual(tree);
      expect(tree.nodes.map(node => node.position)).toEqual([0, 1, 2]);
    });

    it('moves selected roots in tree order, checks containment and deletes descendants', async () => {
      const { node: part } = await owner.createNode(workId, { kind: 'part', parentId: null, title: 'part' }, 0);
      const { node: chapter } = await owner.createNode(workId, { kind: 'chapter', parentId: part.id, title: 'chapter' }, 1);
      const { node: child } = await add(2, 'child', chapter.id);
      const { node: sibling } = await add(3, 'sibling', part.id);
      const { node: root } = await add(4, 'root');
      const before = await owner.getTree(workId);
      await expect(owner.moveNodes(workId, [part.id], { parentId: chapter.id }, 5)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.moveNodes(workId, [chapter.id], { parentId: chapter.id }, 5)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.createNode(workId, { kind: 'chapter', parentId: child.id, title: '' }, 5)).rejects.toMatchObject({ code: 'invalid' });
      expect(await owner.getTree(workId)).toEqual(before);

      expect(await owner.moveNodes(workId, [sibling.id, child.id, chapter.id], { parentId: null, beforeId: root.id }, 5))
        .toEqual({ revision: 6 });
      const tree = await owner.getTree(workId);
      expect(tree.nodes.map(({ id, parentId, position }) => [id, parentId, position])).toEqual([
        [part.id, null, 0], [chapter.id, null, 1], [child.id, chapter.id, 0], [sibling.id, null, 2], [root.id, null, 3],
      ]);
      expect(await owner.moveNodes(workId, [root.id], { parentId: null }, 6)).toEqual({ revision: 6 });
      expect(await owner.deleteNode(workId, chapter.id, 6)).toEqual({ revision: 7, deletedDocumentIds: [child.id] });
      expect((await owner.getTree(workId)).nodes.map(node => node.position)).toEqual([0, 1, 2]);
      await expect(owner.readDocument(workId, child.id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('writes UTF-8 documents atomically without changing the tree revision', async () => {
      const { node } = await add(0, '');
      const initial = await owner.statDocument(workId, node.id);
      const expected = documentEtag(initial.mtime, initial.size);
      expect(expected).toBe(etag(initial));
      const results = await Promise.allSettled([
        owner.writeDocument(workId, node.id, '한글', expected),
        owner.writeDocument(workId, node.id, '한글', expected),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results).toContainEqual({ status: 'rejected', reason: expect.objectContaining({ code: 'precondition_failed' }) });
      const stat = await owner.statDocument(workId, node.id);
      expect(stat).toEqual({ mtime: initial.mtime + 1, size: 6 });
      expect(await owner.readDocument(workId, node.id)).toEqual({ ...stat, content: '한글' });
      const next = await owner.writeDocument(workId, node.id, '한글', etag(stat));
      expect(next.mtime).toBe(stat.mtime + 1);
      expect((await owner.getTree(workId)).revision).toBe(1);
    });

    it('rejects the 10,001st node and leaves the full work untouched', async () => {
      expect(manuscriptLimits.nodes).toBe(10_000);
      const revision = await (seedFullWork ? seedFullWork(workId) : fillWork(owner, workId));
      await expect(add(revision, 'One too many')).rejects.toMatchObject({ code: 'limit' });
      const tree = await owner.getTree(workId);
      expect(tree.revision).toBe(revision);
      expect(tree.nodes).toHaveLength(manuscriptLimits.nodes);
    }, 60_000);

    it('enforces titles, metadata and document limits before writing', async () => {
      await expect(owner.createWork({ title: ' ' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(add(0, 'bad\n')).rejects.toMatchObject({ code: 'invalid' });
      await expect(add(0, 'a'.repeat(manuscriptLimits.title + 1))).rejects.toMatchObject({ code: 'invalid' });
      const { node } = await add(0, '🙂'.repeat(manuscriptLimits.title));
      await expect(owner.updateNode(workId, node.id, { metadata: { text: 'a'.repeat(manuscriptLimits.metadata) } }, 1))
        .rejects.toMatchObject({ code: 'too_large' });
      await expect(owner.writeDocument(workId, node.id, 'a'.repeat(manuscriptLimits.document + 1)))
        .rejects.toMatchObject({ code: 'too_large' });
      expect(await owner.readDocument(workId, node.id)).toMatchObject({ content: '', size: 0 });
      expect((await owner.getTree(workId)).revision).toBe(1);
    }, 15_000);
  });
}
