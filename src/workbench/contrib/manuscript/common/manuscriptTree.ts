import {
  isManuscriptId, isManuscriptNodeKind, manuscriptLimits, manuscriptNodeTypes,
  type ManuscriptNode, type ManuscriptNodeKind,
} from '../../../../platform/manuscript/common/manuscript.js';
import type { NodeDestination } from '../../../../platform/manuscript/common/manuscriptStore.js';

type ParentId = string | null;

export interface ManuscriptIndex {
  readonly nodes: ReadonlyMap<string, ManuscriptNode>;
  readonly children: ReadonlyMap<ParentId, readonly ManuscriptNode[]>;
  readonly labels: ReadonlyMap<string, string>;
}

type TreeIndexResult = { ok: true; index: ManuscriptIndex } | { ok: false; reason: string };

const numberSuffix: Partial<Record<ManuscriptNodeKind, string>> = { part: '부', chapter: '장' };
const invalidTree = { ok: false, reason: 'The manuscript tree is invalid.' } as const;

export function buildIndex(nodes: readonly ManuscriptNode[]): TreeIndexResult {
  if (!Array.isArray(nodes) || nodes.length > manuscriptLimits.nodes) {
    return invalidTree;
  }

  const byId = new Map<string, ManuscriptNode>();
  const groups = new Map<ParentId, { count: number; siblings: ManuscriptNode[] }>();
  for (const node of nodes) {
    if (!node || !isManuscriptId(node.id) || byId.has(node.id) || !isManuscriptNodeKind(node.kind) ||
        (node.parentId !== null && !isManuscriptId(node.parentId)) || typeof node.title !== 'string' ||
        !Number.isInteger(node.position) || node.position < 0 || node.position >= nodes.length) {
      return invalidTree;
    }
    byId.set(node.id, node);

    let group = groups.get(node.parentId);
    if (!group) {
      group = { count: 0, siblings: [] };
      groups.set(node.parentId, group);
    }
    if (group.siblings[node.position]) {
      return invalidTree;
    }
    group.siblings[node.position] = node;
    group.count++;
  }

  const children = new Map<ParentId, readonly ManuscriptNode[]>();
  const labels = new Map<string, string>();
  for (const [parentId, { count, siblings }] of groups) {
    const parent = parentId === null ? undefined : byId.get(parentId);
    if ((parentId !== null && !parent) || count !== siblings.length) {
      return invalidTree;
    }
    const numbers = new Map<ManuscriptNodeKind, number>();
    for (const node of siblings) {
      // The allowed parent kinds form an acyclic hierarchy.
      if (!manuscriptNodeTypes[node.kind].allowedParents.includes(parent?.kind ?? null)) {
        return invalidTree;
      }
      const suffix = numberSuffix[node.kind];
      if (!suffix) {
        labels.set(node.id, node.title || 'Untitled');
        continue;
      }
      const number = (numbers.get(node.kind) ?? 0) + 1;
      numbers.set(node.kind, number);
      const ordinal = `${number}${suffix}`;
      labels.set(node.id, node.title ? `${ordinal} - ${node.title}` : ordinal);
    }
    children.set(parentId, siblings);
  }
  return { ok: true, index: { nodes: byId, children, labels } };
}

export function labelOf(node: ManuscriptNode, index: ManuscriptIndex): string {
  return index.labels.get(node.id) ?? (node.title || 'Untitled');
}

export function breadcrumb(nodeId: ParentId, index: ManuscriptIndex): string[] {
  const labels: string[] = [];
  let node = nodeId === null ? undefined : index.nodes.get(nodeId);
  while (node) {
    labels.push(labelOf(node, index));
    node = node.parentId === null ? undefined : index.nodes.get(node.parentId);
  }
  return labels.reverse();
}

export const UP_KEY = '..';

export type NavigatorLine =
  | { readonly kind: 'up'; readonly key: typeof UP_KEY; readonly depth: 0; readonly parentId: ParentId }
  | {
    readonly kind: 'node'; readonly key: string; readonly depth: number; readonly twig: readonly boolean[];
    readonly node: ManuscriptNode; readonly dir: boolean; readonly open: boolean; readonly label: string;
  };

interface NavigatorLocation {
  readonly folderId: ParentId;
  readonly expanded: ReadonlySet<string>;
  readonly hiddenKinds: ReadonlySet<ManuscriptNodeKind>;
}

export function navigatorLines({ folderId, expanded, hiddenKinds }: NavigatorLocation, index: ManuscriptIndex): NavigatorLine[] {
  const lines: NavigatorLine[] = [];
  if (folderId !== null) {
    const folder = index.nodes.get(folderId);
    if (!folder || !manuscriptNodeTypes[folder.kind].container) {
      return lines;
    }
    lines.push({ kind: 'up', key: UP_KEY, depth: 0, parentId: folder.parentId });
  }
  function walk(parentId: ParentId, twig: readonly boolean[]): void {
    const siblings = index.children.get(parentId) ?? [];
    const visible = hiddenKinds.size ? siblings.filter(node => !hiddenKinds.has(node.kind)) : siblings;
    if (!visible.length) {
      return;
    }
    const continuing = [...twig, true];
    const last = [...twig, false];
    for (let position = 0; position < visible.length; position++) {
      const node = visible[position];
      const branch = position < visible.length - 1 ? continuing : last;
      const dir = manuscriptNodeTypes[node.kind].container;
      const open = dir && expanded.has(node.id);
      lines.push({ kind: 'node', key: node.id, node, depth: branch.length, twig: branch, dir, open, label: labelOf(node, index) });
      if (open) {
        walk(node.id, branch);
      }
    }
  }
  walk(folderId, []);
  return lines;
}

export type TwigPart = 'pipe' | 'blank' | 'tee' | 'end';
export const TWIG_TEXT: Readonly<Record<TwigPart, string>> = { pipe: '│ ', blank: '  ', tee: '├─', end: '└─' };

export function twigParts(twig: readonly boolean[]): TwigPart[] {
  if (twig.length < 2) {
    return [];
  }
  const branches = twig.slice(1, -1).map((more): TwigPart => more ? 'pipe' : 'blank');
  branches.push(twig[twig.length - 1] ? 'tee' : 'end');
  return branches;
}

export function firstKey(lines: readonly NavigatorLine[]): string | null {
  return lines.find(line => line.kind === 'node')?.key ?? null;
}

export function moveKey(lines: readonly NavigatorLine[], key: string | null, delta: number): string | null {
  if (!lines.length) {
    return null;
  }
  const at = lines.findIndex(line => line.key === key);
  const next = at < 0 ? (delta < 0 ? lines.length - 1 : 0) : Math.max(0, Math.min(lines.length - 1, at + delta));
  return lines[next].key;
}

export function parentLine(lines: readonly NavigatorLine[], at: number): number {
  const depth = lines[at]?.depth ?? 0;
  if (depth < 2) {
    return -1;
  }
  for (let previous = at - 1; previous >= 0; previous--) {
    if (lines[previous].depth === depth - 1) {
      return previous;
    }
  }
  return -1;
}

export const OVERSCAN = 8;

export function windowRange(scrollTop: number, viewport: number, rowHeight: number, count: number): { start: number; end: number } {
  const top = Math.max(0, scrollTop);
  const start = Math.max(0, Math.min(count, Math.floor(top / rowHeight) - OVERSCAN));
  const end = Math.max(start, Math.min(count, Math.ceil((top + Math.max(0, viewport)) / rowHeight) + OVERSCAN));
  return { start, end };
}

export function revealOffset(scrollTop: number, viewport: number, top: number, height: number): number {
  if (top < scrollTop) {
    return top;
  }
  if (top + height > scrollTop + viewport) {
    return Math.max(0, top + height - viewport);
  }
  return scrollTop;
}

export type DropPosition = 'before' | 'after' | 'into';

export function dropPositionAt(offsetY: number, rowHeight: number, canContain: boolean): DropPosition {
  const fraction = offsetY / rowHeight;
  if (!canContain) {
    return fraction < 0.5 ? 'before' : 'after';
  }
  if (fraction < 0.25) {
    return 'before';
  }
  return fraction >= 0.75 ? 'after' : 'into';
}

function* preorder(parentId: ParentId, index: ManuscriptIndex): IterableIterator<ManuscriptNode> {
  for (const node of index.children.get(parentId) ?? []) {
    yield node;
    if (index.children.has(node.id)) {
      yield* preorder(node.id, index);
    }
  }
}

function hasSelectedAncestor(node: ManuscriptNode, selected: ReadonlySet<string>, index: ManuscriptIndex): boolean {
  let parentId = node.parentId;
  while (parentId !== null) {
    if (selected.has(parentId)) {
      return true;
    }
    parentId = index.nodes.get(parentId)!.parentId;
  }
  return false;
}

type DropResult = { ok: true; destination: NodeDestination; sourceIds: readonly string[] } | { ok: false; reason: string };
type DropTarget = { kind: 'node'; key: string } | { kind: 'up' };

export function resolveDrop(
  sourceIds: readonly string[], target: DropTarget | undefined, position: DropPosition, folderId: ParentId, index: ManuscriptIndex,
): DropResult {
  const selected = new Set(sourceIds);
  if (!selected.size || sourceIds.some(id => !index.nodes.has(id))) {
    return { ok: false, reason: 'The items to move could not be found.' };
  }
  if (folderId !== null && !index.nodes.has(folderId)) {
    return { ok: false, reason: 'The destination folder could not be found.' };
  }

  const targetNode = target?.kind === 'node' ? index.nodes.get(target.key) : undefined;
  if (target?.kind === 'node' && !targetNode) {
    return { ok: false, reason: 'The drop target could not be found.' };
  }
  if (targetNode && (selected.has(targetNode.id) || hasSelectedAncestor(targetNode, selected, index))) {
    return { ok: false, reason: 'An item cannot be dropped on itself or one of its descendants.' };
  }

  let parentId = folderId;
  if (targetNode) {
    parentId = position === 'into' ? targetNode.id : targetNode.parentId;
  } else if (target?.kind === 'up') {
    if (folderId === null) {
      return { ok: false, reason: 'There is no parent folder.' };
    }
    parentId = index.nodes.get(folderId)!.parentId;
  }

  const parent = parentId === null ? undefined : index.nodes.get(parentId)!;
  if (parent && (selected.has(parent.id) || hasSelectedAncestor(parent, selected, index))) {
    return { ok: false, reason: 'An item cannot be moved into itself or one of its descendants.' };
  }

  const moved: ManuscriptNode[] = [];
  if (selected.size === 1) {
    moved.push(index.nodes.get(sourceIds[0])!);
  } else {
    for (const node of preorder(null, index)) {
      if (selected.has(node.id) && !hasSelectedAncestor(node, selected, index)) {
        moved.push(node);
      }
    }
  }
  const rejected = moved.find(node => !manuscriptNodeTypes[node.kind].allowedParents.includes(parent?.kind ?? null));
  if (rejected) {
    return { ok: false, reason: parent
      ? `A ${rejected.kind} cannot go inside a ${parent.kind}.`
      : `A ${rejected.kind} cannot go at the top level.` };
  }

  let beforeId: string | undefined;
  if (position === 'before') {
    beforeId = targetNode?.id;
  } else if (position === 'after' && targetNode) {
    const moving = new Set(moved.map(node => node.id));
    const siblings = index.children.get(parentId)!;
    let position = targetNode.position + 1;
    while (position < siblings.length && moving.has(siblings[position].id)) {
      position++;
    }
    beforeId = siblings[position]?.id;
  }
  return { ok: true, destination: { parentId, beforeId }, sourceIds: moved.map(node => node.id) };
}

export function documentsUnder(nodeId: ParentId, index: ManuscriptIndex): string[] {
  if (nodeId !== null && index.nodes.get(nodeId)?.kind === 'document') {
    return [nodeId];
  }
  const documents: string[] = [];
  for (const node of preorder(nodeId, index)) {
    if (node.kind === 'document') {
      documents.push(node.id);
    }
  }
  return documents;
}
