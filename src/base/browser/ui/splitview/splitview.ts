import { $ } from '../../dom.js';
import { Emitter } from '../../../common/event.js';
import type { Event } from '../../../common/event.js';
import { Disposable, dispose, toDisposable } from '../../../common/lifecycle.js';
import type { IDisposable } from '../../../common/lifecycle.js';
import { Orientation, Sash, SashState } from '../sash/sash.js';
import type { ISashEvent } from '../sash/sash.js';
import './splitview.css';

export { Orientation } from '../sash/sash.js';

/**
 * Which view takes a change of the split view's size first when the layout is not proportional.
 * `High` views grow and shrink before `Normal` ones, `Low` views last.
 */
export enum LayoutPriority {
  Normal,
  Low,
  High,
}

/** A view laid out along one axis of a {@link SplitView}. */
export interface IView<TLayoutContext = undefined> {
  readonly element: HTMLElement;
  /** Smallest size along the split view's axis. */
  readonly minimumSize: number;
  /** Largest size along the split view's axis; `Number.POSITIVE_INFINITY` for none. */
  readonly maximumSize: number;
  /**
   * Fires when the limits changed (`undefined`) or when the view asks for a size of its own.
   */
  readonly onDidChange: Event<number | undefined>;
  readonly priority?: LayoutPriority;
  /** `false` keeps this view's size when a proportional split view changes size. */
  readonly proportionalLayout?: boolean;
  layout(size: number, offset: number, context: TLayoutContext | undefined): void;
  setVisible?(visible: boolean): void;
}

export interface DistributeSizing { readonly type: 'distribute' }
export interface SplitSizing { readonly type: 'split'; readonly index: number }
export interface AutoSizing { readonly type: 'auto'; readonly index: number }
export interface InvisibleSizing { readonly type: 'invisible'; readonly cachedVisibleSize: number }

/** How a view added without an explicit size gets one. */
export type Sizing = DistributeSizing | SplitSizing | AutoSizing | InvisibleSizing;

export namespace Sizing {
  /** Every flexible view ends with the same size. */
  export const Distribute: DistributeSizing = { type: 'distribute' };
  /** The new view takes half of the view at `index`. */
  export function Split(index: number): SplitSizing {
    return { type: 'split', index };
  }
  /** `Distribute` while the views are equal, otherwise `Split(index)`. */
  export function Auto(index: number): AutoSizing {
    return { type: 'auto', index };
  }
  /** The view starts hidden and takes `cachedVisibleSize` once it is shown. */
  export function Invisible(cachedVisibleSize: number): InvisibleSizing {
    return { type: 'invisible', cachedVisibleSize };
  }
}

export interface ISplitViewDescriptor<TLayoutContext = undefined, TView extends IView<TLayoutContext> = IView<TLayoutContext>> {
  readonly views: readonly {
    readonly visible?: boolean;
    readonly size: number;
    readonly view: TView;
  }[];
}

export interface ISplitViewOptions<TLayoutContext = undefined, TView extends IView<TLayoutContext> = IView<TLayoutContext>> {
  /** Defaults to `VERTICAL`. */
  readonly orientation?: Orientation;
  /**
   * `true` (the default) keeps every view's share when the split view changes size;
   * `false` hands the change to the views by {@link LayoutPriority}.
   */
  readonly proportionalLayout?: boolean;
  /** Views to start with, at the given sizes. The first `layout` fits them to the real size. */
  readonly descriptor?: ISplitViewDescriptor<TLayoutContext, TView>;
  /** The sashes' length across the axis. Without it they span the split view by CSS. */
  readonly getSashOrthogonalSize?: () => number;
}

class ViewItem<TLayoutContext, TView extends IView<TLayoutContext>> {
  private _size: number;
  private _cachedVisibleSize: number | undefined;

  constructor(
    readonly container: HTMLElement,
    readonly view: TView,
    size: number | InvisibleSizing,
    private readonly disposable: IDisposable,
  ) {
    if (typeof size === 'number') {
      this._size = size;
      this._cachedVisibleSize = undefined;
    } else {
      this._size = 0;
      this._cachedVisibleSize = size.cachedVisibleSize;
    }
    container.classList.toggle('visible', this.visible);
  }

  get size(): number {
    return this._size;
  }

  set size(size: number) {
    this._size = size;
  }

  get visible(): boolean {
    return this._cachedVisibleSize === undefined;
  }

  get cachedVisibleSize(): number | undefined {
    return this._cachedVisibleSize;
  }

  get minimumSize(): number {
    return this.visible ? this.view.minimumSize : 0;
  }

  get maximumSize(): number {
    return this.visible ? this.view.maximumSize : 0;
  }

  get priority(): LayoutPriority {
    return this.view.priority ?? LayoutPriority.Normal;
  }

  get proportionalLayout(): boolean {
    return this.view.proportionalLayout ?? true;
  }

  set enabled(enabled: boolean) {
    this.container.style.pointerEvents = enabled ? '' : 'none';
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    if (visible) {
      this._size = clamp(this._cachedVisibleSize!, this.view.minimumSize, this.view.maximumSize);
      this._cachedVisibleSize = undefined;
    } else {
      this._cachedVisibleSize = this._size;
      this._size = 0;
    }
    this.container.classList.toggle('visible', visible);
    this.view.setVisible?.(visible);
  }

  layout(offset: number, orientation: Orientation, context: TLayoutContext | undefined): void {
    const style = this.container.style;
    if (orientation === Orientation.VERTICAL) {
      style.top = `${offset}px`;
      style.height = `${this._size}px`;
    } else {
      style.left = `${offset}px`;
      style.width = `${this._size}px`;
    }
    this.view.layout(this._size, offset, context);
  }

  dispose(): void {
    this.disposable.dispose();
    this.container.remove();
  }
}

interface ISashItem {
  readonly sash: Sash;
  readonly disposable: IDisposable;
}

interface ISashDragState {
  readonly index: number;
  readonly start: number;
  readonly sizes: readonly number[];
}

/** The most passes `layoutViews` makes when views change their limits while they are laid out. */
const MAX_LAYOUT_PASSES = 10;

/**
 * One row or column of views separated by sashes. Every size comes from `layout(size)` and is
 * written as inline geometry; nothing is measured from the DOM.
 */
export class SplitView<TLayoutContext = undefined, TView extends IView<TLayoutContext> = IView<TLayoutContext>> extends Disposable {
  readonly el: HTMLElement;
  readonly orientation: Orientation;
  private readonly sashContainer: HTMLElement;
  private readonly viewContainer: HTMLElement;
  private readonly proportionalLayout: boolean;
  private readonly getSashOrthogonalSize: (() => number) | undefined;

  private size = 0;
  private _contentSize = 0;
  private laidOut = false;
  private layoutContext: TLayoutContext | undefined;
  private proportions: (number | undefined)[] | undefined;
  private viewItems: ViewItem<TLayoutContext, TView>[] = [];
  private sashItems: ISashItem[] = [];
  private sashDragState: ISashDragState | undefined;
  private layingOut = false;
  private layoutPending = false;

  private readonly _onDidSashChange = this._register(new Emitter<number>());
  /** Fires with the sash's index when a drag ends. */
  readonly onDidSashChange: Event<number> = this._onDidSashChange.event;

  constructor(container: HTMLElement, options: ISplitViewOptions<TLayoutContext, TView> = {}) {
    super();
    this.orientation = options.orientation ?? Orientation.VERTICAL;
    this.proportionalLayout = options.proportionalLayout ?? true;
    this.getSashOrthogonalSize = options.getSashOrthogonalSize;

    this.el = $('.monaco-split-view2');
    this.el.classList.add(this.orientation === Orientation.VERTICAL ? 'vertical' : 'horizontal');
    this.viewContainer = $('.split-view-container');
    this.sashContainer = $('.sash-container');
    this.el.append(this.viewContainer, this.sashContainer);
    container.append(this.el);

    if (options.descriptor) {
      for (const { visible, size, view } of options.descriptor.views) {
        this.addView(view, visible === false ? Sizing.Invisible(size) : size, this.viewItems.length, true);
      }
      this._contentSize = this.sum(item => item.size);
      this.size = this._contentSize;
      this.saveProportions();
    }
  }

  get length(): number {
    return this.viewItems.length;
  }

  /** The sum of the views' sizes. It can exceed the split view's size when the views cannot fit. */
  get contentSize(): number {
    return this._contentSize;
  }

  get minimumSize(): number {
    return this.sum(item => item.minimumSize);
  }

  get maximumSize(): number {
    return this.length === 0 ? Number.POSITIVE_INFINITY : this.sum(item => item.maximumSize);
  }

  get sashes(): readonly Sash[] {
    return this.sashItems.map(item => item.sash);
  }

  addView(view: TView, size: number | Sizing, index = this.viewItems.length, skipLayout = false): void {
    this.assertIdle();
    if (!Number.isInteger(index) || index < 0 || index > this.viewItems.length) {
      throw new RangeError(`Cannot add a view at index ${index} of ${this.viewItems.length}.`);
    }
    this.endSashDrag();

    const container = $('.split-view-view');
    this.viewContainer.insertBefore(container, this.viewItems[index]?.container ?? null);
    container.append(view.element);

    let itemSize: number | InvisibleSizing;
    let distribute = false;
    let splitReference: ViewItem<TLayoutContext, TView> | undefined;
    if (typeof size === 'number') {
      itemSize = finiteSize(size);
    } else {
      let sizing: Sizing = size;
      if (sizing.type === 'auto') {
        sizing = this.areViewsDistributed() ? Sizing.Distribute : Sizing.Split(sizing.index);
      }
      if (sizing.type === 'split') {
        splitReference = this.viewItems[sizing.index];
      }
      if (splitReference) {
        // The reference keeps the larger half, so whole pixels stay whole.
        itemSize = Math.floor(splitReference.size / 2);
        splitReference.size -= itemSize;
      } else if (sizing.type === 'invisible') {
        itemSize = Sizing.Invisible(finiteSize(sizing.cachedVisibleSize));
      } else {
        itemSize = view.minimumSize;
        distribute = true;
      }
    }

    // The item is assigned before any event can reach it: the subscription only stores the listener.
    let item: ViewItem<TLayoutContext, TView> | undefined;
    const subscription = view.onDidChange(viewSize => {
      if (item) {
        this.onViewChange(item, viewSize);
      }
    });
    item = new ViewItem(container, view, itemSize, subscription);
    this.viewItems.splice(index, 0, item);

    if (this.viewItems.length > 1) {
      this.sashItems.splice(Math.max(index - 1, 0), 0, this.createSash());
    }

    if (skipLayout) {
      this.saveProportions();
      return;
    }
    if (distribute) {
      this.distributeViewSizes();
    } else if (splitReference) {
      this.relayout([index], [this.viewItems.indexOf(splitReference)]);
    } else {
      this.relayout([index]);
    }
  }

  /**
   * Removes the view at `index` and returns it. Its element stays the caller's, so it can be
   * added somewhere else. Its space goes to the view before it, or after it at the start.
   */
  removeView(index: number, sizing?: Sizing, skipLayout = false): TView {
    this.assertIdle();
    this.assertIndex(index);
    this.endSashDrag();

    const [item] = this.viewItems.splice(index, 1);
    item.dispose();
    if (this.sashItems.length > 0) {
      const [sashItem] = this.sashItems.splice(Math.max(index - 1, 0), 1);
      sashItem.disposable.dispose();
    }

    if (skipLayout) {
      this.saveProportions();
    } else if (sizing?.type === 'distribute') {
      this.distributeViewSizes();
    } else {
      this.relayout(undefined, this.viewItems.length > 0 ? [Math.max(index - 1, 0)] : undefined);
    }
    return item.view;
  }

  /** Moves the view at `from` so it ends at index `to`, keeping its element and size. */
  moveView(from: number, to: number): void {
    this.assertIdle();
    this.assertIndex(from);
    this.assertIndex(to);
    if (from === to) {
      return;
    }
    this.endSashDrag();
    const [item] = this.viewItems.splice(from, 1);
    this.viewItems.splice(to, 0, item);
    this.viewContainer.insertBefore(item.container, this.viewItems[to + 1]?.container ?? null);
    this.layoutViews();
    this.saveProportions();
  }

  isViewVisible(index: number): boolean {
    this.assertIndex(index);
    return this.viewItems[index].visible;
  }

  /** Hiding gives the view's space to the others and remembers its size; showing takes it back. */
  setViewVisible(index: number, visible: boolean): void {
    this.assertIdle();
    this.assertIndex(index);
    const item = this.viewItems[index];
    if (item.visible === visible) {
      return;
    }
    this.endSashDrag();
    item.setVisible(visible);
    this.distributeEmptySpace(index);
    this.layoutViews();
    this.saveProportions();
  }

  getViewCachedVisibleSize(index: number): number | undefined {
    this.assertIndex(index);
    return this.viewItems[index].cachedVisibleSize;
  }

  getViewSize(index: number): number {
    this.assertIndex(index);
    return this.viewItems[index].size;
  }

  /** Gives the view at `index` this size, within its limits, taking the change from the others. */
  resizeView(index: number, size: number): void {
    this.assertIdle();
    this.assertIndex(index);
    const item = this.viewItems[index];
    if (!item.visible) {
      return;
    }
    const others = range(this.viewItems.length).filter(i => i !== index);
    const low = [...others.filter(i => this.viewItems[i].priority === LayoutPriority.Low), index];
    const high = others.filter(i => this.viewItems[i].priority === LayoutPriority.High);
    const available = this.laidOut ? this.size - this.sumOf(others, i => this.viewItems[i].minimumSize) : Number.POSITIVE_INFINITY;
    item.size = clamp(Math.round(finiteSize(size)), item.minimumSize, Math.min(item.maximumSize, Math.max(available, item.minimumSize)));
    this.relayout(low, high);
  }

  /** Makes every flexible visible view the same size. */
  distributeViewSizes(): void {
    const flexible = this.viewItems.filter(item => item.visible && item.maximumSize - item.minimumSize > 0);
    if (flexible.length > 0) {
      // Once laid out, the flexible views share the room the fixed ones leave; before, what they hold.
      const room = this.laidOut
        ? this.size - this.sum(item => flexible.includes(item) ? 0 : item.size)
        : flexible.reduce((total, item) => total + item.size, 0);
      const share = Math.floor(room / flexible.length);
      for (const item of flexible) {
        item.size = clamp(share, item.minimumSize, item.maximumSize);
      }
    }
    const indexes = range(this.viewItems.length);
    this.relayout(
      indexes.filter(i => this.viewItems[i].priority === LayoutPriority.Low),
      indexes.filter(i => this.viewItems[i].priority === LayoutPriority.High),
    );
  }

  layout(size: number, layoutContext?: TLayoutContext): void {
    size = finiteSize(size);
    const previousSize = Math.max(this.size, this._contentSize);
    const proportions = this.proportions;
    this.size = size;
    this.layoutContext = layoutContext;
    this.laidOut = true;

    if (!proportions || proportions.length !== this.viewItems.length) {
      const indexes = range(this.viewItems.length);
      this.resize(
        this.viewItems.length - 1,
        size - previousSize,
        undefined,
        indexes.filter(i => this.viewItems[i].priority === LayoutPriority.Low),
        indexes.filter(i => this.viewItems[i].priority === LayoutPriority.High),
      );
    } else {
      let shares = 0;
      let flexibleSize = size;
      this.viewItems.forEach((item, i) => {
        const proportion = proportions![i];
        if (proportion === undefined) {
          flexibleSize -= item.size;
        } else {
          shares += proportion;
        }
      });
      this.viewItems.forEach((item, i) => {
        const proportion = proportions![i];
        if (proportion !== undefined && shares > 0) {
          item.size = clamp(Math.round(proportion * flexibleSize / shares), item.minimumSize, item.maximumSize);
        }
      });
    }

    this.distributeEmptySpace();
    this.layoutViews();
  }

  private onSashStart(sash: Sash, event: ISashEvent): void {
    const index = this.sashItems.findIndex(item => item.sash === sash);
    if (index < 0) {
      return;
    }
    for (const item of this.viewItems) {
      item.enabled = false;
    }
    this.sashDragState = {
      index,
      start: this.orientation === Orientation.VERTICAL ? event.startY : event.startX,
      sizes: this.viewItems.map(item => item.size),
    };
  }

  private onSashChange(event: ISashEvent): void {
    const state = this.sashDragState;
    if (!state || this.layingOut) {
      return;
    }
    const current = this.orientation === Orientation.VERTICAL ? event.currentY : event.currentX;
    this.resize(state.index, current - state.start, state.sizes);
    this.distributeEmptySpace();
    this.layoutViews();
  }

  private onSashEnd(): void {
    const state = this.sashDragState;
    this.sashDragState = undefined;
    for (const item of this.viewItems) {
      item.enabled = true;
    }
    if (state) {
      this.saveProportions();
      this._onDidSashChange.fire(state.index);
    }
  }

  /** A drag's start sizes describe the views as they were; once views change, the drag stops resizing. */
  private endSashDrag(): void {
    if (this.sashDragState) {
      this.onSashEnd();
    }
  }

  private onViewChange(item: ViewItem<TLayoutContext, TView>, size: number | undefined): void {
    const index = this.viewItems.indexOf(item);
    if (index < 0 || !item.visible) {
      return;
    }
    item.size = clamp(size === undefined ? item.size : finiteSize(size), item.minimumSize, item.maximumSize);
    if (this.layingOut) {
      // The views are being laid out right now; layoutViews fits the new limits after this pass.
      this.layoutPending = true;
      return;
    }
    this.relayout([index]);
  }

  private relayout(lowPriorityIndexes?: number[], highPriorityIndexes?: number[]): void {
    if (this.laidOut) {
      const contentSize = this.sum(item => item.size);
      this.resize(this.viewItems.length - 1, this.size - contentSize, undefined, lowPriorityIndexes, highPriorityIndexes);
      this.distributeEmptySpace();
      this.layoutViews();
    } else {
      // Before the first layout the requested sizes stand; the first layout fits them to the real size.
      this._contentSize = this.sum(item => item.size);
    }
    this.saveProportions();
  }

  private saveProportions(): void {
    if (!this.proportionalLayout) {
      return;
    }
    // Without content there are no shares to read: the last ones stand, so a split view laid out
    // at size 0 for a while gets its shares back. A layout ignores them once the views change count.
    const contentSize = this.sum(item => item.size);
    if (contentSize > 0) {
      this.proportions = this.viewItems.map(item => item.proportionalLayout && item.visible ? item.size / contentSize : undefined);
    }
  }

  /**
   * Moves the boundary after the view at `index` by `delta`. The views before it (walking back
   * from `index`) and after it (walking forward) each take what they can within their limits,
   * so a neighbour at its minimum passes the rest on to the next view. Returns the applied delta.
   */
  private resize(
    index: number,
    delta: number,
    sizes: readonly number[] = this.viewItems.map(item => item.size),
    lowPriorityIndexes?: readonly number[],
    highPriorityIndexes?: readonly number[],
  ): number {
    if (index < 0 || index >= this.viewItems.length) {
      return 0;
    }

    const upIndexes = range(index, -1);
    const downIndexes = range(index + 1, this.viewItems.length);
    for (const i of highPriorityIndexes ?? []) {
      moveToStart(upIndexes, i);
      moveToStart(downIndexes, i);
    }
    for (const i of lowPriorityIndexes ?? []) {
      moveToEnd(upIndexes, i);
      moveToEnd(downIndexes, i);
    }

    const items = this.viewItems;
    const minDeltaUp = this.sumOf(upIndexes, i => items[i].minimumSize - sizes[i]);
    const maxDeltaUp = this.sumOf(upIndexes, i => items[i].maximumSize - sizes[i]);
    const maxDeltaDown = downIndexes.length === 0 ? Number.POSITIVE_INFINITY : this.sumOf(downIndexes, i => sizes[i] - items[i].minimumSize);
    const minDeltaDown = downIndexes.length === 0 ? Number.NEGATIVE_INFINITY : this.sumOf(downIndexes, i => sizes[i] - items[i].maximumSize);
    const minDelta = Math.max(minDeltaUp, minDeltaDown);
    const maxDelta = Math.min(maxDeltaDown, maxDeltaUp);
    // With views that cannot fit, the limits cross; keeping the sizes is then the only safe move.
    delta = minDelta > maxDelta ? 0 : clamp(delta, minDelta, maxDelta);

    let deltaUp = delta;
    for (const i of upIndexes) {
      const size = clamp(sizes[i] + deltaUp, items[i].minimumSize, items[i].maximumSize);
      deltaUp -= size - sizes[i];
      items[i].size = size;
    }
    let deltaDown = delta;
    for (const i of downIndexes) {
      const size = clamp(sizes[i] - deltaDown, items[i].minimumSize, items[i].maximumSize);
      deltaDown += size - sizes[i];
      items[i].size = size;
    }
    return delta;
  }

  /** Hands the gap between the split view's size and the views' sizes to the views, last first. */
  private distributeEmptySpace(lowPriorityIndex?: number): void {
    if (!this.laidOut) {
      // There is no size to fill yet; the first layout distributes it.
      return;
    }
    let emptyDelta = this.size - this.sum(item => item.size);
    const indexes = range(this.viewItems.length - 1, -1);
    for (const i of indexes.filter(i => this.viewItems[i].priority === LayoutPriority.High)) {
      moveToStart(indexes, i);
    }
    for (const i of indexes.filter(i => this.viewItems[i].priority === LayoutPriority.Low)) {
      moveToEnd(indexes, i);
    }
    if (lowPriorityIndex !== undefined) {
      moveToEnd(indexes, lowPriorityIndex);
    }
    for (const i of indexes) {
      if (emptyDelta === 0) {
        break;
      }
      const item = this.viewItems[i];
      const size = clamp(item.size + emptyDelta, item.minimumSize, item.maximumSize);
      emptyDelta -= size - item.size;
      item.size = size;
    }
  }

  private layoutViews(): void {
    this._contentSize = this.sum(item => item.size);
    if (!this.laidOut) {
      return;
    }
    if (this.layingOut) {
      this.layoutPending = true;
      return;
    }
    this.layingOut = true;
    try {
      for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass++) {
        this.layoutPending = false;
        let offset = 0;
        for (const item of this.viewItems) {
          item.layout(offset, this.orientation, this.layoutContext);
          offset += item.size;
        }
        this._contentSize = offset;
        if (!this.layoutPending) {
          break;
        }
        // A view changed its limits while it was laid out: fit the sizes once more, then lay out again.
        this.resize(this.viewItems.length - 1, this.size - this._contentSize);
        this.distributeEmptySpace();
      }
    } finally {
      this.layingOut = false;
      this.layoutPending = false;
    }
    for (const { sash } of this.sashItems) {
      sash.layout();
    }
    this.updateSashEnablement();
  }

  private updateSashEnablement(): void {
    const items = this.viewItems;
    // For each sash: can the views before it shrink or grow, and can the views after it?
    let any = false;
    const collapsesDown = items.map(item => any = item.size - item.minimumSize > 0 || any);
    any = false;
    const expandsDown = items.map(item => any = item.maximumSize - item.size > 0 || any);
    any = false;
    const collapsesUp = [...items].reverse().map(item => any = item.size - item.minimumSize > 0 || any).reverse();
    any = false;
    const expandsUp = [...items].reverse().map(item => any = item.maximumSize - item.size > 0 || any).reverse();

    this.sashItems.forEach(({ sash }, index) => {
      // Around a hidden view two sashes would share one boundary; the one after it serves it.
      const besideHidden = !items[index + 1].visible;
      const atMinimum = !(collapsesDown[index] && expandsUp[index + 1]);
      const atMaximum = !(expandsDown[index] && collapsesUp[index + 1]);
      if (besideHidden || (atMinimum && atMaximum)) {
        sash.state = SashState.Disabled;
      } else if (atMinimum) {
        sash.state = SashState.AtMinimum;
      } else if (atMaximum) {
        sash.state = SashState.AtMaximum;
      } else {
        sash.state = SashState.Enabled;
      }
    });
  }

  private createSash(): ISashItem {
    const sashPosition = (sash: Sash) => {
      const index = this.sashItems.findIndex(item => item.sash === sash);
      let position = 0;
      for (let i = 0; i <= index && i < this.viewItems.length; i++) {
        position += this.viewItems[i].size;
      }
      return position;
    };
    const orthogonalSize = this.getSashOrthogonalSize;
    const sash = this.orientation === Orientation.VERTICAL
      ? new Sash(this.sashContainer, {
        getHorizontalSashTop: sashPosition,
        getHorizontalSashWidth: orthogonalSize ? () => orthogonalSize() : undefined,
      }, { orientation: Orientation.HORIZONTAL })
      : new Sash(this.sashContainer, {
        getVerticalSashLeft: sashPosition,
        getVerticalSashHeight: orthogonalSize ? () => orthogonalSize() : undefined,
      }, { orientation: Orientation.VERTICAL });

    const listeners = [
      sash.onDidStart(event => this.onSashStart(sash, event)),
      sash.onDidChange(event => this.onSashChange(event)),
      sash.onDidEnd(() => this.onSashEnd()),
    ];
    return {
      sash,
      disposable: toDisposable(() => {
        dispose(listeners);
        sash.dispose();
      }),
    };
  }

  private areViewsDistributed(): boolean {
    let min: number | undefined;
    let max: number | undefined;
    for (const item of this.viewItems) {
      if (item.visible) {
        min = min === undefined ? item.size : Math.min(min, item.size);
        max = max === undefined ? item.size : Math.max(max, item.size);
      }
    }
    return min === undefined || max! - min <= 1;
  }

  private assertIdle(): void {
    if (this.layingOut) {
      throw new Error('A split view cannot add, remove or move views while it lays them out.');
    }
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.viewItems.length) {
      throw new RangeError(`No view at index ${index} of ${this.viewItems.length}.`);
    }
  }

  private sum(value: (item: ViewItem<TLayoutContext, TView>) => number): number {
    return this.viewItems.reduce((total, item) => total + value(item), 0);
  }

  private sumOf(indexes: readonly number[], value: (index: number) => number): number {
    return indexes.reduce((total, i) => total + value(i), 0);
  }

  override dispose(): void {
    // A drag in progress just stops: nobody is told about a split view that is going away.
    this.sashDragState = undefined;
    for (const item of this.viewItems) {
      item.dispose();
    }
    this.viewItems = [];
    for (const item of this.sashItems) {
      item.disposable.dispose();
    }
    this.sashItems = [];
    this.el.remove();
    super.dispose();
  }
}

/** `[start, end)` counting up, or down when `end < start`. */
function range(start: number, end?: number): number[] {
  if (end === undefined) {
    end = start;
    start = 0;
  }
  const result: number[] = [];
  if (start <= end) {
    for (let i = start; i < end; i++) {
      result.push(i);
    }
  } else {
    for (let i = start; i > end; i--) {
      result.push(i);
    }
  }
  return result;
}

function moveToStart(array: number[], value: number): void {
  const index = array.indexOf(value);
  if (index > 0) {
    array.splice(index, 1);
    array.unshift(value);
  }
}

function moveToEnd(array: number[], value: number): void {
  const index = array.indexOf(value);
  if (index >= 0 && index < array.length - 1) {
    array.splice(index, 1);
    array.push(value);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Sizes from callers and stored data: anything but a finite non-negative number becomes 0. */
function finiteSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
