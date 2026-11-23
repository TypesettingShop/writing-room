import {
  checkDocumentEtag, checkRevision, documentSize, ManuscriptStoreError, normalizeManuscriptTitle,
  type DocumentStat, type ManuscriptDocument, type ManuscriptNode, type ManuscriptWork,
} from './manuscript.js';
import type { ManuscriptRepository, ManuscriptStore } from './manuscriptStore.js';
import { ManuscriptTreeEditor } from './manuscriptTree.js';

export interface InMemoryWorkAccess {
  hasWork(workId: string): boolean;
  touchWork(workId: string, timestamp: number): void;
}

interface WorkState {
  work: ManuscriptWork;
  revision: number;
  nodes: Map<string, ManuscriptNode>;
  documents: Map<string, ManuscriptDocument>;
}

const copyNode = (node: ManuscriptNode): ManuscriptNode => structuredClone(node);

const stat = ({ mtime, size }: DocumentStat): DocumentStat => ({ mtime, size });

export class InMemoryManuscriptRepository implements ManuscriptRepository {
  private readonly users = new Map<string, Map<string, WorkState>>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  workAccess(userId: string): InMemoryWorkAccess {
    return {
      hasWork: workId => this.users.get(userId)?.has(workId) ?? false,
      touchWork: (workId, timestamp) => {
        const state = this.users.get(userId)?.get(workId);
        if (!state) {
          throw new ManuscriptStoreError('not_found');
        }
        state.work.updatedAt = timestamp;
      },
    };
  }

  forUser(userId: string): ManuscriptStore {
    let works = this.users.get(userId);
    if (!works) {
      works = new Map();
      this.users.set(userId, works);
    }
    const userWorks = works;
    const now = this.now;

    const requireWork = (workId: string): WorkState => {
      const work = userWorks.get(workId);
      if (!work) {
        throw new ManuscriptStoreError('not_found');
      }
      return work;
    };
    const requireDocument = (workId: string, nodeId: string): ManuscriptDocument => {
      const document = requireWork(workId).documents.get(nodeId);
      if (!document) {
        throw new ManuscriptStoreError('not_found');
      }
      return document;
    };
    // No asynchronous work occurs between the revision check and the commit.
    const mutate = <T>(
      workId: string, expected: number, edit: (tree: ManuscriptTreeEditor, timestamp: number) => T,
    ): T & { revision: number } => {
      const state = requireWork(workId);
      checkRevision(state.revision, expected);
      const timestamp = now();
      const tree = new ManuscriptTreeEditor(state.nodes);
      const result = edit(tree, timestamp);
      for (const node of tree.changed.values()) {
        if (node.kind === 'document' && !state.nodes.has(node.id)) {
          state.documents.set(node.id, { content: '', mtime: timestamp, size: 0 });
        }
        state.nodes.set(node.id, node);
      }
      for (const id of tree.deleted) {
        state.nodes.delete(id);
        state.documents.delete(id);
      }
      if (tree.changed.size || tree.deleted.size) {
        state.revision++;
        state.work.updatedAt = timestamp;
      }
      return { ...result, revision: state.revision };
    };

    return {
      async listWorks() {
        return [...userWorks.values()].map(({ work }) => ({ ...work }))
          .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      },
      async createWork({ title }) {
        const timestamp = now();
        const work = { id: globalThis.crypto.randomUUID(), title: normalizeManuscriptTitle(title, false), createdAt: timestamp, updatedAt: timestamp };
        userWorks.set(work.id, { work, revision: 0, nodes: new Map(), documents: new Map() });
        return { ...work };
      },
      async getWork(workId) {
        return { ...requireWork(workId).work };
      },
      async getTree(workId) {
        const { revision, nodes } = requireWork(workId);
        return { revision, nodes: new ManuscriptTreeEditor(nodes).orderedNodes().map(copyNode) };
      },
      async createNode(workId, input, expected) {
        return mutate(workId, expected, (tree, timestamp) => ({
          node: copyNode(tree.create(input, globalThis.crypto.randomUUID(), timestamp)),
        }));
      },
      async updateNode(workId, nodeId, input, expected) {
        return mutate(workId, expected, (tree, timestamp) => ({ node: copyNode(tree.update(nodeId, input, timestamp)) }));
      },
      async moveNodes(workId, nodeIds, destination, expected) {
        return mutate(workId, expected, (tree, timestamp) => {
          tree.move(nodeIds, destination, timestamp);
          return {};
        });
      },
      async deleteNode(workId, nodeId, expected) {
        return mutate(workId, expected, (tree, timestamp) => ({
          deletedDocumentIds: tree.delete(nodeId, timestamp),
        }));
      },
      async statDocument(workId, nodeId) {
        return stat(requireDocument(workId, nodeId));
      },
      async readDocument(workId, nodeId) {
        return { ...requireDocument(workId, nodeId) };
      },
      async writeDocument(workId, nodeId, content, expectedEtag) {
        const document = requireDocument(workId, nodeId);
        checkDocumentEtag(document, expectedEtag);
        const size = documentSize(content);
        const updated = { content, size, mtime: Math.max(now(), document.mtime + 1) };
        requireWork(workId).documents.set(nodeId, updated);
        return stat(updated);
      },
    };
  }
}
