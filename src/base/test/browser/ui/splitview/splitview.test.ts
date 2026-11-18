import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { $ } from '../../../../browser/dom.js';
import { SashState } from '../../../../browser/ui/sash/sash.js';
import type { Sash } from '../../../../browser/ui/sash/sash.js';
import { LayoutPriority, Orientation, Sizing, SplitView } from '../../../../browser/ui/splitview/splitview.js';
import type { IView } from '../../../../browser/ui/splitview/splitview.js';
import { Emitter } from '../../../../common/event.js';

class TestView implements IView {
  readonly element = $('.test-view');
  private readonly _onDidChange = new Emitter<number | undefined>();
  readonly onDidChange = this._onDidChange.event;
  size = 0;
  offset = 0;
  layoutCount = 0;
  /** How deeply `layout` was entered inside itself; 1 means it never was. */
  maxLayoutDepth = 0;
  private layoutDepth = 0;
  visible = true;
  onLayout: ((view: TestView) => void) | undefined;

  constructor(public minimumSize = 0, public maximumSize = Number.POSITIVE_INFINITY, readonly priority?: LayoutPriority) {}

  layout(size: number, offset: number): void {
    this.size = size;
    this.offset = offset;
    this.layoutCount++;
    this.layoutDepth++;
    this.maxLayoutDepth = Math.max(this.maxLayoutDepth, this.layoutDepth);
    try {
      this.onLayout?.(this);
    } finally {
      this.layoutDepth--;
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  setLimits(minimumSize: number, maximumSize: number): void {
    this.minimumSize = minimumSize;
    this.maximumSize = maximumSize;
    this._onDidChange.fire(undefined);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

let container: HTMLElement;
let splitview: SplitView;

beforeEach(() => {
  container = $('.container');
  document.body.append(container);
});

afterEach(() => {
  splitview?.dispose();
  container.remove();
});

function sizes(views: readonly TestView[]): number[] {
  return views.map(view => view.size);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function create(views: readonly TestView[], size: number, options: { proportionalLayout?: boolean; orientation?: Orientation } = {}): SplitView {
  splitview = new SplitView(container, options);
  splitview.layout(size);
  for (const view of views) {
    splitview.addView(view, Sizing.Distribute);
  }
  return splitview;
}

/** Drags a sash with real pointer events, as the browser would deliver them. */
function drag(sash: Sash, from: number, to: number | number[], orientation: Orientation): void {
  const point = (value: number) => orientation === Orientation.VERTICAL ? { clientX: 0, clientY: value } : { clientX: value, clientY: 0 };
  sash.el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true, cancelable: true, ...point(from) }));
  for (const value of Array.isArray(to) ? to : [to]) {
    sash.el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, bubbles: true, cancelable: true, ...point(value) }));
  }
  sash.el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true, ...point(Array.isArray(to) ? to[to.length - 1] : to) }));
}

describe('adding and laying out', () => {
  test('views tile the split view and are positioned with inline geometry', () => {
    const views = [new TestView(), new TestView(), new TestView()];
    create(views, 300);

    expect(sizes(views)).toEqual([100, 100, 100]);
    expect(views.map(view => view.offset)).toEqual([0, 100, 200]);
    const containers = [...splitview.el.querySelectorAll<HTMLElement>('.split-view-view')];
    expect(containers.map(element => [element.style.top, element.style.height])).toEqual([
      ['0px', '100px'], ['100px', '100px'], ['200px', '100px'],
    ]);
    expect(splitview.sashes).toHaveLength(2);
    expect(splitview.sashes.map(sash => sash.el.style.top)).toEqual(['98px', '198px']);
  });

  test('a view added with a size keeps it and the others give way', () => {
    const views = [new TestView(), new TestView()];
    create(views, 400);
    const added = new TestView();
    splitview.addView(added, 100, 1);

    expect(added.size).toBe(100);
    expect(sum(sizes([...views, added]))).toBe(400);
  });

  test('views added before the first layout keep their shares once laid out', () => {
    splitview = new SplitView(container, { proportionalLayout: true });
    const views = [new TestView(), new TestView()];
    splitview.addView(views[0], 100);
    splitview.addView(views[1], 300);
    splitview.layout(800);

    expect(sizes(views)).toEqual([200, 600]);
  });
});

describe('limits', () => {
  test('views stay within their limits when the container has room', () => {
    const views = [new TestView(50, 80), new TestView(100, 200), new TestView(30)];
    create(views, 300);
    for (const size of [400, 150, 250, 1000]) {
      splitview.layout(size);
      views.forEach(view => {
        expect(view.size).toBeGreaterThanOrEqual(view.minimumSize);
        expect(view.size).toBeLessThanOrEqual(view.maximumSize);
      });
      if (size >= 180) {
        expect(sum(sizes(views))).toBe(size);
      }
    }
  });

  test('a container smaller than the minimums keeps finite, non-negative sizes and clips', () => {
    const views = [new TestView(100), new TestView(100), new TestView(100)];
    create(views, 300);
    for (const size of [120, 0, -50, Number.NaN, Number.POSITIVE_INFINITY, 300]) {
      splitview.layout(size);
      for (const view of views) {
        expect(Number.isFinite(view.size)).toBe(true);
        expect(view.size).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(view.offset)).toBe(true);
      }
    }
    splitview.layout(120);
    expect(sizes(views)).toEqual([100, 100, 100]);
    expect(splitview.contentSize).toBe(300);
  });

  test('a view that changes its limits is fitted again and the rest still tile', () => {
    const views = [new TestView(), new TestView()];
    create(views, 400);
    views[0].setLimits(300, Number.POSITIVE_INFINITY);

    expect(views[0].size).toBe(300);
    expect(sum(sizes(views))).toBe(400);
  });

  test('limits changed while laying out are fitted after the pass without recursing', () => {
    const views = [new TestView(), new TestView()];
    create(views, 400);
    let changes = 0;
    views[0].onLayout = view => {
      if (changes++ === 0) {
        view.setLimits(250, Number.POSITIVE_INFINITY);
      }
    };
    splitview.layout(500);

    expect(views[0].size).toBe(250);
    expect(sum(sizes(views))).toBe(500);
    expect(views[0].layoutCount).toBeLessThan(10);
    expect(views.map(view => view.maxLayoutDepth)).toEqual([1, 1]);
  });
});

describe('layout modes', () => {
  test('proportional layout keeps every share when the container changes size', () => {
    const views = [new TestView(), new TestView(), new TestView()];
    create(views, 600);
    splitview.resizeView(0, 300);
    expect(sizes(views)).toEqual([300, 200, 100]);

    splitview.layout(1200);
    expect(sizes(views)).toEqual([600, 400, 200]);
    splitview.layout(300);
    expect(sizes(views)).toEqual([150, 100, 50]);
  });

  test('shares survive a layout at size 0 and a change made meanwhile', () => {
    const views = [new TestView(), new TestView(), new TestView()];
    create(views, 600);
    splitview.resizeView(0, 300);
    const before = sizes(views);

    splitview.layout(0);
    views[1].setLimits(0, Number.POSITIVE_INFINITY);
    splitview.layout(600);
    expect(sizes(views)).toEqual(before);
  });

  test('without proportions the high-priority view takes the change before the others', () => {
    const views = [new TestView(0, Number.POSITIVE_INFINITY, LayoutPriority.Low), new TestView(0, Number.POSITIVE_INFINITY, LayoutPriority.High), new TestView()];
    create(views, 600, { proportionalLayout: false });
    expect(sizes(views)).toEqual([200, 200, 200]);

    splitview.layout(800);
    expect(sizes(views)).toEqual([200, 400, 200]);
    splitview.layout(500);
    expect(sizes(views)).toEqual([200, 100, 200]);
  });

  test('without proportions a low-priority view changes only once the others reach a limit', () => {
    const views = [new TestView(100, Number.POSITIVE_INFINITY, LayoutPriority.Low), new TestView(150, 300, LayoutPriority.High), new TestView(100)];
    create(views, 600, { proportionalLayout: false });
    splitview.layout(400);
    expect(sizes(views)).toEqual([150, 150, 100]);
    splitview.layout(1000);
    expect(views[1].size).toBe(300);
    expect(views[0].size).toBe(150);
    expect(views[2].size).toBe(550);
  });
});

describe('sizing', () => {
  test('Distribute makes the siblings equal', () => {
    const views = [new TestView(), new TestView()];
    create(views, 900);
    splitview.resizeView(0, 700);
    splitview.addView(new TestView(), Sizing.Distribute);
    expect(splitview.getViewSize(0)).toBe(300);
    expect(splitview.getViewSize(1)).toBe(300);
    expect(splitview.getViewSize(2)).toBe(300);
  });

  test('Split halves the reference view and leaves the rest alone', () => {
    const views = [new TestView(), new TestView()];
    create(views, 1000);
    splitview.resizeView(0, 400);
    splitview.addView(new TestView(), Sizing.Split(0), 1);
    expect([0, 1, 2].map(i => splitview.getViewSize(i))).toEqual([200, 200, 600]);
  });

  test('Auto distributes while the siblings are equal and splits once they are not', () => {
    const views = [new TestView(), new TestView()];
    create(views, 900);
    splitview.addView(new TestView(), Sizing.Auto(0), 1);
    expect([0, 1, 2].map(i => splitview.getViewSize(i))).toEqual([300, 300, 300]);

    splitview.resizeView(0, 500);
    splitview.addView(new TestView(), Sizing.Auto(0), 1);
    expect(splitview.getViewSize(0)).toBe(250);
    expect(splitview.getViewSize(1)).toBe(250);
  });
});

describe('visibility', () => {
  test('a hidden view gives its space to the others and gets its size back when shown', () => {
    const views = [new TestView(), new TestView(), new TestView()];
    create(views, 600);
    splitview.resizeView(1, 120);
    const before = sizes(views);

    splitview.setViewVisible(1, false);
    expect(views[1].size).toBe(0);
    expect(views[1].visible).toBe(false);
    expect(splitview.getViewCachedVisibleSize(1)).toBe(120);
    expect(views[0].size + views[2].size).toBe(600);
    expect(splitview.sashes[0].state).toBe(SashState.Disabled);

    splitview.setViewVisible(1, true);
    expect(views[1].size).toBe(120);
    expect(sizes(views)).toEqual(before);
    expect(sum(sizes(views))).toBe(600);
  });

  test('a view added invisible takes its cached size when shown', () => {
    const views = [new TestView(), new TestView()];
    create(views, 600);
    const hidden = new TestView();
    splitview.addView(hidden, Sizing.Invisible(200), 2);
    expect(splitview.isViewVisible(2)).toBe(false);
    expect(hidden.size).toBe(0);
    splitview.setViewVisible(2, true);
    expect(hidden.size).toBe(200);
    expect(sum(sizes([...views, hidden]))).toBe(600);
  });
});

describe('sash dragging', () => {
  test('dragging a sash moves the boundary by the pointer delta', () => {
    const views = [new TestView(), new TestView(), new TestView()];
    create(views, 600);
    drag(splitview.sashes[0], 200, 300, Orientation.VERTICAL);
    expect(sizes(views)).toEqual([300, 100, 200]);
  });

  test('a drag past the neighbour\'s minimum carries on into the next view', () => {
    const views = [new TestView(), new TestView(50), new TestView(50)];
    create(views, 600);
    drag(splitview.sashes[0], 200, 450, Orientation.VERTICAL);
    expect(sizes(views)).toEqual([450, 50, 100]);

    drag(splitview.sashes[0], 450, 900, Orientation.VERTICAL);
    expect(sizes(views)).toEqual([500, 50, 50]);
  });

  test('a horizontal split view follows the pointer along x', () => {
    const views = [new TestView(), new TestView()];
    create(views, 400, { orientation: Orientation.HORIZONTAL });
    drag(splitview.sashes[0], 200, [150, 100], Orientation.HORIZONTAL);
    expect(sizes(views)).toEqual([100, 300]);
  });

  test('adding a view during a drag ends the drag instead of resizing from stale sizes', () => {
    const views = [new TestView(), new TestView()];
    create(views, 600);
    const sash = splitview.sashes[0];
    sash.el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientY: 300, bubbles: true }));
    const added = new TestView();
    splitview.addView(added, 100, 0);
    const after = sizes([added, ...views]);
    sash.el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientY: 350, bubbles: true }));
    sash.el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientY: 350, bubbles: true }));

    expect(sizes([added, ...views])).toEqual(after);
    expect(sizes([added, ...views]).every(size => Number.isFinite(size))).toBe(true);
    expect(sum(sizes([added, ...views]))).toBe(600);
  });

  test('moves after the pointer is released do nothing', () => {
    const views = [new TestView(), new TestView()];
    create(views, 400);
    const sash = splitview.sashes[0];
    drag(sash, 200, 250, Orientation.VERTICAL);
    sash.el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientY: 350 }));
    expect(sizes(views)).toEqual([250, 150]);
  });

  test('a sash between two views that cannot change size is disabled and ignores the pointer', () => {
    const views = [new TestView(200, 200), new TestView(200, 200)];
    create(views, 400);
    const sash = splitview.sashes[0];
    expect(sash.state).toBe(SashState.Disabled);
    drag(sash, 200, 300, Orientation.VERTICAL);
    expect(sizes(views)).toEqual([200, 200]);
  });

  test('a sash next to a view at its minimum can only move one way', () => {
    const views = [new TestView(100), new TestView()];
    create(views, 400);
    splitview.resizeView(0, 100);
    expect(splitview.sashes[0].state).toBe(SashState.AtMinimum);
  });
});

describe('moving and removing', () => {
  test('moving a view keeps its element and size', () => {
    const views = [new TestView(), new TestView(), new TestView()];
    create(views, 600);
    splitview.resizeView(0, 300);
    const element = views[0].element;
    splitview.moveView(0, 2);

    const containers = [...splitview.el.querySelectorAll('.split-view-view')];
    expect(containers[2].firstChild).toBe(element);
    expect(views[0].element).toBe(element);
    expect(views[0].size).toBe(300);
    expect(views[0].offset).toBe(300);
    expect(views.map(view => view.offset)).toEqual([300, 0, 200]);
  });

  test('removing a view gives its space to the view before it', () => {
    const views = [new TestView(), new TestView(), new TestView()];
    create(views, 600);
    const removed = splitview.removeView(1);
    expect(removed).toBe(views[1]);
    expect(splitview.length).toBe(2);
    expect(splitview.getViewSize(0)).toBe(400);
    expect(splitview.getViewSize(1)).toBe(200);
    expect(splitview.sashes).toHaveLength(1);
  });

  test('dispose removes the elements and sashes and stops listening to the views', () => {
    const views = [new TestView(), new TestView()];
    create(views, 400);
    const sash = splitview.sashes[0];
    const layoutCount = views[0].layoutCount;
    splitview.dispose();

    expect(container.childElementCount).toBe(0);
    expect(sash.el.isConnected).toBe(false);
    views[0].setLimits(10, 20);
    expect(views[0].layoutCount).toBe(layoutCount);
    drag(sash, 200, 300, Orientation.VERTICAL);
    expect(views[0].layoutCount).toBe(layoutCount);
    sash.el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2, clientY: 200 }));
    expect(sash.el.classList.contains('active')).toBe(false);
    expect(document.body.classList.contains('monaco-sash-dragging-horizontal')).toBe(false);
  });
});
