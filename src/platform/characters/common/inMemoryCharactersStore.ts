import type { InMemoryWorkAccess } from '../../manuscript/common/inMemoryManuscriptStore.js';
import { normalizeCharacterTemplate } from './characterFields.js';
import { CharacterTreeEditor } from './characterTree.js';
import { CharacterStoreError, checkCharacterRevision, type CharacterNode } from './characters.js';
import type { CharacterTemplateSnapshot, CharactersRepository, CharactersStore } from './charactersStore.js';
import { getDefaultCharacterTemplate } from './defaultCharacterTemplate.js';

interface WorkState {
  revision: number;
  nodes: Map<string, CharacterNode>;
  template?: CharacterTemplateSnapshot;
}

export class InMemoryCharactersRepository implements CharactersRepository {
  // Work IDs are globally unique. Ownership is checked against the manuscript repository on every call.
  private readonly works = new Map<string, WorkState>();

  constructor(
    private readonly workAccess: (userId: string) => InMemoryWorkAccess,
    private readonly now: () => number = Date.now,
  ) {}

  forUser(userId: string): CharactersStore {
    const work = this.workAccess(userId);
    const works = this.works;
    const requireWork = (workId: string): WorkState => {
      if (!work.hasWork(workId)) {
        throw new CharacterStoreError('not_found');
      }
      return works.get(workId) ?? { revision: 0, nodes: new Map() };
    };

    // Ownership, the revision check, and the commit all run synchronously.
    const mutate = <T>(workId: string, expected: number, edit: (tree: CharacterTreeEditor, now: number) => T) => {
      const state = requireWork(workId);
      checkCharacterRevision(state.revision, expected);
      const now = this.now();
      const tree = new CharacterTreeEditor(state.nodes);
      const result = edit(tree, now);
      if (tree.changed.size || tree.deleted.size) {
        work.touchWork(workId, now);
        for (const node of tree.changed.values()) {
          state.nodes.set(node.id, node);
        }
        for (const id of tree.deleted) {
          state.nodes.delete(id);
        }
        state.revision++;
        works.set(workId, state);
      }
      return { ...result, revision: state.revision };
    };

    return {
      async getTemplate(workId) {
        const { template } = requireWork(workId);
        return template ? structuredClone(template) : { revision: 0, fields: getDefaultCharacterTemplate() };
      },
      async putTemplate(workId, fields, expected) {
        const state = requireWork(workId);
        const revision = state.template?.revision ?? 0;
        checkCharacterRevision(revision, expected);
        const template = { revision: revision + 1, fields: normalizeCharacterTemplate(fields) };
        state.template = template;
        works.set(workId, state);
        return structuredClone(template);
      },
      async getTree(workId) {
        const { revision, nodes } = requireWork(workId);
        return { revision, nodes: structuredClone(new CharacterTreeEditor(nodes).orderedNodes()) };
      },
      async createNode(workId, input, expected) {
        return mutate(workId, expected, (tree, now) => ({
          node: structuredClone(tree.create(input, globalThis.crypto.randomUUID(), now)),
        }));
      },
      async updateNode(workId, nodeId, input, expected) {
        return mutate(workId, expected, (tree, now) => ({ node: structuredClone(tree.update(nodeId, input, now)) }));
      },
      async moveNodes(workId, nodeIds, destination, expected) {
        return mutate(workId, expected, (tree, now) => {
          tree.move(nodeIds, destination, now);
          return {};
        });
      },
      async deleteNode(workId, nodeId, expected) {
        return mutate(workId, expected, (tree, now) => ({ deletedCharacterIds: tree.delete(nodeId, now) }));
      },
    };
  }
}
