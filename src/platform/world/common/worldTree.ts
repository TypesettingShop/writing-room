import { normalizeCharacterTemplate, normalizeCharacterValues } from '../../characters/common/characterFields.js';
import { utf8Size } from '../../manuscript/common/manuscript.js';
import { OrderedTreeEditor } from '../../manuscript/common/manuscriptTree.js';
import {
  normalizeWorldTitle, worldLimits, worldNodeTypes, WorldStoreError,
  type WorldNode, type WorldNodeKind, type WorldStoreErrorCode,
} from './world.js';
import { buildWorldPresetNodes } from './worldPresets.js';
import type { CreateWorldNode, UpdateWorldNode } from './worldStore.js';

// Each normalized payload is replaced as a whole and stays private to the store.
const payloadSizes = new WeakMap<object, number>();

export function worldDataSize(node: WorldNode): number {
  const data = node.fields ?? node.values;
  if (!data) {
    return 0;
  }
  let size = payloadSizes.get(data);
  if (size === undefined) {
    size = utf8Size(JSON.stringify(data));
    payloadSizes.set(data, size);
  }
  return size;
}

export function checkWorldWorkDataSize(size: number): void {
  if (size > worldLimits.workData) {
    throw new WorldStoreError('too_large');
  }
}

export function updateWorldNode(node: WorldNode, input: UpdateWorldNode, now: number): WorldNode {
  const { title, fields, values } = input;
  if (title === undefined && fields === undefined && values === undefined) {
    return node;
  }
  if ((fields !== undefined && node.kind !== 'category') || (values !== undefined && node.kind !== 'item')) {
    throw new WorldStoreError('invalid');
  }
  const base = { title: title === undefined ? node.title : normalizeWorldTitle(title), updatedAt: now };
  if (node.kind === 'category') {
    return { ...node, ...base, fields: fields === undefined ? node.fields : normalizeCharacterTemplate(fields) };
  }
  if (node.kind === 'item') {
    return { ...node, ...base, values: values === undefined ? node.values : normalizeCharacterValues(values) };
  }
  return { ...node, ...base };
}

export class WorldTreeEditor extends OrderedTreeEditor<WorldNode> {
  protected override readonly missingDestination = 'not_found';

  protected canParent(kind: WorldNodeKind, parentKind: WorldNodeKind | null): boolean {
    return worldNodeTypes[kind].allowedParents.includes(parentKind);
  }

  protected override error(code: WorldStoreErrorCode): WorldStoreError {
    return new WorldStoreError(code);
  }

  applyPreset(presetId: string, makeId: () => string, now: number): WorldNode[] {
    if (this.nodes.size !== 0) {
      throw new WorldStoreError('invalid');
    }
    const nodes = buildWorldPresetNodes(presetId, makeId, now);
    for (const node of nodes) {
      this.changed.set(node.id, node);
    }
    return nodes;
  }

  create(input: CreateWorldNode, id: string, now: number): WorldNode {
    if (this.nodes.size >= worldLimits.nodes) {
      throw new WorldStoreError('limit');
    }
    const { kind, parentId } = input;
    if ((kind !== 'category' && kind !== 'item') || 'fields' in input || 'values' in input) {
      throw new WorldStoreError('invalid');
    }
    this.validateParent(kind, parentId);
    const base = { id, parentId, title: normalizeWorldTitle(input.title), position: 0, createdAt: now, updatedAt: now };
    return this.insert(kind === 'category' ? { ...base, kind, fields: [] } : { ...base, kind, values: {} }, input, now);
  }

  update(nodeId: string, input: UpdateWorldNode, now: number): WorldNode {
    const node = this.node(nodeId);
    const updated = updateWorldNode(node, input, now);
    if (updated !== node) {
      this.changed.set(nodeId, updated);
    }
    return updated;
  }

  delete(nodeId: string, now: number): string[] {
    if (this.node(nodeId).kind === 'calendar') {
      throw new WorldStoreError('invalid');
    }
    return this.removeSubtree(nodeId, now).map(node => node.id);
  }
}
