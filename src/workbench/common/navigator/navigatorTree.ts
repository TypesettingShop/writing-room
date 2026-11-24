type ParentId = string | null;

export interface NavigatorNode {
  readonly id: string;
  readonly parentId: ParentId;
  readonly kind: string;
  readonly title: string;
  readonly position: number;
}

export interface NavigatorDestination {
  parentId: ParentId;
  beforeId?: string;
}

export type NavigatorNodeTypes = Readonly<Record<string, {
  readonly container: boolean;
  readonly allowedParents: readonly (string | null)[];
}>>;

export interface NavigatorIndex<N extends NavigatorNode = NavigatorNode> {
  readonly nodes: ReadonlyMap<string, N>;
  readonly children: ReadonlyMap<ParentId, readonly N[]>;
  readonly labels: ReadonlyMap<string, string>;
  readonly types: NavigatorNodeTypes;
}

export interface NavigatorTreeOptions<N extends NavigatorNode> {
  readonly types: NavigatorNodeTypes;
  readonly label: (node: N, ordinalOfKind: number) => string;
  readonly maxNodes: number;
  readonly isId: (value: unknown) => value is string;
  readonly invalidTree: string;
}

type TreeIndexResult<N extends NavigatorNode> = { ok: true; index: NavigatorIndex<N> } | { ok: false; reason: string };

export function buildIndex<N extends NavigatorNode>(
  nodes: readonly N[], { types, label, maxNodes, isId, invalidTree }: NavigatorTreeOptions<N>,
): TreeIndexResult<N> {
  const invalid = { ok: false, reason: invalidTree } as const;
  if (!Array.isArray(nodes) || nodes.length > maxNodes) {
    return invalid;
  }

  const byId = new Map<string, N>();
  const groups = new Map<ParentId, { count: number; siblings: N[] }>();
  for (const node of nodes) {
    if (!node || !isId(node.id) || node.id === UP_KEY || byId.has(node.id) ||
        typeof node.kind !== 'string' || !Object.hasOwn(types, node.kind) ||
        (node.parentId !== null && !isId(node.parentId)) || typeof node.title !== 'string' ||
        !Number.isInteger(node.position) || node.position < 0 || node.position >= nodes.length) {
      return invalid;
    }
    byId.set(node.id, node);

    let group = groups.get(node.parentId);
    if (!group) {
      group = { count: 0, siblings: [] };
      groups.set(node.parentId, group);
    }
    if (group.siblings[node.position]) {
      return invalid;
    }
    group.siblings[node.position] = node;
    group.count++;
  }

  const children = new Map<ParentId, readonly N[]>();
  const labels = new Map<string, string>();
  for (const [parentId, { count, siblings }] of groups) {
    const parent = parentId === null ? undefined : byId.get(parentId);
    if ((parentId !== null && (!parent || !types[parent.kind].container)) || count !== siblings.length) {
      return invalid;
    }
    const numbers = new Map<string, number>();
    for (const node of siblings) {
      if (!types[node.kind].allowedParents.includes(parent?.kind ?? null)) {
        return invalid;
      }
      const ordinal = (numbers.get(node.kind) ?? 0) + 1;
      numbers.set(node.kind, ordinal);
      labels.set(node.id, label(node, ordinal));
    }
    children.set(parentId, siblings);
  }

  const index = { nodes: byId, children, labels, types };
  // Every node has one parent. A cycle can only occur in a component disconnected from the root.
  let reachable = 0;
  for (const _ of preorder(null, index)) {
    reachable++;
  }
  return reachable === byId.size ? { ok: true, index } : invalid;
}

export function labelOf<N extends NavigatorNode>(node: N, index: NavigatorIndex<N>): string {
  return index.labels.get(node.id) ?? (node.title || 'Untitled');
}

export function breadcrumb<N extends NavigatorNode>(nodeId: ParentId, index: NavigatorIndex<N>): string[] {
  const labels: string[] = [];
  let node = nodeId === null ? undefined : index.nodes.get(nodeId);
  while (node) {
    labels.push(labelOf(node, index));
    node = node.parentId === null ? undefined : index.nodes.get(node.parentId);
  }
  return labels.reverse();
}

export const UP_KEY = '..';

export type NavigatorLine<N extends NavigatorNode = NavigatorNode> =
  | { readonly kind: 'up'; readonly key: typeof UP_KEY; readonly depth: 0; readonly parentId: ParentId }
  | {
    readonly kind: 'node'; readonly key: string; readonly depth: number; readonly twig: readonly boolean[];
    readonly node: N; readonly dir: boolean; readonly open: boolean; readonly label: string;
  };

interface NavigatorLocation {
  readonly folderId: ParentId;
  readonly expanded: ReadonlySet<string>;
  readonly hiddenKinds: ReadonlySet<string>;
}

interface Branch {
  readonly parent: Branch | undefined;
  readonly depth: number;
  readonly continuing: boolean;
}

function twigOf(branch: Branch): boolean[] {
  const twig = new Array<boolean>(branch.depth);
  for (let current: Branch | undefined = branch; current; current = current.parent) {
    twig[current.depth - 1] = current.continuing;
  }
  return twig;
}

export function navigatorLines<N extends NavigatorNode>(
  { folderId, expanded, hiddenKinds }: NavigatorLocation, index: NavigatorIndex<N>,
): NavigatorLine<N>[] {
  const lines: NavigatorLine<N>[] = [];
  if (folderId !== null) {
    const folder = index.nodes.get(folderId);
    if (!folder || !index.types[folder.kind].container) {
      return lines;
    }
    lines.push({ kind: 'up', key: UP_KEY, depth: 0, parentId: folder.parentId });
  }

  const pending: { node: N; branch: Branch }[] = [];
  function pushChildren(parentId: ParentId, parent?: Branch): void {
    const siblings = index.children.get(parentId) ?? [];
    const visible = hiddenKinds.size ? siblings.filter(node => !hiddenKinds.has(node.kind)) : siblings;
    const depth = (parent?.depth ?? 0) + 1;
    const last = { parent, depth, continuing: false };
    const continuing = { parent, depth, continuing: true };
    for (let position = visible.length - 1; position >= 0; position--) {
      pending.push({ node: visible[position], branch: position === visible.length - 1 ? last : continuing });
    }
  }

  pushChildren(folderId);
  while (pending.length) {
    const { node, branch } = pending.pop()!;
    const dir = index.types[node.kind].container;
    const open = dir && expanded.has(node.id);
    lines.push({
      kind: 'node', key: node.id, node, depth: branch.depth, dir, open, label: labelOf(node, index),
      // Only mounted rows need guides. Retain one branch link per level instead of copying every ancestor.
      get twig() { return twigOf(branch); },
    });
    if (open) {
      pushChildren(node.id, branch);
    }
  }
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

export function* preorder<N extends NavigatorNode>(
  parentId: ParentId, index: NavigatorIndex<N>, descend: (node: N) => boolean = () => true,
): IterableIterator<N> {
  const pending: N[] = [];
  function pushChildren(id: ParentId): void {
    const siblings = index.children.get(id) ?? [];
    for (let position = siblings.length - 1; position >= 0; position--) {
      pending.push(siblings[position]);
    }
  }

  pushChildren(parentId);
  while (pending.length) {
    const node = pending.pop()!;
    yield node;
    if (descend(node)) {
      pushChildren(node.id);
    }
  }
}

function hasSelectedAncestor(node: NavigatorNode, selected: ReadonlySet<string>, index: NavigatorIndex): boolean {
  let parentId = node.parentId;
  while (parentId !== null) {
    if (selected.has(parentId)) {
      return true;
    }
    parentId = index.nodes.get(parentId)!.parentId;
  }
  return false;
}

type DropResult = { ok: true; destination: NavigatorDestination; sourceIds: readonly string[] } | { ok: false; reason: string };
type DropTarget = { kind: 'node'; key: string; open?: boolean } | { kind: 'up' };

export function resolveDrop<N extends NavigatorNode>(
  sourceIds: readonly string[], target: DropTarget | undefined, position: DropPosition, folderId: ParentId, index: NavigatorIndex<N>,
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

  const afterOpenFolder = position === 'after' && target?.kind === 'node' && target.open &&
    targetNode !== undefined && index.types[targetNode.kind].container;
  let parentId = folderId;
  if (targetNode) {
    parentId = position === 'into' || afterOpenFolder ? targetNode.id : targetNode.parentId;
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

  const moved: N[] = [];
  if (selected.size === 1) {
    moved.push(index.nodes.get(sourceIds[0])!);
  } else {
    for (const node of preorder(null, index, node => !selected.has(node.id))) {
      if (selected.has(node.id)) {
        moved.push(node);
      }
    }
  }
  const rejected = moved.find(node =>
    (parent && !index.types[parent.kind].container) || !index.types[node.kind].allowedParents.includes(parent?.kind ?? null),
  );
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
    const siblings = index.children.get(parentId) ?? [];
    let position = afterOpenFolder ? 0 : targetNode.position + 1;
    while (position < siblings.length && moving.has(siblings[position].id)) {
      position++;
    }
    beforeId = siblings[position]?.id;
  }
  return { ok: true, destination: { parentId, beforeId }, sourceIds: moved.map(node => node.id) };
}
