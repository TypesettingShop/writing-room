// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { ManuscriptNode } from '../../../../../platform/manuscript/common/manuscript.js';
import {
  breadcrumb, buildIndex, documentsUnder, dropPositionAt, firstKey, hasDocumentsUnder, labelOf, moveKey, navigatorLines,
  parentLine, resolveDrop, revealOffset, twigParts, TWIG_TEXT, UP_KEY, windowRange, type ManuscriptIndex,
} from '../../common/manuscriptTree.js';

function id(number: number): string {
  return `00000000-0000-0000-0000-${number.toString(16).padStart(12, '0')}`;
}

function node(number: number, kind: ManuscriptNode['kind'], position: number, parent?: number, title = ''): ManuscriptNode {
  return { id: id(number), kind, parentId: parent === undefined ? null : id(parent), title, position, metadata: {}, createdAt: 0, updatedAt: 0 };
}

function indexOf(nodes: ManuscriptNode[]): ManuscriptIndex {
  const result = buildIndex(nodes);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.index;
}

const nodes = [
  node(1, 'part', 0, undefined, 'Opening'), node(2, 'document', 1), node(3, 'part', 2),
  node(4, 'chapter', 3), node(5, 'chapter', 4),
  node(6, 'chapter', 0, 1, 'First'), node(7, 'document', 1, 1), node(8, 'chapter', 2, 1),
  node(9, 'chapter', 0, 3), node(10, 'document', 0, 6, 'Scene'), node(11, 'document', 1, 6),
  node(12, 'document', 0, 8), node(13, 'document', 0, 9),
];

const row = (number: number) => ({ kind: 'node', key: id(number) }) as const;

describe('manuscript tree index', () => {
  it('numbers siblings of each kind in their own folder and derives breadcrumb labels', () => {
    const index = indexOf([...nodes].reverse());
    expect(nodes.map(item => labelOf(item, index))).toEqual([
      '1부 - Opening', 'Untitled', '2부', '1장', '2장', '1장 - First', 'Untitled', '2장', '1장', 'Scene', 'Untitled', 'Untitled', 'Untitled',
    ]);
    expect(breadcrumb(id(10), index)).toEqual(['1부 - Opening', '1장 - First', 'Scene']);
    const reordered = nodes.map(item => item.id === id(1) ? { ...item, position: 2 } : item.id === id(3) ? { ...item, position: 0 } : item);
    expect(breadcrumb(id(10), indexOf(reordered))).toEqual(['2부 - Opening', '1장 - First', 'Scene']);
  });

  it('reports malformed structural data without throwing', () => {
    const invalidInputs = [
      [node(1, 'document', 0, 2)],
      [node(1, 'part', 0, 2), node(2, 'chapter', 0, 1)],
      [node(1, 'chapter', 0, 1)],
      [node(1, 'part', 0), node(2, 'part', 0)],
      [node(1, 'part', 0), node(1, 'part', 1)],
      [node(1, 'part', 0), node(2, 'part', 2), node(3, 'document', 0, 1)],
      [{ ...nodes[0], position: -1 }],
      [{ ...nodes[0], title: null }],
      [null],
    ];
    for (const input of invalidInputs) {
      expect(buildIndex(input as ManuscriptNode[])).toEqual({ ok: false, reason: 'The manuscript tree is invalid.' });
    }
  });

  it('indexes and unfolds 10,000 nodes in position order', () => {
    const large = Array.from({ length: 10_000 }, (_, position) => node(position + 1, 'document', position)).reverse();
    const start = performance.now();
    const index = indexOf(large);
    const lines = navigatorLines({ folderId: null, expanded: new Set(), hiddenKinds: new Set() }, index);
    const elapsed = performance.now() - start;
    expect(lines).toHaveLength(10_000);
    expect(lines[0].key).toBe(id(1));
    expect(lines.at(-1)?.key).toBe(id(10_000));
    // The interaction target is 50 ms. Report the measurement without a machine-dependent test failure.
    console.info(`10,000 manuscript rows indexed and flattened in ${elapsed.toFixed(1)} ms`);
  });
});

describe('manuscript navigator rows', () => {
  const index = indexOf(nodes);
  const expanded = new Set([id(1), id(6), id(8)]);
  const hiddenKinds = new Set<ManuscriptNode['kind']>();

  it('flattens expanded folders, draws branches and navigates into folders', () => {
    const lines = navigatorLines({ folderId: null, expanded, hiddenKinds }, index);
    expect(lines.map(line => line.key)).toEqual([1, 6, 10, 11, 7, 8, 12, 2, 3, 4, 5].map(id));
    const text = lines.map(line => line.kind === 'node' ? twigParts(line.twig).map(part => TWIG_TEXT[part]).join('') : 'up');
    expect(text).toEqual(['', '├─', '│ ├─', '│ └─', '├─', '└─', '  └─', '', '', '', '']);
    expect(lines[2].depth).toBe(3);
    expect(parentLine(lines, 2)).toBe(1);
    expect(moveKey(lines, id(10), 1)).toBe(id(11));

    const inner = navigatorLines({ folderId: id(6), expanded, hiddenKinds }, index);
    expect(inner.map(line => line.key)).toEqual([UP_KEY, id(10), id(11)]);
    expect(inner[0]).toMatchObject({ parentId: id(1) });
    expect(firstKey(inner)).toBe(id(10));
    expect(moveKey(inner, id(10), -1)).toBe(UP_KEY);
  });

  it('uses visible siblings for the branch ending and hides the descendants of a hidden folder', () => {
    const lines = navigatorLines({ folderId: id(1), expanded, hiddenKinds: new Set(['chapter']) }, index);
    expect(lines.map(line => line.key)).toEqual([UP_KEY, id(7)]);
    expect(lines[1]).toMatchObject({ twig: [false] });
  });

  it('windows the viewport with eight rows of overscan and reveals a whole row', () => {
    expect(windowRange(2401, 240, 24, 10_000)).toEqual({ start: 92, end: 119 });
    expect(windowRange(0, 240, 24, 5)).toEqual({ start: 0, end: 5 });
    expect(revealOffset(2401, 240, 2400, 24)).toBe(2400);
    expect(revealOffset(2400, 240, 2640, 24)).toBe(2424);
    expect(revealOffset(2400, 240, 2640 - 24, 24)).toBe(2400);
  });
});

describe('manuscript drop and opening rules', () => {
  const index = indexOf(nodes);

  it('chooses quarters or halves according to the target capacity', () => {
    expect([0, 6, 12, 18].map(y => dropPositionAt(y, 24, true))).toEqual(['before', 'into', 'into', 'after']);
    expect([0, 6, 12, 18].map(y => dropPositionAt(y, 24, false))).toEqual(['before', 'before', 'after', 'after']);
  });

  it('preserves tree order and drops only topmost selected nodes', () => {
    expect(resolveDrop([id(7), id(10), id(6)], row(3), 'into', null, index)).toEqual({
      ok: true, destination: { parentId: id(3) }, sourceIds: [id(6), id(7)],
    });
    expect(resolveDrop([id(11), id(2), id(7)], row(6), 'after', id(1), index)).toEqual({
      ok: true, destination: { parentId: id(1), beforeId: id(8) }, sourceIds: [id(11), id(7), id(2)],
    });
    expect(resolveDrop([id(11)], row(10), 'before', id(6), index)).toMatchObject({
      ok: true, destination: { parentId: id(6), beforeId: id(10) },
    });
  });

  it('inserts after an expanded folder row before its first nonmoving child', () => {
    const openChapter = { ...row(6), open: true };
    expect(resolveDrop([id(2)], openChapter, 'after', null, index)).toMatchObject({
      ok: true, destination: { parentId: id(6), beforeId: id(10) },
    });
    expect(resolveDrop([id(10), id(2)], openChapter, 'after', null, index)).toMatchObject({
      ok: true, destination: { parentId: id(6), beforeId: id(11) },
    });
    expect(resolveDrop([id(2)], row(6), 'after', null, index)).toMatchObject({
      ok: true, destination: { parentId: id(1), beforeId: id(7) },
    });
    expect(resolveDrop([id(8)], openChapter, 'after', null, index)).toMatchObject({ ok: false });
  });

  it('appends on empty space or the parent row and rejects invalid or recursive destinations', () => {
    expect(resolveDrop([id(2)], undefined, 'into', id(6), index)).toMatchObject({ ok: true, destination: { parentId: id(6) } });
    expect(resolveDrop([id(11)], { kind: 'up' }, 'before', id(6), index)).toMatchObject({ ok: true, destination: { parentId: id(1) } });
    expect(resolveDrop([id(1)], row(10), 'before', null, index)).toMatchObject({ ok: false });
    expect(resolveDrop([id(1)], row(1), 'after', null, index)).toMatchObject({ ok: false });
    expect(resolveDrop([id(1)], undefined, 'into', id(6), index)).toMatchObject({ ok: false });
    expect(resolveDrop([id(6)], row(8), 'into', id(1), index)).toEqual({ ok: false, reason: 'A chapter cannot go inside a chapter.' });
    expect(resolveDrop([id(3)], row(6), 'before', null, index)).toEqual({ ok: false, reason: 'A part cannot go inside a part.' });
  });

  it('finds documents in depth-first tree order', () => {
    expect(documentsUnder(null, index)).toEqual([10, 11, 7, 12, 2, 13].map(id));
    expect(documentsUnder(id(1), index)).toEqual([10, 11, 7, 12].map(id));
    expect(documentsUnder(id(10), index)).toEqual([id(10)]);
    expect(documentsUnder(id(4), index)).toEqual([]);
    expect(hasDocumentsUnder(id(1), index)).toBe(true);
    expect(hasDocumentsUnder(id(10), index)).toBe(true);
    expect(hasDocumentsUnder(id(4), index)).toBe(false);
  });
});
