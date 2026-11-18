import { afterEach, expect, test } from 'vitest';
import { GridView, isGridBranchNode, Orientation, Sizing } from '../../../../browser/ui/grid/gridview.js';
import type { GridNode } from '../../../../browser/ui/grid/gridview.js';
import { TestView } from './util.js';

let gridview: GridView | undefined;

afterEach(() => {
  gridview?.dispose();
  gridview = undefined;
});

function shape(node: GridNode): unknown {
  return isGridBranchNode(node) ? node.children.map(shape) : (node.view as TestView).id;
}

function build(): TestView[] {
  const views = ['a', 'b', 'c'].map(id => new TestView(id));
  gridview = new GridView();
  gridview.layout(800, 600);
  gridview.addView(views[0], 200, [0]);
  gridview.addView(views[1], 400, [1]);
  gridview.addView(views[2], Sizing.Split(0), [1, 1]);
  return views;
}

test('views are added by index path and a path into a view splits it', () => {
  const [a, b, c] = build();
  expect(gridview!.orientation).toBe(Orientation.VERTICAL);
  expect(shape(gridview!.getView())).toEqual(['a', ['b', 'c']]);
  expect(a.lastLayout).toEqual({ width: 800, height: 200, top: 0, left: 0 });
  expect(b.lastLayout).toEqual({ width: 400, height: 400, top: 200, left: 0 });
  expect(c.lastLayout).toEqual({ width: 400, height: 400, top: 200, left: 400 });
  expect(gridview!.getViewLocation(c)).toEqual([1, 1]);
});

test('turning the root keeps the shape and every share along the other axis', () => {
  const [a, b, c] = build();
  gridview!.orientation = Orientation.HORIZONTAL;
  expect(shape(gridview!.getView())).toEqual(['a', ['b', 'c']]);
  // a held 200 of 600 px of height: it now holds a third of the 800 px width.
  expect(a.lastLayout).toEqual({ width: 267, height: 600, top: 0, left: 0 });
  expect(b.lastLayout).toEqual({ width: 533, height: 300, top: 0, left: 267 });
  expect(c.lastLayout).toEqual({ width: 533, height: 300, top: 300, left: 267 });
  expect([a, b, c].every(view => gridview!.element.contains(view.element))).toBe(true);
});

test('locations that lead nowhere throw instead of changing the tree', () => {
  build();
  const view = new TestView('x');
  expect(() => gridview!.addView(view, 100, [5])).toThrow(/Invalid grid/);
  expect(() => gridview!.addView(view, 100, [0, 2])).toThrow(/Invalid grid/);
  expect(() => gridview!.addView(view, 100, [])).toThrow(/Invalid grid/);
  expect(() => gridview!.removeView([1])).toThrow(/Invalid grid/);
  expect(() => gridview!.setViewVisible([1, 7], false)).toThrow(/Invalid grid/);
  expect(() => gridview!.moveView([0], 0, 1)).toThrow(/Invalid grid/);
  expect(shape(gridview!.getView())).toEqual(['a', ['b', 'c']]);
});

test('the grid reports a change of its limits', () => {
  const [a] = build();
  let changes = 0;
  gridview!.onDidChange(() => changes++);
  expect(gridview!.minimumHeight).toBe(0);
  a.setLimits({ minimumHeight: 150 });
  expect(changes).toBe(1);
  expect(gridview!.minimumHeight).toBe(150);
  a.setLimits({ minimumHeight: 150 });
  expect(changes).toBe(1);
});

test('a view that asks for a size gets it along its parent\'s axis', () => {
  const [a, b] = build();
  a.requestSize({ width: 800, height: 300 });
  expect(a.height).toBe(300);
  expect(b.height).toBe(300);
});
