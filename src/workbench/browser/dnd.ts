import { addDisposableListener, DragAndDropObserver } from '../../base/browser/dom.js';
import { Emitter } from '../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import { LocalSelectionTransfer } from '../../platform/dnd/browser/dnd.js';
import type { GroupIdentifier, IEditorIdentifier } from '../common/editor.js';

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

// --- editors and editor groups

const editorMime = 'application/x-writing-room-editor';

export class DraggedEditorIdentifier {
  constructor(readonly identifier: IEditorIdentifier) {}
}

export class DraggedEditorGroupIdentifier {
  constructor(readonly identifier: GroupIdentifier) {}
}

export type DraggedEditorItem = DraggedEditorIdentifier | DraggedEditorGroupIdentifier;

/**
 * The one editor or editor group drag of the window. The payload lives in `LocalSelectionTransfer`
 * because `dragover` cannot read `dataTransfer`; the session ends however the drag ends, so a stale
 * payload never makes a later, unrelated drag act on an editor.
 */
export class EditorDragAndDropObserver {
  static readonly INSTANCE = new EditorDragAndDropObserver();

  private readonly transfer = LocalSelectionTransfer.getInstance<DraggedEditorItem>();
  private readonly _onDidEndDrag = new Emitter<void>();
  /** Fires once when the drag ends: drop, `dragend`, Escape, blur or page hide. */
  readonly onDidEndDrag = this._onDidEndDrag.event;
  private readonly session = new DisposableStore();
  private source: HTMLElement | undefined;
  private type: object | undefined;

  private constructor() {}

  /** Starts a drag of `item` from `source`, from inside its `dragstart` listener. */
  startDrag(event: DragEvent, source: HTMLElement, item: DraggedEditorItem, label: string): void {
    this.endDrag();
    this.source = source;
    this.type = Object.getPrototypeOf(item) as object;
    this.transfer.setData([item], this.type);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Firefox starts a drag only with data in it; the marker type tells our drags from others.
      event.dataTransfer.setData('text/plain', label);
      event.dataTransfer.setData(editorMime, '');
    }
    const window = source.ownerDocument.defaultView!;
    // The source may leave the document on drop (its tab moved away), so the drop target ends
    // the session too; these catch every other way out.
    this.session.add(addDisposableListener(source, 'dragend', () => this.endDrag()));
    this.session.add(addDisposableListener(window, 'pagehide', () => this.endDrag()));
    this.session.add(addDisposableListener(window, 'blur', () => this.endDrag()));
    this.session.add(addDisposableListener(window, 'keydown', keyEvent => {
      if (keyEvent.key === 'Escape') {
        this.endDrag();
      }
    }, true));
  }

  /** The editor or group this drag carries, if it is ours and still going. */
  getDraggedItem(event: DragEvent, element: HTMLElement): DraggedEditorItem | undefined {
    if (this.type && this.source?.ownerDocument === element.ownerDocument && event.dataTransfer?.types.includes(editorMime)) {
      return this.transfer.getData(this.type)?.[0];
    }
    return undefined;
  }

  endDrag(): void {
    if (this.source) {
      this.source = undefined;
      this.transfer.clearData(this.type!);
      this.type = undefined;
      this.session.clear();
      this._onDidEndDrag.fire();
    }
  }
}
