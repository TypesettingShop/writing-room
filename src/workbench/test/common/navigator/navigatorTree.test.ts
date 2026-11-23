// @vitest-environment node

import { expect, test } from 'vitest';
import {
  breadcrumb, buildIndex, navigatorLines, preorder, resolveDrop, type NavigatorNode, type NavigatorTreeOptions,
} from '../../../common/navigator/navigatorTree.js';

const options: NavigatorTreeOptions<NavigatorNode> = {
  types: {
    folder: { container: true, allowedParents: [null, 'folder'] },
    item: { container: false, allowedParents: [null, 'folder'] },
  },
  label: node => node.title.toUpperCase() || 'Unnamed',
  maxNodes: 10_000,
  isId: (value): value is string => typeof value === 'string' && value.length > 0,
  invalidTree: 'Invalid tree.',
};

const folder = { id: 'folder', parentId: null, kind: 'folder', title: 'Cast', position: 0 };
const inner = { id: 'inner', parentId: folder.id, kind: 'folder', title: 'Crew', position: 0 };
const child = { id: 'child', parentId: inner.id, kind: 'item', title: '', position: 0 };
const loose = { id: 'loose', parentId: null, kind: 'item', title: 'Marin', position: 1 };
const nodes = [loose, child, inner, folder];

test('uses the supplied kinds and labels for nested folders, rows, and drop targets', () => {
  const result = buildIndex(nodes, options);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.reason);
  }

  const { index } = result;
  expect(breadcrumb(child.id, index)).toEqual(['CAST', 'CREW', 'Unnamed']);
  expect(navigatorLines({
    folderId: folder.id, expanded: new Set([inner.id]), hiddenKinds: new Set(),
  }, index)).toMatchObject([
    { kind: 'up', parentId: null },
    { kind: 'node', key: inner.id, dir: true, open: true, depth: 1 },
    { kind: 'node', key: child.id, dir: false, depth: 2, twig: [false, false] },
  ]);
  expect(resolveDrop([loose.id], { kind: 'node', key: child.id }, 'into', null, index)).toMatchObject({ ok: false });
  expect(resolveDrop([folder.id], { kind: 'node', key: inner.id }, 'into', null, index)).toMatchObject({ ok: false });
  expect(resolveDrop([loose.id], { kind: 'node', key: inner.id }, 'into', null, index)).toEqual({
    ok: true, sourceIds: [loose.id], destination: { parentId: inner.id },
  });
});

test('rejects a disconnected parent cycle even when folders may contain folders', () => {
  expect(buildIndex([{ ...folder, parentId: inner.id }, inner], options)).toEqual({
    ok: false, reason: 'Invalid tree.',
  });
});

test('flattens and traverses a fully expanded 10,000-node chain', () => {
  const chain = Array.from({ length: options.maxNodes }, (_, depth) => ({
    ...folder, id: String(depth), parentId: depth === 0 ? null : String(depth - 1),
  }));
  const result = buildIndex(chain, options);
  if (!result.ok) {
    throw new Error(result.reason);
  }

  const lines = navigatorLines({
    folderId: null, expanded: new Set(chain.map(node => node.id)), hiddenKinds: new Set(),
  }, result.index);
  expect(lines).toHaveLength(options.maxNodes);
  expect(lines.at(-1)).toMatchObject({ key: '9999', depth: options.maxNodes });
  expect([...preorder(null, result.index)]).toEqual(chain);
});
