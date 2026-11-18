import { addDisposableListener, DragAndDropObserver } from '../../base/browser/dom.js';
import { Emitter } from '../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import { LocalSelectionTransfer } from '../../platform/dnd/browser/dnd.js';

const compositeMime = 'application/x-writing-room-view-container';

export class DraggedCompositeIdentifier {
  constructor(readonly id: string) {}
}

interface CompositeDropTarget {
  onDragOver(event: DragEvent, item: DraggedCompositeIdentifier): boolean;
  onDrop(event: DragEvent, item: DraggedCompositeIdentifier): void;
  onDragLeave(): void;
}

export class CompositeDragAndDropObserver {
  static readonly INSTANCE = new CompositeDragAndDropObserver();

  private readonly transfer = LocalSelectionTransfer.getInstance<DraggedCompositeIdentifier>();
  private readonly dragEnded = new Emitter<void>();
  private readonly session = new DisposableStore();
  private source: HTMLElement | undefined;

  private constructor() {}

  registerDraggable(element: HTMLElement, getItem: () => DraggedCompositeIdentifier | undefined): IDisposable {
    const registrations = new DisposableStore();
    const wasDraggable = element.draggable;
    element.draggable = true;
    registrations.add(addDisposableListener(element, 'dragstart', event => {
      if (event.target !== element || !event.dataTransfer) {
        return;
      }
      const item = getItem();
      if (!item || event.defaultPrevented) {
        event.preventDefault();
        return;
      }
      this.finish();
      this.source = element;
      this.transfer.setData([item], DraggedCompositeIdentifier.prototype);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(compositeMime, '');
      const window = element.ownerDocument.defaultView!;
      this.session.add(addDisposableListener(element, 'dragend', () => this.finish()));
      this.session.add(addDisposableListener(window, 'pagehide', () => this.finish()));
      this.session.add(addDisposableListener(window, 'blur', () => this.finish()));
      this.session.add(addDisposableListener(window, 'keydown', event => {
        if (event.key === 'Escape') {
          this.finish();
        }
      }, true));
    }));
    registrations.add(toDisposable(() => {
      element.draggable = wasDraggable;
      if (this.source === element) {
        this.finish();
      }
    }));
    return registrations;
  }

  registerTarget(element: HTMLElement, target: CompositeDropTarget): IDisposable {
    const registrations = new DisposableStore();
    const observer = registrations.add(new DragAndDropObserver(element, {
      onDragOver: event => {
        const item = this.getItem(element, event);
        if (item && target.onDragOver(event, item)) {
          event.preventDefault();
          event.dataTransfer!.dropEffect = 'move';
        } else {
          target.onDragLeave();
        }
      },
      onDragLeave: () => target.onDragLeave(),
      onDrop: event => {
        const item = this.getItem(element, event);
        if (item && target.onDragOver(event, item)) {
          event.preventDefault();
          this.finish();
          target.onDrop(event, item);
        }
      },
    }));
    registrations.add(this.dragEnded.event(() => {
      observer.reset();
      target.onDragLeave();
    }));
    registrations.add(toDisposable(() => target.onDragLeave()));
    return registrations;
  }

  private getItem(element: HTMLElement, event: DragEvent): DraggedCompositeIdentifier | undefined {
    if (this.source?.ownerDocument === element.ownerDocument && event.dataTransfer?.types.includes(compositeMime)) {
      return this.transfer.getData(DraggedCompositeIdentifier.prototype)?.[0];
    }
    return undefined;
  }

  private finish(): void {
    if (this.source) {
      this.source = undefined;
      this.transfer.clearData(DraggedCompositeIdentifier.prototype);
      this.session.clear();
      this.dragEnded.fire();
    }
  }
}
