import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { $ } from '../../../../browser/dom.js';
import {
  Direction, getLocationOrientation, getRelativeLocation, Grid, LayoutPriority, Orientation, SerializableGrid, Sizing,
} from '../../../../browser/ui/grid/grid.js';
import type { ISerializedGrid } from '../../../../browser/ui/grid/grid.js';
import { expectGridInvariants, shapeOf, TestView } from './util.js';

let container: HTMLElement;
let grid: Grid<TestView> | undefined;

beforeEach(() => {
  container = $('.container');
  document.body.append(container);
});

afterEach(() => {
  grid?.dispose();
  grid = undefined;
  container.remove();
});

function createGrid(first: TestView, width = 800, height = 600, options: { proportionalLayout?: boolean } = {}): Grid<TestView> {
  grid = new Grid(first, options);
  container.append(grid.element);
  grid.layout(width, height);
  return grid;
}

describe('locations', () => {
  test('a location alternates orientation with depth', () => {
    expect(getLocationOrientation(Orientation.VERTICAL, [0])).toBe(Orientation.VERTICAL);
    expect(getLocationOrientation(Orientation.VERTICAL, [0, 1])).toBe(Orientation.HORIZONTAL);
    expect(getLocationOrientation(Orientation.VERTICAL, [0, 1, 0])).toBe(Orientation.VERTICAL);
  });

  test('a direction along the parent gives a sibling; across it, a split of the view', () => {
    expect(getRelativeLocation(Orientation.VERTICAL, [1], Direction.Down)).toEqual([2]);
    expect(getRelativeLocation(Orientation.VERTICAL, [1], Direction.Up)).toEqual([1]);
    expect(getRelativeLocation(Orientation.VERTICAL, [1], Direction.Right)).toEqual([1, 1]);
    expect(getRelativeLocation(Orientation.VERTICAL, [1], Direction.Left)).toEqual([1, 0]);
    expect(getRelativeLocation(Orientation.VERTICAL, [1, 0], Direction.Right)).toEqual([1, 1]);
    expect(getRelativeLocation(Orientation.VERTICAL, [1, 0], Direction.Down)).toEqual([1, 0, 1]);
  });
});

describe('adding views', () => {
  test('with a single view, adding across the root turns the root instead of nesting', () => {
    const [a, b] = [new TestView('a'), new TestView('b')];
    createGrid(a);
    expect(grid!.orientation).toBe(Orientation.VERTICAL);

    grid!.addView(b, Sizing.Split, a, Direction.Right);
    expect(grid!.orientation).toBe(Orientation.HORIZONTAL);
    expect(shapeOf(grid!)).toEqual(['a', 'b']);
    expect([a.width, b.width]).toEqual([400, 400]);
    expect([a.height, b.height]).toEqual([600, 600]);
    expectGridInvariants(grid!);
  });

  test('along the parent\'s axis a view becomes a sibling, across it a nested branch', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Right);
    expect(shapeOf(grid!)).toEqual(['a', 'b', 'c']);

    grid!.addView(d, Sizing.Split, b, Direction.Down);
    expect(shapeOf(grid!)).toEqual(['a', ['b', 'd'], 'c']);
    expect(b.lastLayout).toEqual({ width: 200, height: 300, top: 0, left: 400 });
    expect(d.lastLayout).toEqual({ width: 200, height: 300, top: 300, left: 400 });
    expectGridInvariants(grid!);
  });

  test('adding before a view puts it first in the new branch', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, 100, b, Direction.Up);
    expect(shapeOf(grid!)).toEqual(['a', ['c', 'b']]);
    expect(c.height).toBe(100);
    expect(b.height).toBe(500);
    expectGridInvariants(grid!);
  });

  test('Distribute evens the siblings out and Split halves the reference', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => new TestView(id));
    createGrid(a, 900, 600);
    grid!.addView(b, 300, a, Direction.Right);
    expect([a.width, b.width]).toEqual([600, 300]);
    grid!.addView(c, Sizing.Distribute, b, Direction.Right);
    expect([a.width, b.width, c.width]).toEqual([300, 300, 300]);

    grid!.resizeView(a, { width: 500 });
    grid!.addView(d, Sizing.Split, a, Direction.Right);
    expect(a.width).toBe(250);
    expect(d.width).toBe(250);
    expectGridInvariants(grid!);
  });

  test('Auto distributes equal siblings and splits unequal ones', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => new TestView(id));
    createGrid(a, 900, 600);
    grid!.addView(b, Sizing.Auto, a, Direction.Right);
    expect([a.width, b.width]).toEqual([450, 450]);
    grid!.addView(c, Sizing.Auto, b, Direction.Right);
    expect([a.width, b.width, c.width]).toEqual([300, 300, 300]);

    grid!.resizeView(a, { width: 500 });
    grid!.addView(d, Sizing.Auto, a, Direction.Right);
    expect([a.width, d.width]).toEqual([250, 250]);
    expectGridInvariants(grid!);
  });

  test('the same view cannot be added twice', () => {
    const [a, b] = [new TestView('a'), new TestView('b')];
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Down);
    expect(() => grid!.addView(b, Sizing.Split, a, Direction.Down)).toThrow();
  });
});

describe('removing views', () => {
  test('a branch left with one child gives way to that child', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Right);
    grid!.addView(d, Sizing.Split, b, Direction.Down);
    expect(shapeOf(grid!)).toEqual(['a', ['b', 'd'], 'c']);
    const before = [a.width, b.width, c.width];

    grid!.removeView(d);
    expect(shapeOf(grid!)).toEqual(['a', 'b', 'c']);
    expect([a.width, b.width, c.width]).toEqual(before);
    expect(b.height).toBe(600);
    expectGridInvariants(grid!);
  });

  test('a sibling branch left alone merges its children into the grandparent', () => {
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(id => new TestView(id));
    createGrid(a, 800, 600);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);
    grid!.addView(d, Sizing.Split, c, Direction.Right);
    grid!.addView(e, Sizing.Split, b, Direction.Right);
    expect(shapeOf(grid!)).toEqual(['a', [['b', 'e'], ['c', 'd']]]);

    grid!.removeView(c);
    expect(shapeOf(grid!)).toEqual(['a', [['b', 'e'], 'd']]);
    grid!.removeView(d);
    // [b, e] would be the only child of the column: it joins the root's row.
    expect(shapeOf(grid!)).toEqual(['a', 'b', 'e']);
    expect(a.width + b.width + e.width).toBe(800);
    expectGridInvariants(grid!);
  });

  test('a root left with one branch hands the root to it and turns', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);
    expect(grid!.orientation).toBe(Orientation.HORIZONTAL);
    expect(shapeOf(grid!)).toEqual(['a', ['b', 'c']]);

    grid!.removeView(a);
    expect(grid!.orientation).toBe(Orientation.VERTICAL);
    expect(shapeOf(grid!)).toEqual(['b', 'c']);
    expect([b.width, c.width]).toEqual([800, 800]);
    expect(b.height + c.height).toBe(600);
    expectGridInvariants(grid!);
  });

  test('Distribute on a collapsing removal evens out only the branch it changes', () => {
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(id => new TestView(id));
    createGrid(a, 1000, 600);
    grid!.addView(b, 200, a, Direction.Right);
    grid!.addView(c, 100, a, Direction.Down);
    grid!.addView(d, 300, b, Direction.Down);
    grid!.addView(e, 100, d, Direction.Right);
    expect(shapeOf(grid!)).toEqual([['a', 'c'], ['b', ['d', 'e']]]);
    const untouched = [a.width, b.width, a.height, c.height];

    grid!.removeView(e, Sizing.Distribute);
    expect(shapeOf(grid!)).toEqual([['a', 'c'], ['b', 'd']]);
    expect([a.width, b.width, a.height, c.height]).toEqual(untouched);
    expect([b.height, d.height]).toEqual([300, 300]);
    expectGridInvariants(grid!);
  });

  test('a root with one view left keeps it as a single leaf', () => {
    const [a, b] = [new TestView('a'), new TestView('b')];
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Down);
    grid!.removeView(b);
    expect(shapeOf(grid!)).toEqual(['a']);
    expect(a.lastLayout).toEqual({ width: 800, height: 600, top: 0, left: 0 });
    expect(() => grid!.removeView(a)).toThrow();
  });
});

describe('moving views', () => {
  test('a view moved to another branch keeps its element and is laid out there', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);
    const element = a.element;
    const layouts = a.layouts.length;

    grid!.moveView(a, Sizing.Split, c, Direction.Right);
    expect(a.element).toBe(element);
    expect(grid!.element.contains(element)).toBe(true);
    expect(a.layouts.length).toBeGreaterThan(layouts);
    expect(shapeOf(grid!)).toEqual(['b', ['c', 'a']]);
    expect(grid!.orientation).toBe(Orientation.VERTICAL);
    expectGridInvariants(grid!);
  });

  test('a moved view keeps what it holds and the focus inside it', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    const input = $('input');
    a.element.append(input);
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);
    input.value = 'typed text';
    input.focus();
    expect(document.activeElement).toBe(input);

    grid!.moveView(a, Sizing.Split, c, Direction.Down);
    expect(a.element.contains(input)).toBe(true);
    expect(input.value).toBe('typed text');
    expect(document.activeElement).toBe(input);
    expectGridInvariants(grid!);
  });

  test('moving within one branch reorders without resizing', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a, 900, 600);
    grid!.addView(b, 300, a, Direction.Right);
    grid!.addView(c, 200, b, Direction.Right);
    const widths = { a: a.width, b: b.width, c: c.width };

    grid!.moveView(a, Sizing.Split, c, Direction.Right);
    expect(shapeOf(grid!)).toEqual(['b', 'c', 'a']);
    expect({ a: a.width, b: b.width, c: c.width }).toEqual(widths);
    expect(a.lastLayout?.left).toBe(widths.b + widths.c);

    grid!.moveViewTo(a, [0]);
    expect(shapeOf(grid!)).toEqual(['a', 'b', 'c']);
    expectGridInvariants(grid!);
  });

  test('moveViewTo reads the index after the view left, and a bad target moves nothing', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a, 900, 600);
    grid!.addView(b, 300, a, Direction.Right);
    grid!.addView(c, 300, b, Direction.Right);

    grid!.moveViewTo(a, [2]);
    expect(shapeOf(grid!)).toEqual(['b', 'c', 'a']);

    expect(() => grid!.moveViewTo(a, [5, 0])).toThrow(/Invalid grid/);
    expect(shapeOf(grid!)).toEqual(['b', 'c', 'a']);
    expect(grid!.getViewLocation(a)).toEqual([2]);
    expect(a.element.isConnected).toBe(true);
    expectGridInvariants(grid!);
  });

  test('a bad moveViewTo target leaves the grid untouched when the move would collapse the root', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);
    const orientation = grid!.orientation;

    expect(() => grid!.moveViewTo(a, [5, 0])).toThrow(/Invalid grid/);
    expect(shapeOf(grid!)).toEqual(['a', ['b', 'c']]);
    expect(grid!.orientation).toBe(orientation);
    expect(grid!.getViewSize(a)).toEqual({ width: 400, height: 600 });
    expectGridInvariants(grid!);
  });

  test('moveViewTo across branches keeps the element and its visibility', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);
    grid!.setViewVisible(c, false);

    grid!.moveViewTo(c, [0]);
    expect(shapeOf(grid!)).toEqual(['c', 'a', 'b']);
    expect(grid!.isViewVisible(c)).toBe(false);
    expect(c.element.isConnected).toBe(true);
    expectGridInvariants(grid!);
  });
});

describe('sizes', () => {
  test('resizeView sizes both axes and keeps every invariant', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);

    grid!.resizeView(c, { width: 500, height: 200 });
    expect(c.width).toBe(500);
    expect(c.height).toBe(200);
    expect(grid!.getViewSize(c)).toEqual({ width: 500, height: 200 });
    expect(grid!.getViewSize()).toEqual({ width: 800, height: 600 });
    expectGridInvariants(grid!);
  });

  test('limits hold whenever the container has room for them', () => {
    const a = new TestView('a', { minimumWidth: 170, minimumHeight: 100 });
    const b = new TestView('b', { minimumWidth: 220, maximumWidth: 600, minimumHeight: 70 });
    const c = new TestView('c', { minimumHeight: 77, maximumHeight: 400 });
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);
    for (const [width, height] of [[1600, 1200], [400, 200], [800, 600], [391, 147]]) {
      grid!.layout(width, height);
      expectGridInvariants(grid!);
    }
    grid!.resizeView(a, { width: 10 });
    expect(a.width).toBe(170);
    expectGridInvariants(grid!);
  });

  test('a container smaller than the minimums gives finite, non-negative sizes', () => {
    const a = new TestView('a', { minimumWidth: 300, minimumHeight: 300 });
    const b = new TestView('b', { minimumWidth: 300, minimumHeight: 300 });
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    for (const [width, height] of [[100, 50], [0, 0], [-10, Number.NaN]]) {
      grid!.layout(width, height);
      expectGridInvariants(grid!, { limitsFit: false });
      for (const view of [a, b]) {
        const { width: w, height: h, top, left } = view.lastLayout!;
        expect([w, h, top, left].every(value => Number.isFinite(value))).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(h).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('without proportions, resizing the grid changes the high-priority view first', () => {
    const sidebar = new TestView('sidebar', { minimumWidth: 170, priority: LayoutPriority.Low });
    const editor = new TestView('editor', { minimumWidth: 220, minimumHeight: 70, priority: LayoutPriority.High });
    const panel = new TestView('panel', { minimumHeight: 77 });
    createGrid(sidebar, 1000, 600, { proportionalLayout: false });
    grid!.addView(editor, 700, sidebar, Direction.Right);
    grid!.addView(panel, 200, editor, Direction.Down);
    expect([sidebar.width, editor.width]).toEqual([300, 700]);
    expect([editor.height, panel.height]).toEqual([400, 200]);

    grid!.layout(1200, 800);
    expect(sidebar.width).toBe(300);
    expect(editor.width).toBe(900);
    expect(panel.height).toBe(200);
    expect(editor.height).toBe(600);

    grid!.layout(700, 500);
    expect(sidebar.width).toBe(300);
    expect(editor.width).toBe(400);
    expect(panel.height).toBe(200);
    expectGridInvariants(grid!);
  });

  test('with proportions, resizing the grid keeps every share', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a, 1000, 600);
    grid!.addView(b, 400, a, Direction.Right);
    grid!.addView(c, 200, b, Direction.Down);
    grid!.layout(2000, 1200);
    expect([a.width, b.width]).toEqual([1200, 800]);
    expect([b.height, c.height]).toEqual([800, 400]);
    expectGridInvariants(grid!);
  });

  test('distributeViewSizes evens out every branch', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => new TestView(id));
    createGrid(a, 900, 600);
    grid!.addView(b, 100, a, Direction.Right);
    grid!.addView(c, 100, b, Direction.Right);
    grid!.addView(d, 100, c, Direction.Down);
    grid!.distributeViewSizes();
    expect([a.width, b.width, c.width]).toEqual([300, 300, 300]);
    expect([c.height, d.height]).toEqual([300, 300]);
  });
});

describe('visibility', () => {
  test('a hidden view takes no space and gets its size back when shown', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, 300, a, Direction.Right);
    grid!.addView(c, 200, b, Direction.Down);
    const before = { a: a.lastLayout, b: b.lastLayout, c: c.lastLayout };

    grid!.setViewVisible(c, false);
    expect(grid!.isViewVisible(c)).toBe(false);
    expect(c.height).toBe(0);
    expect(b.height).toBe(600);
    expect(grid!.getViewCachedVisibleSize(c)).toBe(200);
    expectGridInvariants(grid!);

    grid!.setViewVisible(c, true);
    expect({ a: a.lastLayout, b: b.lastLayout, c: c.lastLayout }).toEqual(before);
    expectGridInvariants(grid!);
  });

  test('a branch whose views are all hidden is hidden, and shows again with its size', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a, 800, 600);
    grid!.addView(b, 300, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);

    grid!.setViewVisible(b, false);
    grid!.setViewVisible(c, false);
    const column = grid!.getViews().children[1];
    expect(column.cachedVisibleSize).toBe(300);
    expect(column.box.width).toBe(0);
    expect(a.width).toBe(800);
    expectGridInvariants(grid!);

    grid!.setViewVisible(c, true);
    expect(grid!.getViews().children[1].cachedVisibleSize).toBeUndefined();
    expect(c.width).toBe(300);
    expect(c.height).toBe(600);
    expect(a.width).toBe(500);
    expectGridInvariants(grid!);
  });

  test('splitting a view beside a hidden sibling leaves the other views their sizes', () => {
    const x = new TestView('x');
    const l = new TestView('l');
    const h = new TestView('h');
    const y = new TestView('y', { maximumWidth: 250 });
    const n = new TestView('n');
    createGrid(x, 800, 600);
    grid!.addView(l, 500, x, Direction.Right);
    grid!.addView(y, 200, l, Direction.Right);
    grid!.addView(h, 300, l, Direction.Down);
    grid!.setViewVisible(h, false);
    expect([x.width, l.width, y.width]).toEqual([300, 300, 200]);

    grid!.addView(n, Sizing.Split, l, Direction.Right);
    expect(shapeOf(grid!)).toEqual(['x', [['l', 'n'], 'h'], 'y']);
    expect([x.width, l.width + n.width, y.width]).toEqual([300, 300, 200]);
    expectGridInvariants(grid!);
  });

  test('turning the grid keeps a branch whose views are all hidden hidden', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => new TestView(id));
    createGrid(a, 800, 600);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);
    grid!.addView(d, Sizing.Split, a, Direction.Down);
    grid!.setViewVisible(b, false);
    grid!.setViewVisible(c, false);

    grid!.orientation = Orientation.VERTICAL;
    expect(shapeOf(grid!)).toEqual([['a', 'd'], ['b', 'c']]);
    expect(grid!.getViews().children[1].cachedVisibleSize).not.toBeUndefined();
    expect([a.height, d.height]).toEqual([600, 600]);
    expectGridInvariants(grid!);
  });

  test('neighbours are the visible views across an edge, wrapping when asked', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);

    expect(grid!.getNeighborViews(a, Direction.Right)).toEqual([b, c]);
    expect(grid!.getNeighborViews(b, Direction.Down)).toEqual([c]);
    expect(grid!.getNeighborViews(b, Direction.Up)).toEqual([]);
    expect(grid!.getNeighborViews(b, Direction.Up, true)).toEqual([c]);
    expect(grid!.getNeighborViews(c, Direction.Right, true)).toEqual([a]);
    grid!.setViewVisible(c, false);
    expect(grid!.getNeighborViews(a, Direction.Right)).toEqual([b]);
  });
});

describe('serialization', () => {
  const deserializer = (views: Map<string, TestView>) => ({
    fromJSON(json: unknown): TestView {
      const id = (json as { id?: unknown } | null)?.id;
      const view = typeof id === 'string' ? views.get(id) : undefined;
      if (!view) {
        throw new Error(`no view ${String(id)}`);
      }
      return view;
    },
  });

  function buildSerializable(): { grid: SerializableGrid<TestView>; views: TestView[] } {
    const views = ['a', 'b', 'c', 'd'].map(id => new TestView(id, { minimumWidth: 50, minimumHeight: 50 }));
    const [a, b, c, d] = views;
    const result = new SerializableGrid(a);
    container.append(result.element);
    result.layout(800, 600);
    result.addView(b, 300, a, Direction.Right);
    result.addView(c, 200, b, Direction.Down);
    result.addView(d, 150, a, Direction.Down);
    result.setViewVisible(d, false);
    return { grid: result, views };
  }

  test('deserialize(serialize()) gives the same tree, sizes and visibility', () => {
    const { grid: original, views } = buildSerializable();
    const json = original.serialize();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    const boxes = views.map(view => view.lastLayout);
    original.dispose();
    grid = undefined;

    const restored = SerializableGrid.deserialize(json, deserializer(new Map(views.map(view => [view.id, view]))));
    grid = restored;
    container.append(restored.element);
    restored.layout(800, 600);

    expect(shapeOf(restored)).toEqual([['a', 'd'], ['b', 'c']]);
    expect(restored.isViewVisible(views[3])).toBe(false);
    expect(restored.getViewCachedVisibleSize(views[3])).toBe(150);
    expect(views.slice(0, 3).map(view => view.lastLayout)).toEqual(boxes.slice(0, 3));
    expect(restored.serialize()).toEqual(json);
    expectGridInvariants(restored);

    restored.setViewVisible(views[3], true);
    expect(views[3].height).toBe(150);
    expectGridInvariants(restored);
  });

  test('stored data read into a smaller or larger container still fills it within limits', () => {
    const { grid: original, views } = buildSerializable();
    const json = original.serialize();
    original.dispose();
    grid = undefined;

    for (const [width, height] of [[400, 300], [1920, 1080], [300, 200]]) {
      const restored = SerializableGrid.deserialize(json, deserializer(new Map(views.map(view => [view.id, view]))));
      grid = restored;
      container.append(restored.element);
      restored.layout(width, height);
      expectGridInvariants(restored);
      expect(restored.getViewSize()).toEqual({ width, height });
      restored.dispose();
      grid = undefined;
    }
  });

  test('corrupt data throws one error instead of returning a grid', () => {
    const views = new Map(['a', 'b'].map(id => [id, new TestView(id)]));
    const good: ISerializedGrid = {
      orientation: Orientation.VERTICAL,
      width: 800,
      height: 600,
      root: {
        type: 'branch', size: 800, data: [
          { type: 'leaf', data: { id: 'a' }, size: 300 },
          { type: 'leaf', data: { id: 'b' }, size: 300 },
        ],
      },
    };
    const restored = SerializableGrid.deserialize(good, deserializer(views));
    restored.dispose();

    const corrupt: unknown[] = [
      null,
      'grid',
      { ...good, root: undefined },
      { ...good, orientation: 2 },
      { ...good, width: '800' },
      { ...good, root: { type: 'leaf', data: { id: 'a' }, size: 10 } },
      { ...good, root: { type: 'branch', size: 800, data: [] } },
      { ...good, root: { type: 'branch', size: 800, data: [{ type: 'leaf', data: { id: 'a' }, size: '300' }] } },
      { ...good, root: { type: 'branch', size: 800, data: [{ type: 'leaf', data: { id: 'a' } }] } },
      { ...good, root: { type: 'branch', size: 800, data: [{ type: 'leaf', size: 300 }] } },
      { ...good, root: { type: 'branch', size: 800, data: [{ type: 'leaf', data: { id: 'a' }, size: Number.NaN }] } },
      { ...good, root: { type: 'branch', size: 800, data: [{ type: 'leaf', data: { id: 'a' }, size: 300, visible: 'no' }] } },
      { ...good, root: { type: 'branch', size: 800, data: [{ type: 'pane', data: { id: 'a' }, size: 300 }] } },
      { ...good, root: { type: 'branch', size: 800, data: [{ type: 'branch', size: 300, data: [] }] } },
      { ...good, root: { type: 'branch', size: 800, data: [
        { type: 'leaf', data: { id: 'a' }, size: 300 },
        { type: 'branch', size: 300, data: [{ type: 'leaf', data: { id: 'b' }, size: 800 }] },
      ] } },
      { ...good, root: { type: 'branch', size: 800, data: [{ type: 'leaf', data: { id: 'missing' }, size: 300 }] } },
      { ...good, root: { type: 'branch', size: 800, data: [{ type: 'leaf', data: { id: 'a' }, size: 300 }, { type: 'leaf', data: { id: 'a' }, size: 300 }] } },
    ];
    for (const json of corrupt) {
      const before = document.querySelectorAll('.monaco-grid-view').length;
      expect(() => SerializableGrid.deserialize(json, deserializer(views)), JSON.stringify(json)).toThrow(/Invalid serialized grid/);
      expect(document.querySelectorAll('.monaco-grid-view').length).toBe(before);
    }
  });

  test('a view the deserializer made is disposed when the rest of the data fails', () => {
    const made: TestView[] = [];
    const json = {
      orientation: Orientation.HORIZONTAL, width: 100, height: 100,
      root: { type: 'branch', size: 100, data: [
        { type: 'leaf', data: { id: 'ok' }, size: 50 },
        { type: 'leaf', data: { id: 'bad' }, size: 50 },
      ] },
    };
    expect(() => SerializableGrid.deserialize(json, {
      fromJSON(data: unknown) {
        if ((data as { id: string }).id === 'bad') {
          throw new Error('cannot');
        }
        const view = new TestView('ok');
        made.push(view);
        return view;
      },
    })).toThrow(/Invalid serialized grid: root\.data\[1\]/);
    expect(made).toHaveLength(1);
    expect(made[0].disposed).toBe(true);
  });
});

describe('disposal', () => {
  test('a disposed grid leaves no elements, sashes or listeners behind', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => new TestView(id));
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.addView(c, Sizing.Split, b, Direction.Down);
    const sashes = [...grid!.element.querySelectorAll('.monaco-sash')];
    expect(sashes).toHaveLength(2);
    expect([a, b, c].every(view => view.listenerCount > 0)).toBe(true);

    grid!.dispose();
    grid = undefined;
    expect(container.childElementCount).toBe(0);
    expect(sashes.every(sash => !sash.isConnected)).toBe(true);
    expect([a, b, c].map(view => view.listenerCount)).toEqual([0, 0, 0]);
    expect([a, b, c].every(view => !view.element.isConnected)).toBe(true);
  });

  test('a removed view is no longer listened to', () => {
    const [a, b] = [new TestView('a'), new TestView('b')];
    createGrid(a);
    grid!.addView(b, Sizing.Split, a, Direction.Right);
    grid!.removeView(b);
    expect(b.listenerCount).toBe(0);
    expect(b.element.isConnected).toBe(false);
  });
});
