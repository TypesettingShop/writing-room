import type { ISerializableView, IViewSize, LayoutPriority } from '../../base/browser/ui/grid/grid.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import type { Parts } from '../services/layout/browser/layoutService.js';

export abstract class Part extends Disposable implements ISerializableView {
  readonly minimumWidth: number = 0;
  readonly maximumWidth: number = Infinity;
  readonly minimumHeight: number = 0;
  readonly maximumHeight: number = Infinity;
  readonly priority?: LayoutPriority;
  readonly onDidChange: Event<IViewSize | undefined> = Event.None;

  private readonly didLayout = this._register(new Emitter<IViewSize>());
  readonly onDidLayout = this.didLayout.event;
  protected visible = true;
  element!: HTMLElement;

  constructor(readonly id: Parts) {
    super();
  }

  create(parent: HTMLElement): void {
    this.element = parent;
    this.createContentArea(parent);
  }

  protected createContentArea(_parent: HTMLElement): void {}

  layout(width: number, height: number, _top: number, _left: number): void {
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    this.didLayout.fire({ width, height });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.element.hidden = !visible;
  }

  toJSON(): { type: Parts } {
    return { type: this.id };
  }
}
