import { describe, expect, test } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import {
  compareExplorerItems, compareFileNames, ExplorerModel, MAX_EXPLORER_CHILDREN,
} from '../../common/explorerModel.js';

const root = URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace' });

describe('compareFileNames', () => {
  test('orders numbers by value, ignores case and keeps the order total', () => {
    const names = ['file10.md', 'File2.md', 'file1.md', 'b', 'B', 'a10', 'a9'];
    expect([...names].sort(compareFileNames)).toEqual(['a9', 'a10', 'B', 'b', 'file1.md', 'File2.md', 'file10.md']);
    expect(compareFileNames('same', 'same')).toBe(0);
  });

  test('puts folders before files', () => {
    const entries = [
      { name: 'a.md', isDirectory: false },
      { name: 'z', isDirectory: true },
      { name: 'b', isDirectory: true },
    ];
    expect([...entries].sort(compareExplorerItems).map(entry => entry.name)).toEqual(['b', 'z', 'a.md']);
  });
});

describe('ExplorerModel', () => {
  test('keeps the items of entries that stay, and what was read below them', () => {
    const model = new ExplorerModel(root, 'workspace');
    model.root.setChildren([{ name: 'docs', isDirectory: true }, { name: 'a.md', isDirectory: false }]);
    const docs = model.root.getChild('docs')!;
    docs.setChildren([{ name: 'inner.md', isDirectory: false }]);
    const removed = model.root.setChildren([{ name: 'docs', isDirectory: true }, { name: 'b.md', isDirectory: false }]);
    expect(removed.map(item => item.name)).toEqual(['a.md']);
    expect(model.root.getChild('docs')).toBe(docs);
    expect(model.find(URI.joinPath(root, 'docs/inner.md'))?.name).toBe('inner.md');
    expect(removed[0].isAttached).toBe(false);
    expect(docs.isAttached).toBe(true);
    expect(model.root.children?.map(item => item.name)).toEqual(['docs', 'b.md']);
  });

  test('an entry that changes kind gets a new item', () => {
    const model = new ExplorerModel(root, 'workspace');
    model.root.setChildren([{ name: 'x', isDirectory: false }]);
    const file = model.root.getChild('x')!;
    model.root.setChildren([{ name: 'x', isDirectory: true }]);
    expect(model.root.getChild('x')).not.toBe(file);
    expect(model.root.getChild('x')?.isDirectory).toBe(true);
  });

  test(`shows the first ${MAX_EXPLORER_CHILDREN} entries of a folder and counts the rest`, () => {
    const model = new ExplorerModel(root, 'workspace');
    const stats = Array.from({ length: MAX_EXPLORER_CHILDREN + 3 }, (_, index) => ({ name: `f${index}.md`, isDirectory: false }));
    model.root.setChildren(stats);
    expect(model.root.visibleChildren).toHaveLength(MAX_EXPLORER_CHILDREN);
    expect(model.root.hiddenChildCount).toBe(3);
    expect(model.root.visibleChildren.at(-1)?.name).toBe(`f${MAX_EXPLORER_CHILDREN - 1}.md`);
    model.root.setChildren(stats.slice(0, MAX_EXPLORER_CHILDREN));
    expect(model.root.hiddenChildCount).toBe(0);
  });

  test('finds nothing outside the root', () => {
    const model = new ExplorerModel(root, 'workspace');
    expect(model.find(URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/other' }))).toBeUndefined();
    expect(model.find(root)).toBe(model.root);
  });
});
