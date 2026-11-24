import { utf8Size } from '../../manuscript/common/manuscript.js';
import { OrderedTreeEditor } from '../../manuscript/common/manuscriptTree.js';
import { normalizeCharacterValues, type CharacterValues } from './characterFields.js';
import {
  characterLimits, characterNodeTypes, CharacterStoreError, isCharacterNodeKind, normalizeCharacterTitle, normalizeCharacterType,
  type CharacterNode, type CharacterNodeKind, type CharacterStoreErrorCode,
} from './characters.js';
import type { CreateCharacterNode, UpdateCharacterNode } from './charactersStore.js';

// Stored dictionaries are replaced on update and never exposed by the repositories.
const valueSizes = new WeakMap<CharacterValues, number>();

export function characterValueSize(values: CharacterValues | undefined): number {
  // The node limit already bounds the fixed cost of empty values.
  if (!values) {
    return 0;
  }
  let size = valueSizes.get(values);
  if (size === undefined) {
    size = Object.keys(values).length ? utf8Size(JSON.stringify(values)) : 0;
    valueSizes.set(values, size);
  }
  return size;
}

export function checkCharacterWorkValuesSize(size: number): void {
  if (size > characterLimits.workValues) {
    throw new CharacterStoreError('too_large');
  }
}

export function updateCharacterNode(node: CharacterNode, input: UpdateCharacterNode, now: number): CharacterNode {
  const { title, type, values } = input;
  if (title === undefined && type === undefined && values === undefined) {
    return node;
  }
  const base = { title: title === undefined ? node.title : normalizeCharacterTitle(title), updatedAt: now };
  if (node.kind === 'folder') {
    if (type !== undefined || values !== undefined) {
      throw new CharacterStoreError('invalid');
    }
    return { ...node, ...base };
  }
  return {
    ...node,
    ...base,
    type: type === undefined ? node.type : normalizeCharacterType(type),
    values: values === undefined ? node.values : normalizeCharacterValues(values),
  };
}

export class CharacterTreeEditor extends OrderedTreeEditor<CharacterNode> {
  protected override readonly missingDestination = 'not_found';

  protected canParent(kind: CharacterNodeKind, parentKind: CharacterNodeKind | null): boolean {
    return characterNodeTypes[kind].allowedParents.includes(parentKind);
  }

  protected override error(code: CharacterStoreErrorCode): CharacterStoreError {
    return new CharacterStoreError(code);
  }

  create(input: CreateCharacterNode, id: string, now: number): CharacterNode {
    if (this.nodes.size >= characterLimits.nodes) {
      throw new CharacterStoreError('limit');
    }
    const { kind, parentId, type } = input;
    if (!isCharacterNodeKind(kind) || (kind === 'folder' && type !== undefined) ||
      ('values' in input && input.values !== undefined)) {
      throw new CharacterStoreError('invalid');
    }
    this.validateParent(kind, parentId);
    const base = { id, parentId, title: normalizeCharacterTitle(input.title), position: 0, createdAt: now, updatedAt: now };
    const node: CharacterNode = kind === 'folder'
      ? { ...base, kind }
      : { ...base, kind, type: type === undefined ? 'unknown' : normalizeCharacterType(type), values: {} };
    return this.insert(node, input, now);
  }

  update(nodeId: string, input: UpdateCharacterNode, now: number): CharacterNode {
    const node = this.node(nodeId);
    const updated = updateCharacterNode(node, input, now);
    if (updated === node) {
      return node;
    }
    if (updated.values !== node.values) {
      this.checkValueBudget(node, updated.values);
    }
    this.changed.set(node.id, updated);
    return updated;
  }

  private checkValueBudget(node: CharacterNode, values: CharacterValues | undefined): void {
    let total = characterValueSize(values);
    if (total <= characterValueSize(node.values)) {
      return;
    }
    for (const other of this.nodes.values()) {
      if (other.id !== node.id) {
        total += characterValueSize(other.values);
      }
    }
    checkCharacterWorkValuesSize(total);
  }

  delete(nodeId: string, now: number): string[] {
    return this.removeSubtree(nodeId, now).filter(node => node.kind === 'character').map(node => node.id);
  }
}
