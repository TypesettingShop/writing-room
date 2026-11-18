import { addDisposableListener, $ } from '../../dom.js';
import { Emitter } from '../../../common/event.js';
import type { Event } from '../../../common/event.js';
import { Disposable, DisposableStore } from '../../../common/lifecycle.js';
import './sash.css';

/**
 * An object's own direction. A `VERTICAL` sash is an upright strip that moves left and right;
 * a `VERTICAL` split view stacks its views top to bottom, so its sashes are `HORIZONTAL`.
 */
export enum Orientation {
  VERTICAL,
  HORIZONTAL,
}

export enum SashState {
  /** Neither side can change size, so the sash ignores the pointer. */
  Disabled,
  /** The sash can only move towards the end (right or down). */
  AtMinimum,
  /** The sash can only move towards the start (left or up). */
  AtMaximum,
  Enabled,
}

export interface ISashEvent {
  readonly startX: number;
  readonly currentX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly altKey: boolean;
}

/** Places an upright sash: its centre line, and optionally its top and height. */
export interface IVerticalSashLayoutProvider {
  getVerticalSashLeft(sash: Sash): number;
  getVerticalSashTop?(sash: Sash): number;
  getVerticalSashHeight?(sash: Sash): number;
}

/** Places a lying sash: its centre line, and optionally its left and width. */
export interface IHorizontalSashLayoutProvider {
  getHorizontalSashTop(sash: Sash): number;
  getHorizontalSashLeft?(sash: Sash): number;
  getHorizontalSashWidth?(sash: Sash): number;
}

export interface ISashOptions {
  readonly orientation: Orientation;
  /** Thickness in pixels. Defaults to {@link Sash.size}. */
  readonly size?: number;
}

type SashLayoutProvider = IVerticalSashLayoutProvider | IHorizontalSashLayoutProvider;

/**
 * A thin strip centred on the boundary between two views that reports pointer drags.
 * It moves nothing itself: the owner listens to the three events and resizes its views.
 */
export class Sash extends Disposable {
  /** Thickness of every sash, `globalSize` in VS Code. */
  static readonly size = 4;

  readonly el: HTMLElement;
  readonly orientation: Orientation;
  private readonly sashSize: number;
  private readonly layoutProvider: SashLayoutProvider;
  private readonly dragListeners = this._register(new DisposableStore());
  private _state = SashState.Enabled;
  private dragging = false;

  private readonly _onDidStart = this._register(new Emitter<ISashEvent>());
  readonly onDidStart: Event<ISashEvent> = this._onDidStart.event;
  private readonly _onDidChange = this._register(new Emitter<ISashEvent>());
  readonly onDidChange: Event<ISashEvent> = this._onDidChange.event;
  private readonly _onDidEnd = this._register(new Emitter<void>());
  readonly onDidEnd: Event<void> = this._onDidEnd.event;

  private readonly _onDidEnablementChange = this._register(new Emitter<SashState>());
  readonly onDidEnablementChange: Event<SashState> = this._onDidEnablementChange.event;

  constructor(container: HTMLElement, layoutProvider: IVerticalSashLayoutProvider, options: ISashOptions & { orientation: Orientation.VERTICAL });
  constructor(container: HTMLElement, layoutProvider: IHorizontalSashLayoutProvider, options: ISashOptions & { orientation: Orientation.HORIZONTAL });
  constructor(container: HTMLElement, layoutProvider: SashLayoutProvider, options: ISashOptions) {
    super();
    this.orientation = options.orientation;
    this.sashSize = options.size ?? Sash.size;
    this.layoutProvider = layoutProvider;
    this.el = $('.monaco-sash');
    this.el.classList.add(this.orientation === Orientation.VERTICAL ? 'vertical' : 'horizontal');
    container.append(this.el);
    this._register({ dispose: () => this.el.remove() });
    this._register(addDisposableListener(this.el, 'pointerdown', event => this.onPointerDown(event)));
    this.updateStateClass();
  }

  get state(): SashState {
    return this._state;
  }

  set state(state: SashState) {
    if (this._state === state) {
      return;
    }
    this._state = state;
    this.updateStateClass();
    if (state === SashState.Disabled && this.dragging) {
      this.endDrag();
    }
    this._onDidEnablementChange.fire(state);
  }

  /** Puts the strip on its boundary. Every coordinate comes from the layout provider. */
  layout(): void {
    const style = this.el.style;
    const half = this.sashSize / 2;
    if (this.orientation === Orientation.VERTICAL) {
      const provider = this.layoutProvider as IVerticalSashLayoutProvider;
      style.left = px(provider.getVerticalSashLeft(this) - half);
      style.width = px(this.sashSize);
      style.top = provider.getVerticalSashTop ? px(provider.getVerticalSashTop(this)) : '';
      style.height = provider.getVerticalSashHeight ? px(provider.getVerticalSashHeight(this)) : '';
    } else {
      const provider = this.layoutProvider as IHorizontalSashLayoutProvider;
      style.top = px(provider.getHorizontalSashTop(this) - half);
      style.height = px(this.sashSize);
      style.left = provider.getHorizontalSashLeft ? px(provider.getHorizontalSashLeft(this)) : '';
      style.width = provider.getHorizontalSashWidth ? px(provider.getHorizontalSashWidth(this)) : '';
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this._state === SashState.Disabled || this.dragging) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const altKey = event.altKey;
    const toEvent = (current: PointerEvent): ISashEvent => ({
      startX, startY, currentX: current.clientX, currentY: current.clientY, altKey,
    });

    // Capture keeps the stream of moves on the sash however fast the pointer leaves it.
    if (typeof this.el.setPointerCapture === 'function') {
      try {
        this.el.setPointerCapture(pointerId);
      } catch {
        // A synthetic or already-released pointer cannot be captured; the drag still works over the strip.
      }
    }
    this.dragging = true;
    this.el.classList.add('active');
    this.el.ownerDocument.body.classList.add(
      this.orientation === Orientation.VERTICAL ? 'monaco-sash-dragging-vertical' : 'monaco-sash-dragging-horizontal',
    );

    const isOurs = (e: PointerEvent) => e.pointerId === pointerId;
    this.dragListeners.add(addDisposableListener(this.el, 'pointermove', (e: PointerEvent) => {
      if (isOurs(e)) {
        e.preventDefault();
        this._onDidChange.fire(toEvent(e));
      }
    }));
    const finish = (e: PointerEvent) => {
      if (isOurs(e)) {
        this.endDrag();
      }
    };
    this.dragListeners.add(addDisposableListener(this.el, 'pointerup', finish));
    this.dragListeners.add(addDisposableListener(this.el, 'pointercancel', finish));
    this.dragListeners.add(addDisposableListener(this.el, 'lostpointercapture', finish));
    this.dragListeners.add({
      dispose: () => {
        if (typeof this.el.hasPointerCapture === 'function' && this.el.hasPointerCapture(pointerId)) {
          this.el.releasePointerCapture(pointerId);
        }
      },
    });

    this._onDidStart.fire(toEvent(event));
  }

  private endDrag(notify = true): void {
    if (!this.dragging) {
      return;
    }
    this.dragging = false;
    this.el.classList.remove('active');
    this.el.ownerDocument.body.classList.remove('monaco-sash-dragging-vertical', 'monaco-sash-dragging-horizontal');
    this.dragListeners.clear();
    if (notify) {
      this._onDidEnd.fire();
    }
  }

  private updateStateClass(): void {
    this.el.classList.toggle('disabled', this._state === SashState.Disabled);
    this.el.classList.toggle('minimum', this._state === SashState.AtMinimum);
    this.el.classList.toggle('maximum', this._state === SashState.AtMaximum);
  }

  override dispose(): void {
    // The owner is going away; it must not be asked to finish a resize while it disposes.
    this.endDrag(false);
    super.dispose();
  }
}

function px(value: number): string {
  return `${value}px`;
}
