import { $ } from '../../dom.js';
import { Emitter, Event } from '../../../common/event.js';
import { Disposable, DisposableStore } from '../../../common/lifecycle.js';
import type { IDisposable } from '../../../common/lifecycle.js';
import { LayoutPriority, Orientation, Sizing, SplitView } from '../splitview/splitview.js';
import type { DistributeSizing, IView as ISplitViewView } from '../splitview/splitview.js';
import './gridview.css';

export { LayoutPriority, Orientation, Sizing } from '../splitview/splitview.js';

export interface IViewSize {
  readonly width: number;
  readonly height: number;
}

/** A view placed in a grid. Its limits are in pixels; `Number.POSITIVE_INFINITY` means no maximum. */
export interface IView {
  readonly element: HTMLElement;
  readonly minimumWidth: number;
  readonly maximumWidth: number;
  readonly minimumHeight: number;
  readonly maximumHeight: number;
  /** Fires when the limits changed (`undefined`) or when the view asks for a size of its own. */
  readonly onDidChange: Event<IViewSize | undefined>;
  readonly priority?: LayoutPriority;
  /** `false` keeps this view's size when a proportional grid changes size. */
  readonly proportionalLayout?: boolean;
  /** `top` and `left` are relative to the grid's own `layout(width, height, top, left)` origin. */
  layout(width: number, height: number, top: number, left: number): void;
  setVisible?(visible: boolean): void;
}

export interface ISerializableView extends IView {
  toJSON(): object;
}

export interface IViewDeserializer<T extends ISerializableView> {
  fromJSON(json: unknown): T;
}

export interface ISerializedLeafNode {
  readonly type: 'leaf';
  readonly data: unknown;
  /** Along the parent's axis. For a hidden view, the size it gets back when it is shown. */
  readonly size: number;
  readonly visible?: boolean;
}

export interface ISerializedBranchNode {
  readonly type: 'branch';
  readonly data: readonly ISerializedNode[];
  /** Along the parent's axis. */
  readonly size: number;
}

export type ISerializedNode = ISerializedLeafNode | ISerializedBranchNode;

export interface ISerializedGridView {
  readonly root: ISerializedNode;
  readonly orientation: Orientation;
  readonly width: number;
  readonly height: number;
}

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface GridLeafNode<T extends IView = IView> {
  readonly view: T;
  readonly box: Box;
  /** Set while the view is hidden: the size along its parent's axis it gets back when shown. */
  readonly cachedVisibleSize: number | undefined;
}

export interface GridBranchNode<T extends IView = IView> {
  readonly children: GridNode<T>[];
  readonly box: Box;
  /** Set while every view inside is hidden. */
  readonly cachedVisibleSize: number | undefined;
}

export type GridNode<T extends IView = IView> = GridLeafNode<T> | GridBranchNode<T>;

export function isGridBranchNode<T extends IView>(node: GridNode<T>): node is GridBranchNode<T> {
  return 'children' in node;
}

export interface IGridViewOptions {
  /** `true` (the default) keeps every view's share when the grid changes size. */
  readonly proportionalLayout?: boolean;
}

export function orthogonal(orientation: Orientation): Orientation {
  return orientation === Orientation.VERTICAL ? Orientation.HORIZONTAL : Orientation.VERTICAL;
}

/** What a branch hands its children when it lays them out, along with their size and offset. */
interface ILayoutContext {
  /** The children's extent across the branch's axis. */
  readonly orthogonalSize: number;
  /** Where the branch starts along its own axis, from the grid's origin. */
  readonly absoluteOffset: number;
  /** Where the branch starts across its axis, from the grid's origin. */
  readonly absoluteOrthogonalOffset: number;
}

/** Shared by the nodes of one grid: while a change rebuilds part of the tree, limits stay quiet. */
interface IGridContext {
  batching: number;
}

type Node = BranchNode | LeafNode;

/**
 * Every node has an `orientation` orthogonal to its parent's. Its `size` runs along that
 * orientation and its `orthogonalSize` along the parent's axis, the one the parent's split
 * view sizes it on.
 */
abstract class AbstractNode {
  protected _size = 0;
  protected _orthogonalSize = 0;
  protected absoluteOffset = 0;
  protected absoluteOrthogonalOffset = 0;

  constructor(readonly orientation: Orientation, size: number, orthogonalSize: number) {
    this._size = size;
    this._orthogonalSize = orthogonalSize;
  }

  get size(): number {
    return this._size;
  }

  get orthogonalSize(): number {
    return this._orthogonalSize;
  }

  get width(): number {
    return this.orientation === Orientation.HORIZONTAL ? this._size : this._orthogonalSize;
  }

  get height(): number {
    return this.orientation === Orientation.HORIZONTAL ? this._orthogonalSize : this._size;
  }

  get top(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.absoluteOffset : this.absoluteOrthogonalOffset;
  }

  get left(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.absoluteOrthogonalOffset : this.absoluteOffset;
  }

  get box(): Box {
    return { top: this.top, left: this.left, width: this.width, height: this.height };
  }

  protected updateGeometry(size: number, offset: number, context: ILayoutContext | undefined): void {
    this._orthogonalSize = size;
    this._size = context?.orthogonalSize ?? this._size;
    this.absoluteOffset = (context?.absoluteOffset ?? 0) + offset;
    this.absoluteOrthogonalOffset = context?.absoluteOrthogonalOffset ?? 0;
  }
}

class LeafNode extends AbstractNode implements ISplitViewView<ILayoutContext>, IDisposable {
  readonly onDidChange: Event<number | undefined>;

  constructor(readonly view: IView, orientation: Orientation, size = 0, orthogonalSize = 0) {
    super(orientation, size, orthogonalSize);
    // The parent's split view only cares about the size along its own axis.
    this.onDidChange = Event.map(view.onDidChange, change => change && (
      this.orientation === Orientation.HORIZONTAL ? change.height : change.width
    ));
  }

  get element(): HTMLElement {
    return this.view.element;
  }

  get minimumSize(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.view.minimumHeight : this.view.minimumWidth;
  }

  get maximumSize(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.view.maximumHeight : this.view.maximumWidth;
  }

  get minimumOrthogonalSize(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.view.minimumWidth : this.view.minimumHeight;
  }

  get maximumOrthogonalSize(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.view.maximumWidth : this.view.maximumHeight;
  }

  get priority(): LayoutPriority | undefined {
    return this.view.priority;
  }

  get proportionalLayout(): boolean {
    return this.view.proportionalLayout ?? true;
  }

  layout(size: number, offset: number, context: ILayoutContext | undefined): void {
    this.updateGeometry(size, offset, context);
    this.view.layout(this.width, this.height, this.top, this.left);
  }

  setVisible(visible: boolean): void {
    this.view.setVisible?.(visible);
  }

  dispose(): void {
    // The view belongs to whoever added it.
  }
}

interface IChildDescriptor {
  readonly node: Node;
  readonly size: number;
  readonly visible: boolean;
}

class BranchNode extends AbstractNode implements ISplitViewView<ILayoutContext>, IDisposable {
  readonly element: HTMLElement;
  readonly children: Node[] = [];
  private readonly splitview: SplitView<ILayoutContext, Node>;
  private readonly childListeners = new Map<Node, IDisposable>();
  private readonly disposables = new DisposableStore();
  private allChildrenHidden = false;
  private lastLimits = '';

  private readonly _onDidChange = this.disposables.add(new Emitter<number | undefined>());
  readonly onDidChange: Event<number | undefined> = this._onDidChange.event;

  /** Fires `false` when the last visible child is hidden and `true` when one shows again. */
  private readonly _onDidVisibilityChange = this.disposables.add(new Emitter<boolean>());
  readonly onDidVisibilityChange: Event<boolean> = this._onDidVisibilityChange.event;

  constructor(
    orientation: Orientation,
    readonly splitviewProportionalLayout: boolean,
    private readonly context: IGridContext,
    size = 0,
    orthogonalSize = 0,
    childDescriptors?: readonly IChildDescriptor[],
  ) {
    super(orientation, size, orthogonalSize);
    this.element = $('.monaco-grid-branch-node');
    this.splitview = new SplitView<ILayoutContext, Node>(this.element, {
      orientation,
      proportionalLayout: splitviewProportionalLayout,
      getSashOrthogonalSize: () => this._orthogonalSize,
      descriptor: childDescriptors && {
        views: childDescriptors.map(({ node, size, visible }) => ({ view: node, size, visible })),
      },
    });
    this.disposables.add(this.splitview);
    for (const { node } of childDescriptors ?? []) {
      this.children.push(node);
      this.listenTo(node);
    }
    this.allChildrenHidden = this.computeAllChildrenHidden();
    this.lastLimits = this.limitsKey();
  }

  get minimumSize(): number {
    return this.reduceVisible((min, child) => Math.max(min, child.minimumOrthogonalSize), 0);
  }

  get maximumSize(): number {
    return this.reduceVisible((max, child) => Math.min(max, child.maximumOrthogonalSize), Number.POSITIVE_INFINITY);
  }

  get minimumOrthogonalSize(): number {
    return this.splitview.minimumSize;
  }

  get maximumOrthogonalSize(): number {
    return this.splitview.maximumSize;
  }

  get minimumWidth(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.minimumOrthogonalSize : this.minimumSize;
  }

  get maximumWidth(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.maximumOrthogonalSize : this.maximumSize;
  }

  get minimumHeight(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.minimumSize : this.minimumOrthogonalSize;
  }

  get maximumHeight(): number {
    return this.orientation === Orientation.HORIZONTAL ? this.maximumSize : this.maximumOrthogonalSize;
  }

  /** A branch holding a high-priority view is high priority itself, so the change reaches that view. */
  get priority(): LayoutPriority {
    const priorities = this.children.map(child => child.priority ?? LayoutPriority.Normal);
    if (priorities.includes(LayoutPriority.High)) {
      return LayoutPriority.High;
    }
    if (priorities.includes(LayoutPriority.Low)) {
      return LayoutPriority.Low;
    }
    return LayoutPriority.Normal;
  }

  get proportionalLayout(): boolean {
    return this.children.every(child => child.proportionalLayout);
  }

  get isHidden(): boolean {
    return this.allChildrenHidden;
  }

  addChild(node: Node, size: number | Sizing, index: number, skipLayout = false): void {
    this.splitview.addView(node, size, index, skipLayout);
    this.children.splice(index, 0, node);
    this.listenTo(node);
    this.onChildrenChanged();
  }

  /** Removes the child at `index` and returns it; the caller owns it from then on. */
  removeChild(index: number, sizing?: Sizing, skipLayout = false): Node {
    this.splitview.removeView(index, sizing, skipLayout);
    const [node] = this.children.splice(index, 1);
    this.childListeners.get(node)?.dispose();
    this.childListeners.delete(node);
    this.onChildrenChanged();
    return node;
  }

  /** Moves the child at `from` to the gap before the child now at `to` (`to` may be the length). */
  moveChild(from: number, to: number): void {
    if (from < to) {
      to -= 1;
    }
    if (from === to) {
      return;
    }
    this.splitview.moveView(from, to);
    const [node] = this.children.splice(from, 1);
    this.children.splice(to, 0, node);
  }

  resizeChild(index: number, size: number): void {
    this.splitview.resizeView(index, size);
  }

  getChildSize(index: number): number {
    return this.splitview.getViewSize(index);
  }

  isChildVisible(index: number): boolean {
    return this.splitview.isViewVisible(index);
  }

  getChildCachedVisibleSize(index: number): number | undefined {
    return this.splitview.getViewCachedVisibleSize(index);
  }

  /** The child's size along this branch's axis, whether it is shown or hidden. */
  getChildVisibleSize(index: number): number {
    return this.getChildCachedVisibleSize(index) ?? this.getChildSize(index);
  }

  setChildVisible(index: number, visible: boolean): void {
    if (this.splitview.isViewVisible(index) === visible) {
      return;
    }
    this.splitview.setViewVisible(index, visible);
    this.onChildrenChanged();
  }

  distributeViewSizes(recursive = false): void {
    this.splitview.distributeViewSizes();
    if (recursive) {
      for (const child of this.children) {
        if (child instanceof BranchNode) {
          child.distributeViewSizes(true);
        }
      }
    }
  }

  layout(size: number, offset: number, context: ILayoutContext | undefined): void {
    this.updateGeometry(size, offset, context);
    this.element.style.width = `${this.width}px`;
    this.element.style.height = `${this.height}px`;
    this.splitview.layout(this._size, {
      orthogonalSize: this._orthogonalSize,
      absoluteOffset: this.absoluteOrthogonalOffset,
      absoluteOrthogonalOffset: this.absoluteOffset,
    });
  }

  setVisible(visible: boolean): void {
    this.children.forEach((child, index) => {
      if (this.splitview.isViewVisible(index)) {
        child.setVisible(visible);
      }
    });
  }

  /**
   * Re-reads visibility and limits after a change that ran while the grid was batching. A
   * branch whose views all ended hidden is hidden in its parent, and one with a view shown is shown.
   */
  checkLimits(): void {
    this.children.forEach((child, index) => {
      if (child instanceof BranchNode) {
        child.checkLimits();
        if (this.splitview.isViewVisible(index) === child.isHidden) {
          this.splitview.setViewVisible(index, !child.isHidden);
        }
      }
    });
    this.allChildrenHidden = this.computeAllChildrenHidden();
    this.lastLimits = this.limitsKey();
  }

  private listenTo(node: Node): void {
    const store = new DisposableStore();
    store.add(node.onDidChange(() => this.onChildrenChanged()));
    if (node instanceof BranchNode) {
      store.add(node.onDidVisibilityChange(visible => {
        const index = this.children.indexOf(node);
        if (index >= 0) {
          this.setChildVisible(index, visible);
        }
      }));
    }
    this.childListeners.set(node, store);
  }

  private onChildrenChanged(): void {
    if (this.context.batching > 0) {
      // Nodes are taken out and put back meanwhile: a branch emptied for a moment must not hide or
      // show itself in its parent. checkLimits settles visibility and limits once the batch ends.
      return;
    }
    const hidden = this.computeAllChildrenHidden();
    if (hidden !== this.allChildrenHidden) {
      this.allChildrenHidden = hidden;
      this._onDidVisibilityChange.fire(!hidden);
    }
    const limits = this.limitsKey();
    if (limits !== this.lastLimits) {
      this.lastLimits = limits;
      this._onDidChange.fire(undefined);
    }
  }

  private computeAllChildrenHidden(): boolean {
    return this.children.length > 0 && this.children.every((_, index) => !this.splitview.isViewVisible(index));
  }

  private limitsKey(): string {
    return [this.minimumSize, this.maximumSize, this.minimumOrthogonalSize, this.maximumOrthogonalSize, this.priority].join(',');
  }

  private reduceVisible(reducer: (value: number, child: Node) => number, initial: number): number {
    let value = initial;
    this.children.forEach((child, index) => {
      if (this.splitview.isViewVisible(index)) {
        value = reducer(value, child);
      }
    });
    return value;
  }

  dispose(): void {
    for (const listener of this.childListeners.values()) {
      listener.dispose();
    }
    this.childListeners.clear();
    for (const child of this.children) {
      child.dispose();
    }
    this.children.length = 0;
    this.disposables.dispose();
    this.element.remove();
  }
}

/** Splits an index path into the path to its parent and its index there. */
export function tail<T>(array: readonly T[]): [T[], T] {
  if (array.length === 0) {
    throw new Error('Invalid grid location: it is empty.');
  }
  return [array.slice(0, -1), array[array.length - 1]];
}

/**
 * Rebuilds `node` for a root of the other orientation. The tree keeps its shape and each
 * branch keeps its children's shares, now measured along the other axis. The old branch is
 * disposed; its children are flipped, not disposed.
 */
function flipNode(node: Node, size: number, orthogonalSize: number, context: IGridContext): Node {
  if (node instanceof LeafNode) {
    return new LeafNode(node.view, orthogonal(node.orientation), size, orthogonalSize);
  }
  // Every share and visibility is read before any child changes.
  const children = node.children.map((child, index) => ({
    child,
    share: node.getChildVisibleSize(index),
    visible: node.isChildVisible(index),
  }));
  const { orientation, splitviewProportionalLayout } = node;
  while (node.children.length > 0) {
    node.removeChild(node.children.length - 1, undefined, true);
  }
  node.dispose();

  const total = children.reduce((sum, { share }) => sum + share, 0);
  let given = 0;
  const descriptors = children.map(({ child, share, visible }, index): IChildDescriptor => {
    let childSize = total === 0 ? 0 : Math.round(size * share / total);
    given += childSize;
    if (index === children.length - 1) {
      // The last child takes the rounding.
      childSize += size - given;
    }
    return { node: flipNode(child, orthogonalSize, childSize, context), size: childSize, visible };
  });
  return new BranchNode(orthogonal(orientation), splitviewProportionalLayout, context, size, orthogonalSize, descriptors);
}

/**
 * A tree of split views with alternating orientations. Branches own a split view; leaves hold
 * the views. Locations are index paths from the root.
 */
export class GridView extends Disposable {
  readonly element: HTMLElement;
  private readonly proportionalLayout: boolean;
  private readonly context: IGridContext = { batching: 0 };
  private _root!: BranchNode;
  private readonly rootListeners = this._register(new DisposableStore());
  private lastSize: { width: number; height: number; top: number; left: number } | undefined;
  private lastRootLimits = '';

  private readonly _onDidChange = this._register(new Emitter<IViewSize | undefined>());
  /** Fires when the grid's limits change. */
  readonly onDidChange: Event<IViewSize | undefined> = this._onDidChange.event;

  constructor(options: IGridViewOptions = {}) {
    super();
    this.element = $('.monaco-grid-view');
    this.proportionalLayout = options.proportionalLayout ?? true;
    this.root = new BranchNode(Orientation.VERTICAL, this.proportionalLayout, this.context);
  }

  /** Builds a grid from stored data. Throws one error, building nothing, when the data is not a grid. */
  static deserialize<T extends ISerializableView>(json: unknown, deserializer: IViewDeserializer<T>, options: IGridViewOptions = {}): GridView {
    const data = validateSerializedGridView(json);
    const views: T[] = [];
    const resolve = (leaf: ISerializedLeafNode, path: string): T => {
      let view: T;
      try {
        view = deserializer.fromJSON(leaf.data);
      } catch (error) {
        throw new Error(`Invalid serialized grid: ${path}: its view could not be restored (${error instanceof Error ? error.message : String(error)}).`);
      }
      if (!view || typeof view !== 'object' || !(view.element instanceof HTMLElement)) {
        throw new Error(`Invalid serialized grid: ${path}: its view could not be restored.`);
      }
      if (views.includes(view)) {
        throw new Error(`Invalid serialized grid: ${path}: its view appears twice.`);
      }
      views.push(view);
      return view;
    };

    const result = new GridView(options);
    try {
      const empty = result._root;
      result.root = result.buildBranch(data.root as ISerializedBranchNode, data.orientation, 'root', resolve);
      empty.dispose();
    } catch (error) {
      result.dispose();
      for (const view of views) {
        (view as Partial<IDisposable>).dispose?.();
      }
      throw error;
    }
    return result;
  }

  private buildBranch(
    json: ISerializedBranchNode,
    orientation: Orientation,
    path: string,
    resolve: (leaf: ISerializedLeafNode, path: string) => IView,
  ): BranchNode {
    const descriptors = json.data.map((child, index): IChildDescriptor => {
      const childPath = `${path}.data[${index}]`;
      if (child.type === 'leaf') {
        const node = new LeafNode(resolve(child, childPath), orthogonal(orientation));
        return { node, size: child.size, visible: child.visible !== false };
      }
      const node = this.buildBranch(child, orthogonal(orientation), childPath, resolve);
      return { node, size: child.size, visible: !node.isHidden };
    });
    return new BranchNode(orientation, this.proportionalLayout, this.context, 0, 0, descriptors);
  }

  get orientation(): Orientation {
    return this._root.orientation;
  }

  /** Turns the whole tree: every split runs along the other axis, keeping its shares. */
  set orientation(orientation: Orientation) {
    if (this._root.orientation === orientation) {
      return;
    }
    this.batch(() => {
      const old = this._root;
      this.root = flipNode(old, old.orthogonalSize, old.size, this.context) as BranchNode;
    });
  }

  get width(): number {
    return this._root.width;
  }

  get height(): number {
    return this._root.height;
  }

  get minimumWidth(): number {
    return this._root.minimumWidth;
  }

  get maximumWidth(): number {
    return this._root.maximumWidth;
  }

  get minimumHeight(): number {
    return this._root.minimumHeight;
  }

  get maximumHeight(): number {
    return this._root.maximumHeight;
  }

  private get root(): BranchNode {
    return this._root;
  }

  /** Puts `root` in place. The old root stays the caller's to dispose. */
  private set root(root: BranchNode) {
    this._root?.element.remove();
    this._root = root;
    this.element.append(root.element);
    this.rootListeners.clear();
    this.rootListeners.add(root.onDidChange(() => this.onRootLimitsChanged()));
    this.lastRootLimits = this.rootLimitsKey();
  }

  layout(width: number, height: number, top = 0, left = 0): void {
    // A container cannot be negative or unknown in size; such a call lays the grid out empty.
    width = Number.isFinite(width) && width > 0 ? width : 0;
    height = Number.isFinite(height) && height > 0 ? height : 0;
    top = Number.isFinite(top) ? top : 0;
    left = Number.isFinite(left) ? left : 0;
    this.lastSize = { width, height, top, left };
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    const vertical = this._root.orientation === Orientation.VERTICAL;
    this._root.layout(vertical ? width : height, 0, {
      orthogonalSize: vertical ? height : width,
      absoluteOffset: vertical ? left : top,
      absoluteOrthogonalOffset: vertical ? top : left,
    });
  }

  addView(view: IView, size: number | Sizing, location: readonly number[]): void {
    const [rest, index] = tail(location);
    const [pathToParent, parent] = this.getNode(rest);

    if (parent instanceof BranchNode) {
      this.assertInsertIndex(parent, index);
      const node = new LeafNode(view, orthogonal(parent.orientation), parent.orthogonalSize);
      parent.addChild(node, size, index);
      return;
    }

    // The location runs into a leaf: that leaf and the new view share a new branch in its place.
    if (index !== 0 && index !== 1) {
      throw new Error(`Invalid grid location ${JSON.stringify(location)}: a view splits a view only before (0) or after (1) it.`);
    }
    const grandParent = pathToParent[pathToParent.length - 1];
    const parentIndex = rest[rest.length - 1];
    this.batch(() => {
      const parentVisible = grandParent.isChildVisible(parentIndex);
      const parentSize = grandParent.getChildVisibleSize(parentIndex);
      const extent = parent.size;
      const invisible = typeof size !== 'number' && size.type === 'invisible';

      let newSize: number;
      if (typeof size === 'number') {
        newSize = Math.min(Number.isFinite(size) && size > 0 ? size : 0, extent);
      } else if (size.type === 'invisible') {
        newSize = size.cachedVisibleSize;
      } else {
        newSize = Math.floor(extent / 2);
      }
      const siblingSize = invisible ? extent : extent - newSize;

      grandParent.removeChild(parentIndex, undefined, true);
      // Inside the new branch the leaves run across it: their own extent is the grandparent's axis.
      const sibling = new LeafNode(parent.view, orthogonal(parent.orientation), parentSize, siblingSize);
      const node = new LeafNode(view, sibling.orientation, parentSize, invisible ? 0 : newSize);
      const children: IChildDescriptor[] = [{ node: sibling, size: siblingSize, visible: parentVisible }];
      children.splice(index, 0, { node, size: newSize, visible: !invisible });
      const newParent = new BranchNode(parent.orientation, this.proportionalLayout, this.context, extent, parentSize, children);
      grandParent.addChild(newParent, newParent.isHidden ? Sizing.Invisible(parentSize) : parentSize, parentIndex, true);
      parent.dispose();
    });
  }

  removeView(location: readonly number[], sizing?: DistributeSizing): IView {
    const [rest, index] = tail(location);
    const [pathToParent, parent] = this.getNode(rest);
    if (!(parent instanceof BranchNode)) {
      throw new Error(`Invalid grid location ${JSON.stringify(location)}: it does not lead to a view.`);
    }
    const node = parent.children[index];
    if (!(node instanceof LeafNode)) {
      throw new Error(`Invalid grid location ${JSON.stringify(location)}: it does not lead to a view.`);
    }

    const isRoot = pathToParent.length === 0;
    const sibling = parent.children.length === 2 ? parent.children[1 - index] : undefined;
    if (!sibling || (isRoot && sibling instanceof LeafNode)) {
      // Nothing collapses: the parent keeps two or more children, or the root keeps one view.
      parent.removeChild(index, sizing);
      node.dispose();
      return node.view;
    }

    // The branch the remaining views end in: only its children are evened out by `Distribute`.
    let changed: BranchNode | undefined;
    this.batch(() => {
      parent.removeChild(index, undefined, true);
      node.dispose();

      if (isRoot) {
        // The root would hold a single branch: that branch becomes the root and the grid turns.
        parent.removeChild(0, undefined, true);
        this.root = changed = sibling as BranchNode;
        parent.dispose();
        return;
      }

      // The parent would hold one child: that child takes the parent's place in the grandparent.
      const grandParent = changed = pathToParent[pathToParent.length - 1];
      const parentIndex = rest[rest.length - 1];
      const parentVisible = grandParent.isChildVisible(parentIndex);
      const parentSize = grandParent.getChildVisibleSize(parentIndex);
      const siblingVisible = parent.isChildVisible(0);
      parent.removeChild(0, undefined, true);
      grandParent.removeChild(parentIndex, undefined, true);
      parent.dispose();

      if (sibling instanceof BranchNode) {
        // Its children already run along the grandparent's axis; they move up as they are.
        const children = sibling.children.map((child, i) => ({
          child,
          size: sibling.getChildVisibleSize(i),
          visible: sibling.isChildVisible(i),
        }));
        while (sibling.children.length > 0) {
          sibling.removeChild(sibling.children.length - 1, undefined, true);
        }
        sibling.dispose();
        children.forEach(({ child, size, visible }, i) => {
          grandParent.addChild(child, visible ? size : Sizing.Invisible(size), parentIndex + i, true);
        });
      } else {
        const leaf = new LeafNode(sibling.view, orthogonal(sibling.orientation), parent.size, parentSize);
        const visible = parentVisible && siblingVisible;
        grandParent.addChild(leaf, visible ? parentSize : Sizing.Invisible(parentSize), parentIndex, true);
        sibling.dispose();
      }
    });

    if (sizing?.type === 'distribute') {
      changed?.distributeViewSizes();
    }
    return node.view;
  }

  /** Moves a view within its parent: from index `from` to the gap before the child now at `to`. */
  moveView(parentLocation: readonly number[], from: number, to: number): void {
    const [, parent] = this.getNode(parentLocation);
    if (!(parent instanceof BranchNode)) {
      throw new Error(`Invalid grid location ${JSON.stringify(parentLocation)}: it does not lead to a branch.`);
    }
    this.assertChildIndex(parent, from);
    this.assertInsertIndex(parent, to);
    parent.moveChild(from, to);
  }

  resizeView(location: readonly number[], size: Partial<IViewSize>): void {
    const [rest, index] = tail(location);
    const [pathToParent, parent] = this.getNode(rest);
    if (!(parent instanceof BranchNode)) {
      throw new Error(`Invalid grid location ${JSON.stringify(location)}.`);
    }
    this.assertChildIndex(parent, index);
    const horizontal = parent.orientation === Orientation.HORIZONTAL;
    const alongParent = horizontal ? size.width : size.height;
    const alongGrandParent = horizontal ? size.height : size.width;

    if (alongGrandParent !== undefined && pathToParent.length > 0) {
      const grandParent = pathToParent[pathToParent.length - 1];
      grandParent.resizeChild(rest[rest.length - 1], alongGrandParent);
    }
    if (alongParent !== undefined) {
      parent.resizeChild(index, alongParent);
    }
  }

  getViewSize(location?: readonly number[]): IViewSize {
    const node = location ? this.getNode(location)[1] : this._root;
    return { width: node.width, height: node.height };
  }

  getViewCachedVisibleSize(location: readonly number[]): number | undefined {
    const [parent, index] = this.getLeafParent(location);
    return parent.getChildCachedVisibleSize(index);
  }

  isViewVisible(location: readonly number[]): boolean {
    const [parent, index] = this.getLeafParent(location);
    return parent.isChildVisible(index);
  }

  setViewVisible(location: readonly number[], visible: boolean): void {
    const [parent, index] = this.getLeafParent(location);
    parent.setChildVisible(index, visible);
  }

  /** Makes the views of each branch the same size, through the whole tree or below `location`. */
  distributeViewSizes(location?: readonly number[]): void {
    const node = location ? this.getNode(location)[1] : this._root;
    if (node instanceof BranchNode) {
      node.distributeViewSizes(true);
    }
  }

  getView(): GridBranchNode;
  getView(location: readonly number[]): GridNode;
  getView(location?: readonly number[]): GridNode {
    if (!location || location.length === 0) {
      return this.toGridNode(this._root, undefined);
    }
    const [rest, index] = tail(location);
    const [, parent] = this.getNode(rest);
    if (!(parent instanceof BranchNode)) {
      throw new Error(`Invalid grid location ${JSON.stringify(location)}.`);
    }
    this.assertChildIndex(parent, index);
    return this.toGridNode(parent.children[index], parent.getChildCachedVisibleSize(index));
  }

  /** The location of `view`, or `undefined` when the grid does not hold it. */
  getViewLocation(view: IView): number[] | undefined {
    const search = (node: BranchNode, path: number[]): number[] | undefined => {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child instanceof LeafNode) {
          if (child.view === view) {
            return [...path, i];
          }
        } else {
          const found = search(child, [...path, i]);
          if (found) {
            return found;
          }
        }
      }
      return undefined;
    };
    return search(this._root, []);
  }

  private toGridNode(node: Node, cachedVisibleSize: number | undefined): GridNode {
    if (node instanceof LeafNode) {
      return { view: node.view, box: node.box, cachedVisibleSize };
    }
    return {
      children: node.children.map((child, index) => this.toGridNode(child, node.getChildCachedVisibleSize(index))),
      box: node.box,
      cachedVisibleSize,
    };
  }

  private getNode(location: readonly number[]): [BranchNode[], Node] {
    const path: BranchNode[] = [];
    let node: Node = this._root;
    for (const index of location) {
      if (!(node instanceof BranchNode) || !Number.isInteger(index) || index < 0 || index >= node.children.length) {
        throw new Error(`Invalid grid location ${JSON.stringify(location)}.`);
      }
      path.push(node);
      node = node.children[index];
    }
    return [path, node];
  }

  private getLeafParent(location: readonly number[]): [BranchNode, number] {
    const [rest, index] = tail(location);
    const [, parent] = this.getNode(rest);
    if (!(parent instanceof BranchNode) || !(parent.children[index] instanceof LeafNode)) {
      throw new Error(`Invalid grid location ${JSON.stringify(location)}: it does not lead to a view.`);
    }
    return [parent, index];
  }

  private assertChildIndex(parent: BranchNode, index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= parent.children.length) {
      throw new Error(`Invalid grid index ${index} in a branch of ${parent.children.length}.`);
    }
  }

  private assertInsertIndex(parent: BranchNode, index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > parent.children.length) {
      throw new Error(`Invalid grid index ${index} in a branch of ${parent.children.length}.`);
    }
  }

  /**
   * Runs a change that takes nodes out and puts new ones in. Limits stay quiet meanwhile, the
   * sizes move as a whole, and one layout fits everything at the end.
   */
  private batch(change: () => void): void {
    this.context.batching++;
    try {
      change();
    } finally {
      this.context.batching--;
    }
    if (this.context.batching === 0) {
      this._root.checkLimits();
      this.relayout();
      this.onRootLimitsChanged();
    }
  }

  private relayout(): void {
    if (this.lastSize) {
      const { width, height, top, left } = this.lastSize;
      this.layout(width, height, top, left);
    }
  }

  private onRootLimitsChanged(): void {
    const limits = this.rootLimitsKey();
    if (limits !== this.lastRootLimits) {
      this.lastRootLimits = limits;
      this._onDidChange.fire(undefined);
    }
  }

  private rootLimitsKey(): string {
    const root = this._root;
    return [root.minimumWidth, root.maximumWidth, root.minimumHeight, root.maximumHeight].join(',');
  }

  override dispose(): void {
    this._root.dispose();
    this.element.remove();
    super.dispose();
  }
}

/** Checks stored data before anything is built from it. Throws one error naming the first fault. */
export function validateSerializedGridView(json: unknown): ISerializedGridView {
  const fail = (path: string, reason: string): never => {
    throw new Error(`Invalid serialized grid: ${path} ${reason}.`);
  };
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const checkSize = (value: unknown, path: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(path, 'must be a finite number of zero or more');
    }
  };
  let leaves = 0;
  const checkNode = (node: unknown, path: string, depth: number): void => {
    if (depth > 64) {
      fail(path, 'nests too deeply');
    }
    if (!isRecord(node)) {
      fail(path, 'must be an object');
      return;
    }
    checkSize(node.size, `${path}.size`);
    if (node.type === 'leaf') {
      if (node.visible !== undefined && typeof node.visible !== 'boolean') {
        fail(`${path}.visible`, 'must be true or false when present');
      }
      if (!('data' in node)) {
        fail(`${path}.data`, 'is missing');
      }
      leaves++;
    } else if (node.type === 'branch') {
      if (!Array.isArray(node.data) || node.data.length === 0) {
        fail(`${path}.data`, 'must be a non-empty array of nodes');
      }
      // Removing views collapses every branch below the root that is left with one child, so a
      // stored one never holds fewer than two; one that does would leave an empty branch behind.
      if (depth > 0 && (node.data as unknown[]).length < 2) {
        fail(`${path}.data`, 'must hold at least two nodes below the root');
      }
      (node.data as unknown[]).forEach((child, index) => checkNode(child, `${path}.data[${index}]`, depth + 1));
    } else {
      fail(`${path}.type`, "must be 'leaf' or 'branch'");
    }
  };

  if (!isRecord(json)) {
    return fail('the data', 'must be an object');
  }
  if (json.orientation !== Orientation.VERTICAL && json.orientation !== Orientation.HORIZONTAL) {
    fail('orientation', `must be ${Orientation.VERTICAL} or ${Orientation.HORIZONTAL}`);
  }
  checkSize(json.width, 'width');
  checkSize(json.height, 'height');
  if (!isRecord(json.root) || json.root.type !== 'branch') {
    fail('root', 'must be a branch');
  }
  checkNode(json.root, 'root', 0);
  if (leaves === 0) {
    fail('root', 'holds no view');
  }
  return json as unknown as ISerializedGridView;
}
