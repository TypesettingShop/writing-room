import type { InMemoryWorkAccess } from '../../manuscript/common/inMemoryManuscriptStore.js';
import { getGregorianCalendar, normalizeCalendar } from './calendar.js';
import { checkWorldRevision, WorldStoreError, type WorldNode } from './world.js';
import type { WorldCalendarSnapshot, WorldRepository, WorldStore } from './worldStore.js';
import { checkWorldWorkDataSize, worldDataSize, WorldTreeEditor } from './worldTree.js';

interface WorkState {
  revision: number;
  nodes: Map<string, WorldNode>;
  dataBytes: number;
  calendar?: WorldCalendarSnapshot;
}

export class InMemoryWorldRepository implements WorldRepository {
  private readonly works = new Map<string, WorkState>();

  constructor(
    private readonly workAccess: (userId: string) => InMemoryWorkAccess,
    private readonly now: () => number = Date.now,
  ) {}

  forUser(userId: string): WorldStore {
    const work = this.workAccess(userId);
    const requireWork = (workId: string): WorkState => {
      if (!work.hasWork(workId)) {
        throw new WorldStoreError('not_found');
      }
      return this.works.get(workId) ?? { revision: 0, nodes: new Map(), dataBytes: 0 };
    };

    // Ownership, the revision check and the commit are synchronous.
    const mutate = <T>(workId: string, expected: number, edit: (tree: WorldTreeEditor, now: number) => T) => {
      const state = requireWork(workId);
      checkWorldRevision(state.revision, expected);
      const now = this.now();
      const tree = new WorldTreeEditor(state.nodes);
      const result = edit(tree, now);
      if (tree.changed.size || tree.deleted.size) {
        let dataBytes = state.dataBytes;
        for (const node of tree.changed.values()) {
          const previous = state.nodes.get(node.id);
          dataBytes += worldDataSize(node) - (previous ? worldDataSize(previous) : 0);
        }
        for (const id of tree.deleted) {
          dataBytes -= worldDataSize(state.nodes.get(id)!);
        }
        checkWorldWorkDataSize(dataBytes);
        work.touchWork(workId, now);
        for (const node of tree.changed.values()) {
          state.nodes.set(node.id, node);
        }
        for (const id of tree.deleted) {
          state.nodes.delete(id);
        }
        state.dataBytes = dataBytes;
        state.revision++;
        this.works.set(workId, state);
      }
      return { ...result, revision: state.revision };
    };

    return {
      async getTree(workId) {
        const { revision, nodes } = requireWork(workId);
        return { revision, nodes: structuredClone(new WorldTreeEditor(nodes).orderedNodes()) };
      },
      async createNode(workId, input, expected) {
        return mutate(workId, expected, (tree, now) => ({
          node: structuredClone(tree.create(input, globalThis.crypto.randomUUID(), now)),
        }));
      },
      async updateNode(workId, nodeId, input, expected) {
        return mutate(workId, expected, (tree, now) => ({
          node: structuredClone(tree.update(nodeId, input, now)),
        }));
      },
      async moveNodes(workId, nodeIds, destination, expected) {
        return mutate(workId, expected, (tree, now) => {
          tree.move(nodeIds, destination, now);
          return {};
        });
      },
      async deleteNode(workId, nodeId, expected) {
        return mutate(workId, expected, (tree, now) => ({ deletedNodeIds: tree.delete(nodeId, now) }));
      },
      getCalendar: async workId => {
        const { calendar } = requireWork(workId);
        return calendar ? structuredClone(calendar) : { revision: 0, calendar: getGregorianCalendar() };
      },
      putCalendar: async (workId, calendar, expected) => {
        const state = requireWork(workId);
        const revision = state.calendar?.revision ?? 0;
        checkWorldRevision(revision, expected);
        const snapshot = { revision: revision + 1, calendar: normalizeCalendar(calendar) };
        work.touchWork(workId, this.now());
        state.calendar = snapshot;
        this.works.set(workId, state);
        return structuredClone(snapshot);
      },
    };
  }
}
