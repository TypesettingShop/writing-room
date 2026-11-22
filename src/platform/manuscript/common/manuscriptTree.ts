import {
  isManuscriptId, isManuscriptNodeKind, manuscriptLimits, manuscriptNodeTypes, ManuscriptStoreError,
  normalizeManuscriptMetadata, normalizeManuscriptTitle, utf8Size, type ManuscriptNode, type ManuscriptNodeKind,
} from './manuscript.js';
import type { CreateNode, NodeDestination, UpdateNode } from './manuscriptStore.js';

type ParentId = string | null;

/** Shared structural mutations. Stores hold the work revision lock while applying these changes. */
export class ManuscriptTreeEditor {
  private readonly nodes: ReadonlyMap<string, ManuscriptNode>;
  private readonly siblings = new Map<ParentId, ManuscriptNode[]>();
  readonly changed = new Map<string, ManuscriptNode>();
  readonly deleted = new Set<string>();

  constructor(nodes: ReadonlyMap<string, ManuscriptNode>) {
    this.nodes = nodes;
    for (const node of nodes.values()) {
      const siblings = this.siblings.get(node.parentId);
      if (siblings) {
        siblings.push(node);
      } else {
        this.siblings.set(node.parentId, [node]);
      }
    }
    for (const siblings of this.siblings.values()) {
      siblings.sort((a, b) => a.position - b.position);
    }
  }

  private node(id: string): ManuscriptNode {
    const node = this.nodes.get(id);
    if (!node) {
      throw new ManuscriptStoreError('not_found');
    }
    return node;
  }

  private children(parentId: ParentId): readonly ManuscriptNode[] {
    return this.siblings.get(parentId) ?? [];
  }

  private parentKind(parentId: ParentId): ManuscriptNodeKind | null {
    if (parentId === null) {
      return null;
    }
    if (!isManuscriptId(parentId)) {
      throw new ManuscriptStoreError('invalid');
    }
    const parent = this.nodes.get(parentId);
    if (!parent) {
      throw new ManuscriptStoreError('invalid');
    }
    return parent.kind;
  }

  private place(destination: NodeDestination, siblings: ManuscriptNode[], nodes: ManuscriptNode[]): void {
    if (destination.beforeId === undefined) {
      siblings.push(...nodes);
      return;
    }
    const index = siblings.findIndex(node => node.id === destination.beforeId);
    if (index === -1) {
      throw new ManuscriptStoreError('invalid');
    }
    siblings.splice(index, 0, ...nodes);
  }

  private renumber(parentId: ParentId, siblings: readonly ManuscriptNode[], now: number): void {
    siblings.forEach((node, position) => {
      if (node.parentId !== parentId || node.position !== position || !this.nodes.has(node.id)) {
        this.changed.set(node.id, { ...node, parentId, position, updatedAt: now });
      }
    });
  }

  create(input: CreateNode, id: string, now: number): ManuscriptNode {
    if (this.nodes.size >= manuscriptLimits.nodes) {
      throw new ManuscriptStoreError('limit');
    }
    const { parentId, kind } = input;
    if (!isManuscriptNodeKind(kind) || !manuscriptNodeTypes[kind].allowedParents.includes(this.parentKind(parentId))) {
      throw new ManuscriptStoreError('invalid');
    }
    const node: ManuscriptNode = {
      id, parentId, kind, title: normalizeManuscriptTitle(input.title, true), position: 0,
      metadata: {}, createdAt: now, updatedAt: now,
    };
    const siblings = [...this.children(parentId)];
    this.place(input, siblings, [node]);
    this.renumber(parentId, siblings, now);
    return this.changed.get(id)!;
  }

  update(nodeId: string, input: UpdateNode, now: number): ManuscriptNode {
    const node = this.node(nodeId);
    if (input.title === undefined && input.metadata === undefined) {
      return node;
    }
    const metadata = input.metadata === undefined ? node.metadata : normalizeManuscriptMetadata(input.metadata);
    if (metadata !== node.metadata) {
      this.checkMetadataBudget(node, metadata);
    }
    const updated = {
      ...node,
      title: input.title === undefined ? node.title : normalizeManuscriptTitle(input.title, true),
      metadata,
      updatedAt: now,
    };
    this.changed.set(nodeId, updated);
    return updated;
  }

  private checkMetadataBudget(node: ManuscriptNode, metadata: ManuscriptNode['metadata']): void {
    // Empty metadata has a fixed per-node cost already bounded by the node limit.
    const size = (value: ManuscriptNode['metadata']) => Object.keys(value).length ? utf8Size(JSON.stringify(value)) : 0;
    let total = size(metadata);
    if (total <= size(node.metadata)) {
      return;
    }
    for (const sibling of this.nodes.values()) {
      if (sibling.id !== node.id) {
        total += size(sibling.metadata);
      }
      if (total > manuscriptLimits.workMetadata) {
        throw new ManuscriptStoreError('too_large');
      }
    }
  }

  /** Preorder traversal supplies the current tree order for a multi-node selection. */
  orderedNodes(parentId: ParentId = null): ManuscriptNode[] {
    const result: ManuscriptNode[] = [];
    const pending = [...this.children(parentId)].reverse();
    while (pending.length) {
      const node = pending.pop()!;
      result.push(node);
      const children = this.children(node.id);
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push(children[index]);
      }
    }
    return result;
  }

  move(nodeIds: readonly string[], destination: NodeDestination, now: number): void {
    if (!Array.isArray(nodeIds) || !nodeIds.length || !nodeIds.every(isManuscriptId)) {
      throw new ManuscriptStoreError('invalid');
    }
    const selected = new Set(nodeIds);
    for (const id of selected) {
      this.node(id);
    }
    const { parentId, beforeId } = destination;
    const parentKind = this.parentKind(parentId);
    for (let ancestor = parentId; ancestor !== null; ancestor = this.node(ancestor).parentId) {
      if (selected.has(ancestor)) {
        throw new ManuscriptStoreError('invalid');
      }
    }
    const moved = this.orderedNodes().filter(node => {
      if (!selected.has(node.id)) {
        return false;
      }
      for (let ancestor = node.parentId; ancestor !== null; ancestor = this.node(ancestor).parentId) {
        if (selected.has(ancestor)) {
          return false;
        }
      }
      return true;
    });
    if (moved.some(node => !manuscriptNodeTypes[node.kind].allowedParents.includes(parentKind))) {
      throw new ManuscriptStoreError('invalid');
    }

    const movingIds = new Set(moved.map(node => node.id));
    const destinationSiblings = this.children(parentId);
    const remaining = destinationSiblings.filter(node => !movingIds.has(node.id));
    // A selected anchor keeps its original insertion slot among the remaining siblings.
    if (beforeId !== undefined && movingIds.has(beforeId)) {
      const anchor = this.node(beforeId);
      if (anchor.parentId !== parentId) {
        throw new ManuscriptStoreError('invalid');
      }
      const next = destinationSiblings.find(node => node.position > anchor.position && !movingIds.has(node.id));
      destination = { parentId, beforeId: next?.id };
    }
    this.place(destination, remaining, moved);
    this.renumber(parentId, remaining, now);
    for (const source of new Set(moved.map(node => node.parentId))) {
      if (source !== parentId) {
        this.renumber(source, this.children(source).filter(node => !movingIds.has(node.id)), now);
      }
    }
  }

  delete(nodeId: string, now: number): string[] {
    const root = this.node(nodeId);
    const documentIds: string[] = [];
    for (const node of [root, ...this.orderedNodes(nodeId)]) {
      this.deleted.add(node.id);
      if (node.kind === 'document') {
        documentIds.push(node.id);
      }
    }
    this.renumber(root.parentId, this.children(root.parentId).filter(node => node.id !== nodeId), now);
    return documentIds;
  }
}
