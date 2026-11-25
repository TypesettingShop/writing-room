import { beforeEach, describe, expect, it } from 'vitest';
import type { CharacterTemplate } from '../../../characters/common/characterFields.js';
import type { ManuscriptStore } from '../../../manuscript/common/manuscriptStore.js';
import { getGregorianCalendar, type Calendar } from '../../common/calendar.js';
import { worldLimits } from '../../common/world.js';
import type { CreateWorldNode, WorldStore } from '../../common/worldStore.js';

interface ContractStores {
  owner: WorldStore;
  other: WorldStore;
  ownerWorks: ManuscriptStore;
  otherWorks: ManuscriptStore;
  advanceClock(): void;
  seedFullWork?(workId: string): Promise<number>;
  seedValuesBudget?(workId: string): Promise<ValuesBudget>;
}

interface ValuesBudget {
  revision: number;
  categoryId: string;
  fullNodeId: string;
  emptyNodeId: string;
}

const fields: CharacterTemplate = [{ id: 'note', label: 'Note', kind: 'longText' }];
export const fullWorldValue = { note: 'x'.repeat(worldLimits.values - 11) };

export async function fillWorldTree(store: WorldStore, workId: string): Promise<number> {
  let revision = 0;
  for (let i = 0; i < worldLimits.nodes; i++) {
    ({ revision } = await store.createNode(workId, { kind: 'category', title: '', parentId: null }, revision));
  }
  return revision;
}

export async function fillWorldValues(store: WorldStore, workId: string): Promise<ValuesBudget> {
  const category = await store.createNode(workId, { kind: 'category', title: '', parentId: null }, 0);
  const categoryId = category.node.id;
  let revision = category.revision;
  let fullNodeId = '';
  for (let i = 0; i < worldLimits.workData / worldLimits.values - 1; i++) {
    const { node, revision: created } = await store.createNode(workId, { kind: 'item', title: '', parentId: categoryId }, revision);
    ({ revision } = await store.updateNode(workId, node.id, { values: fullWorldValue }, created));
    fullNodeId = node.id;
  }
  const tail = await store.createNode(workId, { kind: 'item', title: '', parentId: categoryId }, revision);
  const empty = await store.createNode(workId, { kind: 'item', title: '', parentId: categoryId }, tail.revision);
  // Leave room for the two 2-byte empty payloads, the category and the last item.
  const values = { note: fullWorldValue.note.slice(4) };
  ({ revision } = await store.updateNode(workId, tail.node.id, { values }, empty.revision));
  return { revision, categoryId, fullNodeId, emptyNodeId: empty.node.id };
}

export function worldStoreContract(name: string, makeStores: () => ContractStores | Promise<ContractStores>): void {
  describe(name, () => {
    let stores: ContractStores;
    let owner: WorldStore;
    let workId: string;

    beforeEach(async () => {
      stores = await makeStores();
      owner = stores.owner;
      workId = (await stores.ownerWorks.createWork({ title: 'World contract' })).id;
    });

    function create(revision: number, patch: Partial<CreateWorldNode> = {}) {
      return owner.createNode(workId, { kind: 'category', title: '', parentId: null, ...patch }, revision);
    }

    it('round-trips normalized titles, fields and replacement values as copies', async () => {
      expect(await owner.getTree(workId)).toEqual({ revision: 0, nodes: [] });
      const category = await create(0, { title: '  Cafe\u0301 🌏  ' });
      expect(category.node).toMatchObject({ title: 'Café 🌏', fields: [], position: 0, parentId: null });
      expect(category.node.updatedAt).toBe(category.node.createdAt);
      const item = await create(1, { kind: 'item', parentId: category.node.id });
      expect(item.node).toMatchObject({ values: {}, parentId: category.node.id, position: 0 });
      const input = [{ ...fields[0], label: ' 메모 ' }];
      const updated = await owner.updateNode(workId, category.node.id, { fields: input }, 2);
      expect(updated.node.fields).toEqual([{ ...fields[0], label: '메모' }]);
      input[0].label = 'changed';
      updated.node.fields![0].label = 'changed';
      const values = { retired: '  가\n', note: 'world' };
      const saved = await owner.updateNode(workId, item.node.id, { title: 'New', values }, 3);
      expect(saved).toMatchObject({ revision: 4, node: { title: 'New', values } });
      values.note = 'changed';
      saved.node.values!.note = 'changed';
      const tree = await owner.getTree(workId);
      expect(tree.nodes[0].fields![0].label).toBe('메모');
      expect(tree.nodes[1].values).toEqual({ retired: '  가\n', note: 'world' });
      tree.nodes[1].values!.note = 'changed';
      expect((await owner.getTree(workId)).nodes[1].values!.note).toBe('world');
      expect((await owner.updateNode(workId, item.node.id, { values: { retired: '' } }, 4)).node.values)
        .toEqual({ retired: '' });
    });

    it('moves selections in tree order, preserves values and deletes whole subtrees', async () => {
      const { node: root } = await create(0);
      const { node: nested } = await create(1, { parentId: root.id });
      const { node: item } = await create(2, { kind: 'item', parentId: nested.id });
      const { node: first } = await create(3, { parentId: root.id, beforeId: nested.id });
      const { node: other } = await create(4);
      await owner.updateNode(workId, nested.id, { fields }, 5);
      await owner.updateNode(workId, item.id, { values: { note: 'keep' } }, 6);
      await owner.updateNode(workId, nested.id, { fields: [] }, 7);
      expect((await owner.getTree(workId)).nodes.map(node => node.id)).toEqual([root.id, first.id, nested.id, item.id, other.id]);
      await expect(owner.moveNodes(workId, [root.id], { parentId: nested.id }, 8)).rejects.toMatchObject({ code: 'invalid' });
      expect(await owner.moveNodes(workId, [nested.id, first.id], { parentId: other.id }, 8)).toEqual({ revision: 9 });
      expect(await owner.moveNodes(workId, [item.id], { parentId: other.id, beforeId: nested.id }, 9)).toEqual({ revision: 10 });
      const tree = await owner.getTree(workId);
      expect(tree.nodes.map(node => [node.id, node.parentId, node.position])).toEqual([
        [root.id, null, 0], [other.id, null, 1], [first.id, other.id, 0], [item.id, other.id, 1], [nested.id, other.id, 2],
      ]);
      expect(tree.nodes[3].values).toEqual({ note: 'keep' });
      expect(await owner.deleteNode(workId, other.id, 10))
        .toEqual({ revision: 11, deletedNodeIds: [other.id, first.id, item.id, nested.id] });
      expect((await owner.getTree(workId)).nodes.map(node => node.id)).toEqual([root.id]);
    });

    it('checks node kinds, field kinds, resource limits and revision types without committing', async () => {
      const { node: category } = await create(0);
      const { node: item } = await create(1, { kind: 'item', parentId: category.id });
      const invalid = { code: 'invalid' };
      await expect(create(2, { kind: 'item' })).rejects.toMatchObject(invalid);
      await expect(create(2, { parentId: item.id })).rejects.toMatchObject(invalid);
      await expect(create(2, { kind: 'calendar' })).rejects.toMatchObject(invalid);
      await expect(create(2, { kind: 'calendar', parentId: category.id })).rejects.toMatchObject(invalid);
      await expect(create(2, { title: '가'.repeat(201) })).rejects.toMatchObject(invalid);
      await expect(create(2.5)).rejects.toMatchObject(invalid);
      await expect(owner.updateNode(workId, category.id, { values: {} }, 2)).rejects.toMatchObject(invalid);
      await expect(owner.updateNode(workId, item.id, { fields }, 2)).rejects.toMatchObject(invalid);
      await expect(owner.updateNode(workId, item.id, { values: { 'bad id': '' } }, 2)).rejects.toMatchObject(invalid);
      await expect(owner.updateNode(workId, category.id, {
        fields: Array.from({ length: 101 }, (_, index) => ({ ...fields[0], id: 'f' + index })),
      }, 2)).rejects.toMatchObject(invalid);
      await expect(owner.updateNode(workId, item.id, { values: { note: fullWorldValue.note + '가' } }, 2))
        .rejects.toMatchObject({ code: 'too_large' });
      expect((await owner.getTree(workId)).revision).toBe(2);
    });

    it('checks expected revisions and serializes concurrent changes independently for tree and calendar', async () => {
      const results = await Promise.allSettled([create(0), create(0)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(result => result.status === 'rejected')).toMatchObject({
        reason: { code: 'conflict', currentRevision: 1 },
      });
      const { nodes: [node] } = await owner.getTree(workId);
      const conflict = { code: 'conflict', currentRevision: 1 };
      await expect(owner.updateNode(workId, node.id, {}, 0)).rejects.toMatchObject(conflict);
      await expect(owner.moveNodes(workId, [node.id], { parentId: null }, 0)).rejects.toMatchObject(conflict);
      await expect(owner.deleteNode(workId, node.id, 0)).rejects.toMatchObject(conflict);
      const calendar = getGregorianCalendar();
      const initial = await owner.getCalendar(workId);
      expect(initial).toEqual({ revision: 0, calendar });
      initial.calendar.months[0].days = 1;
      expect((await owner.getCalendar(workId)).calendar).toEqual(calendar);
      await expect(owner.putCalendar(workId, { ...calendar, version: 2 } as unknown as Calendar, 0))
        .rejects.toMatchObject({ code: 'invalid' });
      calendar.hoursPerDay = 20;
      const calendars = await Promise.allSettled([owner.putCalendar(workId, calendar, 0), owner.putCalendar(workId, calendar, 0)]);
      const saved = calendars.find(result => result.status === 'fulfilled');
      expect(saved?.value).toEqual({ revision: 1, calendar });
      expect(calendars.find(result => result.status === 'rejected')).toMatchObject({ reason: conflict });
      saved!.value.calendar.hoursPerDay = 10;
      calendar.hoursPerDay = 15;
      expect((await owner.getCalendar(workId)).calendar.hoursPerDay).toBe(20);
      expect((await owner.getTree(workId)).revision).toBe(1);
      await create(1);
      expect((await owner.getCalendar(workId)).revision).toBe(1);
    });

    it('checks work ownership and scopes all node IDs to their work', async () => {
      const missing = { code: 'not_found' };
      const { node } = await create(0);
      const otherWorkId = (await stores.otherWorks.createWork({ title: 'Different owner' })).id;
      const sameOwnerId = (await stores.ownerWorks.createWork({ title: 'Same owner' })).id;
      const calendar = getGregorianCalendar();
      for (const [store, id] of [[stores.other, workId], [owner, otherWorkId], [owner, 'bad-id']] as const) {
        await expect(store.getTree(id)).rejects.toMatchObject(missing);
        await expect(store.getCalendar(id)).rejects.toMatchObject(missing);
        await expect(store.putCalendar(id, calendar, 0)).rejects.toMatchObject(missing);
        await expect(store.createNode(id, { kind: 'category', title: '', parentId: null }, 0)).rejects.toMatchObject(missing);
        await expect(store.updateNode(id, node.id, {}, 0)).rejects.toMatchObject(missing);
        await expect(store.moveNodes(id, [node.id], { parentId: null }, 0)).rejects.toMatchObject(missing);
        await expect(store.deleteNode(id, node.id, 0)).rejects.toMatchObject(missing);
      }
      for (const foreign of [node.id, 'bad-id', globalThis.crypto.randomUUID()]) {
        await expect(owner.updateNode(sameOwnerId, foreign, {}, 0)).rejects.toMatchObject(missing);
        await expect(owner.deleteNode(sameOwnerId, foreign, 0)).rejects.toMatchObject(missing);
        await expect(owner.moveNodes(sameOwnerId, [foreign], { parentId: null }, 0)).rejects.toMatchObject(missing);
        await expect(owner.createNode(sameOwnerId, { kind: 'category', title: '', parentId: foreign }, 0)).rejects.toMatchObject(missing);
        await expect(owner.createNode(sameOwnerId, { kind: 'category', title: '', parentId: null, beforeId: foreign }, 0))
          .rejects.toMatchObject(missing);
      }
    });

    it('touches works only on successful writes that change a revision', async () => {
      const before = (await stores.ownerWorks.getWork(workId)).updatedAt;
      stores.advanceClock();
      const { node } = await create(0);
      const treeTime = (await stores.ownerWorks.getWork(workId)).updatedAt;
      expect(treeTime).toBeGreaterThan(before);
      stores.advanceClock();
      expect((await owner.updateNode(workId, node.id, {}, 1)).revision).toBe(1);
      expect(await owner.moveNodes(workId, [node.id], { parentId: null }, 1)).toEqual({ revision: 1 });
      await expect(owner.deleteNode(workId, node.id, 0)).rejects.toMatchObject({ code: 'conflict' });
      await expect(create(1, { title: '\0' })).rejects.toMatchObject({ code: 'invalid' });
      expect((await stores.ownerWorks.getWork(workId)).updatedAt).toBe(treeTime);
      const calendar = getGregorianCalendar();
      expect((await owner.putCalendar(workId, calendar, 0)).revision).toBe(1);
      const calendarTime = (await stores.ownerWorks.getWork(workId)).updatedAt;
      expect(calendarTime).toBeGreaterThan(treeTime);
      stores.advanceClock();
      await expect(owner.putCalendar(workId, calendar, 0)).rejects.toMatchObject({ code: 'conflict' });
      await expect(owner.putCalendar(workId, { ...calendar, hoursPerDay: 0 }, 1)).rejects.toMatchObject({ code: 'invalid' });
      expect((await stores.ownerWorks.getWork(workId)).updatedAt).toBe(calendarTime);
      expect(await stores.ownerWorks.getTree(workId)).toEqual({ revision: 0, nodes: [] });
    });

    it('enforces the combined field and value budget and releases space on deletion', async () => {
      const { revision, categoryId, emptyNodeId, fullNodeId } = await
        (stores.seedValuesBudget?.(workId) ?? fillWorldValues(owner, workId));
      await expect(owner.updateNode(workId, categoryId, { fields }, revision)).rejects.toMatchObject({ code: 'too_large' });
      await expect(owner.updateNode(workId, emptyNodeId, { values: { note: 'x' } }, revision))
        .rejects.toMatchObject({ code: 'too_large' });
      await expect(create(revision)).rejects.toMatchObject({ code: 'too_large' });
      const removed = await owner.deleteNode(workId, fullNodeId, revision);
      expect((await owner.updateNode(workId, emptyNodeId, { values: fullWorldValue }, removed.revision)).revision).toBe(revision + 2);
    }, 30_000);

    it('applies a preset once, creates one protected calendar node and leaves the calendar revision independent', async () => {
      const before = await stores.ownerWorks.getWork(workId);
      stores.advanceClock();
      await expect(owner.applyPreset(workId, 'constructor', 0)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.applyPreset(workId, 'fantasy', 1)).rejects.toMatchObject({ code: 'conflict', currentRevision: 0 });
      await expect(stores.other.applyPreset(workId, 'fantasy', 0)).rejects.toMatchObject({ code: 'not_found' });
      expect(await stores.ownerWorks.getWork(workId)).toEqual(before);
      const operations = await Promise.allSettled([owner.applyPreset(workId, 'fantasy', 0), owner.applyPreset(workId, 'fantasy', 0)]);
      expect(operations.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(operations.find(result => result.status === 'rejected')).toMatchObject({
        reason: { code: 'conflict', currentRevision: 1 },
      });
      const applied = operations.find(result => result.status === 'fulfilled')!.value;
      expect(applied.revision).toBe(1);
      expect(await owner.getTree(workId)).toEqual(applied);
      expect((await stores.ownerWorks.getWork(workId)).updatedAt).toBeGreaterThan(before.updatedAt);
      expect(await owner.getCalendar(workId)).toEqual({ revision: 0, calendar: getGregorianCalendar() });
      const calendarNodes = applied.nodes.filter(node => node.kind === 'calendar');
      expect(calendarNodes).toHaveLength(1);
      const { id } = calendarNodes[0];
      await expect(owner.applyPreset(workId, 'blank', 1)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.deleteNode(workId, id, 1)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.moveNodes(workId, [id], { parentId: applied.nodes[0].id }, 1)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.updateNode(workId, id, { fields: [] }, 1)).rejects.toMatchObject({ code: 'invalid' });
      await expect(owner.updateNode(workId, id, { values: {} }, 1)).rejects.toMatchObject({ code: 'invalid' });
      expect((await owner.updateNode(workId, id, { title: '달력 이름' }, 1)).node.title).toBe('달력 이름');
      expect(await owner.moveNodes(workId, [id], { parentId: null, beforeId: applied.nodes[0].id }, 2)).toEqual({ revision: 3 });
      expect((await owner.getTree(workId)).nodes[0].id).toBe(id);
      expect(await owner.getCalendar(workId)).toEqual({ revision: 0, calendar: getGregorianCalendar() });
    });

    it('preserves a saved calendar when initializing an empty world from a preset', async () => {
      const calendar = { ...getGregorianCalendar(), hoursPerDay: 30 };
      await owner.putCalendar(workId, calendar, 0);
      expect((await owner.applyPreset(workId, 'blank', 0)).revision).toBe(1);
      expect(await owner.getCalendar(workId)).toEqual({ revision: 1, calendar });
    });

    it('rejects the 10,001st node', async () => {
      const revision = await (stores.seedFullWork?.(workId) ?? fillWorldTree(owner, workId));
      await expect(create(revision)).rejects.toMatchObject({ code: 'limit' });
      expect((await owner.getTree(workId)).revision).toBe(revision);
    }, 30_000);
  });
}
