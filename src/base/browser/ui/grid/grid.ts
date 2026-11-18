import { Disposable } from '../../../common/lifecycle.js';
import type { Event } from '../../../common/event.js';
import { GridView, isGridBranchNode, orthogonal, Orientation, Sizing as GridViewSizing, tail } from './gridview.js';
import type {
  Box, GridBranchNode, GridNode, IGridViewOptions, ISerializableView, ISerializedGridView, IView, IViewDeserializer, IViewSize,
} from './gridview.js';

export { isGridBranchNode, LayoutPriority, orthogonal, Orientation } from './gridview.js';
export type {
  Box, GridBranchNode, GridLeafNode, GridNode, ISerializableView, ISerializedBranchNode, ISerializedLeafNode, ISerializedNode,
  IView, IViewDeserializer, IViewSize,
} from './gridview.js';

export enum Direction {
  Up,
  Down,
  Left,
  Right,
}

export function oppositeDirection(direction: Direction): Direction {
  switch (direction) {
    case Direction.Up: return Direction.Down;
    case Direction.Down: return Direction.Up;
    case Direction.Left: return Direction.Right;
    case Direction.Right: return Direction.Left;
  }
}

function getDirectionOrientation(direction: Direction): Orientation {
  return direction === Direction.Up || direction === Direction.Down ? Orientation.VERTICAL : Orientation.HORIZONTAL;
}

/** The orientation of the branch that holds the node at `location`: it alternates with depth. */
export function getLocationOrientation(rootOrientation: Orientation, location: readonly number[]): Orientation {
  return location.length % 2 === 0 ? orthogonal(rootOrientation) : rootOrientation;
}

/**
 * Where a view goes to sit beside the view at `location` in `direction`: a sibling when the
 * direction runs along the parent's axis, or a split of that view when it runs across it.
 */
export function getRelativeLocation(rootOrientation: Orientation, location: readonly number[], direction: Direction): number[] {
  const orientation = getLocationOrientation(rootOrientation, location);
  const after = direction === Direction.Right || direction === Direction.Down;
  if (orientation === getDirectionOrientation(direction)) {
    const index = location[location.length - 1];
    return [...location.slice(0, -1), after ? index + 1 : index];
  }
  return [...location, after ? 1 : 0];
}

export interface DistributeSizing { readonly type: 'distribute' }
export interface SplitSizing { readonly type: 'split' }
export interface AutoSizing { readonly type: 'auto' }
export interface InvisibleSizing { readonly type: 'invisible'; readonly cachedVisibleSize: number }

/** How a view added beside a reference view gets its size. */
export type Sizing = DistributeSizing | SplitSizing | AutoSizing | InvisibleSizing;

export namespace Sizing {
  /** The new view's siblings all end with the same size. */
  export const Distribute: DistributeSizing = { type: 'distribute' };
  /** The new view takes half of the reference view. */
  export const Split: SplitSizing = { type: 'split' };
  /** `Distribute` while the siblings are equal, otherwise `Split`. */
  export const Auto: AutoSizing = { type: 'auto' };
  /** The view starts hidden and takes `cachedVisibleSize` once it is shown. */
  export function Invisible(cachedVisibleSize: number): InvisibleSizing {
    return { type: 'invisible', cachedVisibleSize };
  }
}

export interface IGridOptions extends IGridViewOptions {}

/**
 * The view-based face of {@link GridView}: views are placed relative to each other by
 * direction, and the grid keeps their locations.
 */
export class Grid<T extends IView = IView> extends Disposable {
  protected readonly gridview: GridView;
  private readonly views = new Set<T>();

  /**
   * Starts a grid holding one view, or wraps a grid view built elsewhere (deserialization),
   * taking in the views it holds.
   */
  constructor(view: T | GridView, options: IGridOptions = {}) {
    super();
    if (view instanceof GridView) {
      this.gridview = view;
      for (const leaf of leaves(this.gridview.getView() as GridBranchNode<T>)) {
        this.views.add(leaf);
      }
    } else {
      this.gridview = new GridView(options);
      this.gridview.addView(view, GridViewSizing.Distribute, [0]);
      this.views.add(view);
    }
    this._register(this.gridview);
  }

  get orientation(): Orientation {
    return this.gridview.orientation;
  }

  set orientation(orientation: Orientation) {
    this.gridview.orientation = orientation;
  }

  get width(): number {
    return this.gridview.width;
  }

  get height(): number {
    return this.gridview.height;
  }

  get minimumWidth(): number {
    return this.gridview.minimumWidth;
  }

  get minimumHeight(): number {
    return this.gridview.minimumHeight;
  }

  get maximumWidth(): number {
    return this.gridview.maximumWidth;
  }

  get maximumHeight(): number {
    return this.gridview.maximumHeight;
  }

  /** Fires when the grid's limits change. */
  get onDidChange(): Event<IViewSize | undefined> {
    return this.gridview.onDidChange;
  }

  get element(): HTMLElement {
    return this.gridview.element;
  }

  layout(width: number, height: number, top = 0, left = 0): void {
    this.gridview.layout(width, height, top, left);
  }

  hasView(view: T): boolean {
    return this.views.has(view);
  }

  /** Adds `newView` beside `referenceView` in `direction`. */
  addView(newView: T, size: number | Sizing, referenceView: T, direction: Direction): void {
    if (this.views.has(newView)) {
      throw new Error('The grid already holds this view.');
    }
    const orientation = getDirectionOrientation(direction);
    if (this.views.size === 1 && this.orientation !== orientation) {
      // With one view, turning the root keeps the tree flat instead of nesting a branch.
      this.orientation = orientation;
    }
    const referenceLocation = this.getViewLocation(referenceView);
    const location = getRelativeLocation(this.gridview.orientation, referenceLocation, direction);
    this.gridview.addView(newView, this.toGridViewSizing(size, referenceLocation), location);
    this.views.add(newView);
  }

  /** Adds `newView` at an index path. */
  addViewAt(newView: T, size: number | DistributeSizing | InvisibleSizing, location: readonly number[]): void {
    if (this.views.has(newView)) {
      throw new Error('The grid already holds this view.');
    }
    this.gridview.addView(newView, size, location);
    this.views.add(newView);
  }

  removeView(view: T, sizing?: Sizing): void {
    if (this.views.size === 1) {
      throw new Error('The last view of a grid cannot be removed.');
    }
    const location = this.getViewLocation(view);
    this.gridview.removeView(location, sizing?.type === 'distribute' ? GridViewSizing.Distribute : undefined);
    this.views.delete(view);
  }

  /**
   * Moves `view` beside `referenceView` in `direction`. The view keeps its element, and what
   * has focus inside it keeps focus.
   */
  moveView(view: T, sizing: number | Sizing, referenceView: T, direction: Direction): void {
    if (view === referenceView) {
      return;
    }
    const sourceLocation = this.getViewLocation(view);
    const [sourceParentLocation, from] = tail(sourceLocation);
    const referenceLocation = this.getViewLocation(referenceView);
    const targetLocation = getRelativeLocation(this.gridview.orientation, referenceLocation, direction);
    const [targetParentLocation, to] = tail(targetLocation);

    this.keepingFocus(view, () => {
      if (sameLocation(sourceParentLocation, targetParentLocation)) {
        this.gridview.moveView(sourceParentLocation, from, to);
      } else {
        this.removeView(view);
        this.addView(view, sizing, referenceView, direction);
      }
    });
  }

  /** Moves `view` to an index path, read after the view has left its current place. */
  moveViewTo(view: T, location: readonly number[]): void {
    const sourceLocation = this.getViewLocation(view);
    const [sourceParentLocation, from] = tail(sourceLocation);
    const [targetParentLocation, to] = tail(location);

    this.keepingFocus(view, () => {
      if (sameLocation(sourceParentLocation, targetParentLocation)) {
        // `to` counts the siblings without the view; GridView.moveView takes the gap before a sibling.
        this.gridview.moveView(sourceParentLocation, from, to >= from ? to + 1 : to);
        return;
      }
      const size = this.gridview.getViewSize(sourceLocation);
      const orientation = getLocationOrientation(this.gridview.orientation, sourceLocation);
      const cachedVisibleSize = this.gridview.getViewCachedVisibleSize(sourceLocation);
      const sizing = cachedVisibleSize === undefined
        ? (orientation === Orientation.HORIZONTAL ? size.width : size.height)
        : GridViewSizing.Invisible(cachedVisibleSize);
      // The target is read after the view has left, so it is checked against that shape first:
      // adding the view back after a removal that collapsed the root would turn the grid.
      assertInsertLocation(shapeWithout(this.getViews(), sourceLocation), location);
      this.gridview.removeView(sourceLocation);
      this.gridview.addView(view, sizing, location);
    });
  }

  resizeView(view: T, size: Partial<IViewSize>): void {
    this.gridview.resizeView(this.getViewLocation(view), size);
  }

  /** The size of `view`, or of the whole grid. */
  getViewSize(view?: T): IViewSize {
    return view ? this.gridview.getViewSize(this.getViewLocation(view)) : this.gridview.getViewSize();
  }

  getViewCachedVisibleSize(view: T): number | undefined {
    return this.gridview.getViewCachedVisibleSize(this.getViewLocation(view));
  }

  distributeViewSizes(): void {
    this.gridview.distributeViewSizes();
  }

  isViewVisible(view: T): boolean {
    return this.gridview.isViewVisible(this.getViewLocation(view));
  }

  /** Hiding gives the view's space to its siblings; showing gives back the size it had. */
  setViewVisible(view: T, visible: boolean): void {
    this.gridview.setViewVisible(this.getViewLocation(view), visible);
  }

  getViews(): GridBranchNode<T> {
    return this.gridview.getView() as GridBranchNode<T>;
  }

  getViewLocation(view: T): number[] {
    const location = this.views.has(view) ? this.gridview.getViewLocation(view) : undefined;
    if (!location) {
      throw new Error('The grid does not hold this view.');
    }
    return location;
  }

  /**
   * The visible views that touch `view`'s edge in `direction`. With `wrap`, a view on the
   * grid's edge looks at the views on the opposite edge instead.
   */
  getNeighborViews(view: T, direction: Direction, wrap = false): T[] {
    const root = this.getViews();
    const all = leafNodes(root).filter(leaf => leaf.cachedVisibleSize === undefined && leaf.box.width > 0 && leaf.box.height > 0);
    const self = all.find(leaf => leaf.view === view);
    if (!self) {
      return [];
    }
    const box = self.box;
    const touching = (edge: number) => all.filter(leaf => leaf.view !== view && touches(box, leaf.box, direction, edge));
    let result = touching(edgeOf(box, direction));
    if (result.length === 0 && wrap) {
      const grid: Box = { top: root.box.top, left: root.box.left, width: this.width, height: this.height };
      result = touching(edgeOf(grid, oppositeDirection(direction)));
    }
    return result.map(leaf => leaf.view);
  }

  private toGridViewSizing(size: number | Sizing, referenceLocation: readonly number[]): number | GridViewSizing {
    if (typeof size === 'number') {
      return size;
    }
    const index = referenceLocation[referenceLocation.length - 1];
    switch (size.type) {
      case 'split': return GridViewSizing.Split(index);
      case 'auto': return GridViewSizing.Auto(index);
      case 'distribute': return GridViewSizing.Distribute;
      case 'invisible': return GridViewSizing.Invisible(size.cachedVisibleSize);
    }
  }

  private keepingFocus(view: T, move: () => void): void {
    const active = view.element.ownerDocument.activeElement;
    const hadFocus = active instanceof HTMLElement && view.element.contains(active);
    try {
      move();
    } finally {
      if (hadFocus && active.isConnected && view.element.ownerDocument.activeElement !== active) {
        active.focus({ preventScroll: true });
      }
    }
  }
}

export interface ISerializedGrid extends ISerializedGridView {}

export interface ISerializableGridOptions extends IGridOptions {}

function serializeNode<T extends ISerializableView>(node: GridNode<T>, orientation: Orientation): object {
  // `orientation` is the node's own; its size runs along its parent's axis, the other one.
  const visibleSize = orientation === Orientation.VERTICAL ? node.box.width : node.box.height;
  const size = node.cachedVisibleSize ?? visibleSize;
  if (isGridBranchNode(node)) {
    return { type: 'branch', data: node.children.map(child => serializeNode(child, orthogonal(orientation))), size };
  }
  const result: { type: 'leaf'; data: object; size: number; visible?: boolean } = { type: 'leaf', data: node.view.toJSON(), size };
  if (node.cachedVisibleSize !== undefined) {
    result.visible = false;
  }
  return result;
}

/** A grid whose views can be written to JSON and read back: the stored layout format. */
export class SerializableGrid<T extends ISerializableView> extends Grid<T> {
  /**
   * Builds a grid from stored data. The data's sizes are only a start: the first `layout` fits
   * them to the container and the views' limits. Anything that is not a grid throws one error,
   * so the caller can fall back to a default layout.
   */
  static deserialize<T extends ISerializableView>(json: unknown, deserializer: IViewDeserializer<T>, options: ISerializableGridOptions = {}): SerializableGrid<T> {
    const gridview = GridView.deserialize(json, deserializer, options);
    return new SerializableGrid<T>(gridview, options);
  }

  serialize(): ISerializedGrid {
    return {
      root: serializeNode(this.getViews(), this.orientation) as ISerializedGrid['root'],
      orientation: this.orientation,
      width: this.width,
      height: this.height,
    };
  }
}

/** A grid's tree with only its shape: a leaf, or a branch's children. */
type Shape = 'leaf' | Shape[];

/** The shape `GridView.removeView(location)` leaves behind, collapsing branches as it does. */
function shapeWithout(root: GridBranchNode<IView>, location: readonly number[]): Shape[] {
  const toShape = (node: GridNode<IView>): Shape => isGridBranchNode(node) ? node.children.map(toShape) : 'leaf';
  const rootShape = root.children.map(toShape);
  const [rest, index] = tail(location);
  const branches: Shape[][] = [rootShape];
  for (const step of rest) {
    branches.push(branches[branches.length - 1][step] as Shape[]);
  }
  const parent = branches[branches.length - 1];
  parent.splice(index, 1);
  if (parent.length !== 1) {
    return rootShape;
  }
  const [sibling] = parent;
  if (rest.length === 0) {
    // The root keeps one view, or the single branch left becomes the root.
    return sibling === 'leaf' ? rootShape : sibling;
  }
  const grandParent = branches[branches.length - 2];
  grandParent.splice(rest[rest.length - 1], 1, ...(sibling === 'leaf' ? [sibling] : sibling));
  return rootShape;
}

/** Throws as `GridView.addView` would for `location` in a grid of this shape, before anything moves. */
function assertInsertLocation(root: Shape[], location: readonly number[]): void {
  const [rest, index] = tail(location);
  let node: Shape = root;
  for (const step of rest) {
    if (node === 'leaf' || !Number.isInteger(step) || step < 0 || step >= node.length) {
      throw new Error(`Invalid grid location ${JSON.stringify(location)}.`);
    }
    node = node[step];
  }
  const valid = node === 'leaf'
    ? index === 0 || index === 1
    : Number.isInteger(index) && index >= 0 && index <= node.length;
  if (!valid) {
    throw new Error(`Invalid grid location ${JSON.stringify(location)}.`);
  }
}

function sameLocation(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function leafNodes<T extends IView>(node: GridNode<T>): { view: T; box: Box; cachedVisibleSize: number | undefined }[] {
  return isGridBranchNode(node) ? node.children.flatMap(child => leafNodes(child)) : [node];
}

function leaves<T extends IView>(node: GridNode<T>): T[] {
  return leafNodes(node).map(leaf => leaf.view);
}

function edgeOf(box: Box, direction: Direction): number {
  switch (direction) {
    case Direction.Up: return box.top;
    case Direction.Down: return box.top + box.height;
    case Direction.Left: return box.left;
    case Direction.Right: return box.left + box.width;
  }
}

/** Whether `other` lies against `edge` on the `direction` side of `box`, sharing some length. */
function touches(box: Box, other: Box, direction: Direction, edge: number): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  switch (direction) {
    case Direction.Up:
      return near(other.top + other.height, edge) && overlap(box.left, box.width, other.left, other.width);
    case Direction.Down:
      return near(other.top, edge) && overlap(box.left, box.width, other.left, other.width);
    case Direction.Left:
      return near(other.left + other.width, edge) && overlap(box.top, box.height, other.top, other.height);
    case Direction.Right:
      return near(other.left, edge) && overlap(box.top, box.height, other.top, other.height);
  }
}

function overlap(start: number, length: number, otherStart: number, otherLength: number): boolean {
  return Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart) > 0;
}
