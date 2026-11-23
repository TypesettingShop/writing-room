import {
  isManuscriptId, isManuscriptNodeKind, manuscriptLimits, manuscriptNodeTypes, ManuscriptStoreError,
  normalizeManuscriptMetadata, normalizeManuscriptTitle, utf8Size, type ManuscriptNode, type ManuscriptNodeKind,
} from './manuscript.js';
import type { CreateNode, NodeDestination, UpdateNode } from './manuscriptStore.js';

type ParentId = string | null;
type PositionedNode = Pick<ManuscriptNode, 'id' | 'parentId' | 'position' | 'updatedAt'> & { kind: string };
type TreeErrorCode = 'not_found' | 'invalid' | 'limit';

/** Shared structural mutations. Stores hold the work revision lock while applying these changes. */
export abstract class OrderedTreeEditor<Node extends PositionedNode> {
  protected abstract canParent(kind: Node['kind'], parentKind: Node['kind'] | null): boolean;
  protected readonly missingDestination: 'invalid' | 'not_found' = 'invalid';
  protected readonly nodes: ReadonlyMap<string, Node>;
  private readonly siblings = new Map<ParentId, Node[]>();
  readonly changed = new Map<string, Node>();
  readonly deleted = new Set<string>();

  constructor(nodes: ReadonlyMap<string, Node>) {
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

  protected node(id: string): Node {
    const node = this.nodes.get(id);
    if (!node) {
      throw this.error('not_found');
    }
    return node;
  }

  private children(parentId: ParentId): readonly Node[] {
    return this.siblings.get(parentId) ?? [];
  }

  protected error(code: TreeErrorCode): Error {
    return new ManuscriptStoreError(code);
  }

  protected validateParent(kind: Node['kind'], parentId: ParentId): void {
    if (!this.canParent(kind, this.parentKind(parentId))) {
      throw this.error('invalid');
    }
  }

  private parentKind(parentId: ParentId): Node['kind'] | null {
    if (parentId === null) {
      return null;
    }
    const parent = isManuscriptId(parentId) ? this.nodes.get(parentId) : undefined;
    if (!parent) {
      throw this.error(this.missingDestination);
    }
    return parent.kind;
  }

  private place(destination: NodeDestination, siblings: Node[], nodes: Node[]): void {
    if (destination.beforeId === undefined) {
      siblings.push(...nodes);
      return;
    }
    if (this.missingDestination === 'not_found' && !this.nodes.has(destination.beforeId)) {
      throw this.error('not_found');
    }
    const index = siblings.findIndex(node => node.id === destination.beforeId);
    if (index === -1) {
      throw this.error('invalid');
    }
    siblings.splice(index, 0, ...nodes);
  }

  private renumber(parentId: ParentId, siblings: readonly Node[], now: number): void {
    siblings.forEach((node, position) => {
      if (node.parentId !== parentId || node.position !== position || !this.nodes.has(node.id)) {
        this.changed.set(node.id, { ...node, parentId, position, updatedAt: now });
      }
    });
  }

  protected insert(node: Node, destination: NodeDestination, now: number): Node {
    const siblings = [...this.children(node.parentId)];
    this.place(destination, siblings, [node]);
    this.renumber(node.parentId, siblings, now);
    return this.changed.get(node.id)!;
  }

  /** Preorder traversal supplies the current tree order for a multi-node selection. */
  orderedNodes(parentId: ParentId = null): Node[] {
    const result: Node[] = [];
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
    if (!Array.isArray(nodeIds) || !nodeIds.length) {
      throw this.error('invalid');
    }
    if (!nodeIds.every(isManuscriptId)) {
      throw this.error(this.missingDestination);
    }
    const selected = new Set(nodeIds);
    for (const id of selected) {
      this.node(id);
    }
    const { parentId, beforeId } = destination;
    const parentKind = this.parentKind(parentId);
    for (let ancestor = parentId; ancestor !== null; ancestor = this.node(ancestor).parentId) {
      if (selected.has(ancestor)) {
        throw this.error('invalid');
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
    if (moved.some(node => !this.canParent(node.kind, parentKind))) {
      throw this.error('invalid');
    }

    const movingIds = new Set(moved.map(node => node.id));
    const destinationSiblings = this.children(parentId);
    const remaining = destinationSiblings.filter(node => !movingIds.has(node.id));
    // A selected anchor keeps its original insertion slot among the remaining siblings.
    if (beforeId !== undefined && movingIds.has(beforeId)) {
      const anchor = this.node(beforeId);
      if (anchor.parentId !== parentId) {
        throw this.error('invalid');
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

  protected removeSubtree(nodeId: string, now: number): Node[] {
    const root = this.node(nodeId);
    const removed = [root, ...this.orderedNodes(nodeId)];
    for (const node of removed) {
      this.deleted.add(node.id);
    }
    this.renumber(root.parentId, this.children(root.parentId).filter(node => node.id !== nodeId), now);
    return removed;
  }
}

/** Manuscript validation and data on top of the shared tree operations. */
export class ManuscriptTreeEditor extends OrderedTreeEditor<ManuscriptNode> {
  protected canParent(kind: ManuscriptNodeKind, parentKind: ManuscriptNodeKind | null): boolean {
    return manuscriptNodeTypes[kind].allowedParents.includes(parentKind);
  }

  create(input: CreateNode, id: string, now: number): ManuscriptNode {
    if (this.nodes.size >= manuscriptLimits.nodes) {
      throw new ManuscriptStoreError('limit');
    }
    const { parentId, kind } = input;
    if (!isManuscriptNodeKind(kind)) {
      throw new ManuscriptStoreError('invalid');
    }
    this.validateParent(kind, parentId);
    const node: ManuscriptNode = {
      id, parentId, kind, title: normalizeManuscriptTitle(input.title, true), position: 0,
      metadata: {}, createdAt: now, updatedAt: now,
    };
    return this.insert(node, input, now);
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

  delete(nodeId: string, now: number): string[] {
    return this.removeSubtree(nodeId, now).filter(node => node.kind === 'document').map(node => node.id);
  }
}
