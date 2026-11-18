import { expect } from 'vitest';
import { $ } from '../../../../browser/dom.js';
import { isGridBranchNode, orthogonal, Orientation } from '../../../../browser/ui/grid/grid.js';
import type { Grid, GridNode, ISerializableView, IViewSize, LayoutPriority } from '../../../../browser/ui/grid/grid.js';
import { Emitter } from '../../../../common/event.js';
import type { Event } from '../../../../common/event.js';
import type { IDisposable } from '../../../../common/lifecycle.js';

export interface ITestViewOptions {
  readonly minimumWidth?: number;
  readonly maximumWidth?: number;
  readonly minimumHeight?: number;
  readonly maximumHeight?: number;
  readonly priority?: LayoutPriority;
}

/** A grid view with fixed limits that records every layout it receives. */
export class TestView implements ISerializableView {
  readonly element = $('.test-view');
  private readonly _onDidChange = new Emitter<IViewSize | undefined>();
  private subscriptions = 0;
  minimumWidth: number;
  maximumWidth: number;
  minimumHeight: number;
  maximumHeight: number;
  readonly priority: LayoutPriority | undefined;
  readonly layouts: { width: number; height: number; top: number; left: number }[] = [];
  disposed = false;

  readonly onDidChange: Event<IViewSize | undefined> = (listener, thisArgs, disposables) => {
    this.subscriptions++;
    const subscription = this._onDidChange.event(listener, thisArgs);
    let done = false;
    const result: IDisposable = {
      dispose: () => {
        if (!done) {
          done = true;
          this.subscriptions--;
          subscription.dispose();
        }
      },
    };
    if (Array.isArray(disposables)) {
      disposables.push(result);
    } else {
      disposables?.add(result);
    }
    return result;
  };

  constructor(readonly id: string, options: ITestViewOptions = {}) {
    this.minimumWidth = options.minimumWidth ?? 0;
    this.maximumWidth = options.maximumWidth ?? Number.POSITIVE_INFINITY;
    this.minimumHeight = options.minimumHeight ?? 0;
    this.maximumHeight = options.maximumHeight ?? Number.POSITIVE_INFINITY;
    this.priority = options.priority;
    this.element.dataset.id = id;
  }

  /** Listeners the grid still holds on this view. */
  get listenerCount(): number {
    return this.subscriptions;
  }

  get lastLayout(): { width: number; height: number; top: number; left: number } | undefined {
    return this.layouts[this.layouts.length - 1];
  }

  get width(): number {
    return this.lastLayout?.width ?? 0;
  }

  get height(): number {
    return this.lastLayout?.height ?? 0;
  }

  layout(width: number, height: number, top: number, left: number): void {
    this.layouts.push({ width, height, top, left });
  }

  setLimits(limits: ITestViewOptions): void {
    Object.assign(this, limits);
    this._onDidChange.fire(undefined);
  }

  requestSize(size: IViewSize): void {
    this._onDidChange.fire(size);
  }

  toJSON(): object {
    return { id: this.id };
  }

  dispose(): void {
    this.disposed = true;
    this._onDidChange.dispose();
  }
}

/** The tree's shape: a leaf is its view's id, a branch an array of its children. */
export type Shape = string | Shape[];

export function shapeOf(grid: Grid<TestView>): Shape {
  const walk = (node: GridNode<TestView>): Shape => isGridBranchNode(node) ? node.children.map(walk) : node.view.id;
  return walk(grid.getViews());
}

const tolerance = 1e-6;

/**
 * Checks what every grid operation must leave behind:
 * - no branch holds a single child, except a root holding one view;
 * - along each branch's axis its visible children tile it exactly (or overflow it, when the
 *   limits cannot fit), and hidden ones take nothing;
 * - across the axis every visible child spans the branch;
 * - every visible view is within its limits, and its last layout is its box;
 * - a branch whose children are all hidden is hidden itself.
 */
export function expectGridInvariants(grid: Grid<TestView>, options: { readonly limitsFit?: boolean } = {}): void {
  const root = grid.getViews();
  expect(root.children.length, 'the root holds at least one node').toBeGreaterThan(0);
  if (root.children.length === 1) {
    expect(isGridBranchNode(root.children[0]), 'a root with one child holds a view, not a branch').toBe(false);
  }

  const visit = (node: GridNode<TestView>, orientation: Orientation, isRoot: boolean, path: string): void => {
    if (!isGridBranchNode(node)) {
      const { view, box, cachedVisibleSize } = node;
      if (cachedVisibleSize === undefined) {
        expect(view.lastLayout, `${path} (${view.id}) was laid out at its box`).toEqual(box);
        if (options.limitsFit !== false) {
          expect(box.width, `${path} width within limits`).toBeGreaterThanOrEqual(view.minimumWidth - tolerance);
          expect(box.width, `${path} width within limits`).toBeLessThanOrEqual(view.maximumWidth + tolerance);
          expect(box.height, `${path} height within limits`).toBeGreaterThanOrEqual(view.minimumHeight - tolerance);
          expect(box.height, `${path} height within limits`).toBeLessThanOrEqual(view.maximumHeight + tolerance);
        }
      }
      expect(Number.isFinite(box.width) && box.width >= 0, `${path} width is finite and not negative`).toBe(true);
      expect(Number.isFinite(box.height) && box.height >= 0, `${path} height is finite and not negative`).toBe(true);
      return;
    }

    if (!isRoot) {
      expect(node.children.length, `${path} is a branch of at least two`).toBeGreaterThan(1);
    }
    const horizontal = orientation === Orientation.HORIZONTAL;
    const start = horizontal ? node.box.left : node.box.top;
    const extent = horizontal ? node.box.width : node.box.height;
    const crossStart = horizontal ? node.box.top : node.box.left;
    const crossExtent = horizontal ? node.box.height : node.box.width;

    const visible = node.children.filter(child => child.cachedVisibleSize === undefined);
    if (node.cachedVisibleSize === undefined && visible.length > 0) {
      let offset = start;
      for (const child of visible) {
        const childStart = horizontal ? child.box.left : child.box.top;
        const childExtent = horizontal ? child.box.width : child.box.height;
        expect(childStart, `${path}: children tile the branch without gaps`).toBeCloseTo(offset, 6);
        offset += childExtent;
        expect(horizontal ? child.box.top : child.box.left, `${path}: children span the branch`).toBeCloseTo(crossStart, 6);
        expect(horizontal ? child.box.height : child.box.width, `${path}: children span the branch`).toBeCloseTo(crossExtent, 6);
      }
      if (options.limitsFit === false) {
        // Views that cannot fit overflow the branch and are clipped; they never leave a gap.
        expect(offset - start, `${path}: children cover the branch`).toBeGreaterThanOrEqual(extent - tolerance);
      } else {
        expect(offset - start, `${path}: children sizes add up to the branch`).toBeCloseTo(extent, 6);
      }
    }
    for (const child of node.children) {
      if (child.cachedVisibleSize !== undefined) {
        expect(horizontal ? child.box.width : child.box.height, `${path}: a hidden child takes no space`).toBe(0);
      }
    }
    if (!isRoot && node.children.length > 0 && visible.length === 0) {
      expect(node.cachedVisibleSize, `${path}: a branch whose children are all hidden is hidden`).not.toBeUndefined();
    }
    node.children.forEach((child, index) => visit(child, orthogonal(orientation), false, `${path}.${index}`));
  };

  visit(root, grid.orientation, true, 'root');
}
