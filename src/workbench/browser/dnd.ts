import { addDisposableListener, DragAndDropObserver } from '../../base/browser/dom.js';
import { Emitter } from '../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import { LocalSelectionTransfer } from '../../platform/dnd/browser/dnd.js';
import type { GroupIdentifier, IEditorIdentifier } from '../common/editor.js';

const compositeMime = 'application/x-writing-room-view-container';
const editorMime = 'application/x-writing-room-editor';
/** The marker type of a drag of extension tree items. */
export const treeMime = 'application/x-writing-room-tree';
const manuscriptMime = 'application/x-writing-room-manuscript';
const charactersMime = 'application/x-writing-room-characters';

/**
 * Native drops leave the payload available through the target's synchronous handling.
 * A removed source can miss dragend, so also recover on trusted pointer input that
 * confirms release, or on the start of a new native drag. Wayland blur can occur
 * during a valid drag and Firefox can still deliver pointer movement with the button down.
 */
function trackDragSession(session: DisposableStore, source: HTMLElement, end: () => void): void {
  const window = source.ownerDocument.defaultView!;
  session.add(addDisposableListener(source, 'dragend', end));
  session.add(addDisposableListener(window, 'pagehide', end));
  session.add(addDisposableListener(window, 'drop', () => {
    const timer = window.setTimeout(end, 0);
    session.add(toDisposable(() => window.clearTimeout(timer)));
  }, true));
  const finishOrphaned = (event: PointerEvent) => {
    if (!source.isConnected && event.isTrusted && event.isPrimary && (event.buttons & 1) === 0) {
      end();
    }
  };
  session.add(addDisposableListener(window, 'pointerup', finishOrphaned, true));
  session.add(addDisposableListener(window, 'pointermove', finishOrphaned, true));
  session.add(addDisposableListener(window, 'dragstart', event => {
    if (!source.isConnected && event.isTrusted) {
      end();
    }
  }, true));
  session.add(addDisposableListener(window, 'keydown', event => {
    if (event.key === 'Escape') {
      end();
    }
  }, true));
}

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
      trackDragSession(this.session, element, () => this.finish());
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
    const accept = (event: DragEvent) => {
      const item = this.getItem(element, event);
      if (item && target.onDragOver(event, item)) {
        event.preventDefault();
        event.dataTransfer!.dropEffect = 'move';
      } else {
        target.onDragLeave();
      }
    };
    // The browser can release before the next dragover. Recheck descendant entries too,
    // since the pointer may have moved from a refused insertion point to an allowed one.
    registrations.add(addDisposableListener(element, 'dragenter', accept));
    const observer = registrations.add(new DragAndDropObserver(element, {
      onDragOver: accept,
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

  /** A view container drag is going on. */
  get isDragging(): boolean {
    return !!this.source;
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
  /** Fires once when the drag ends: drop, `dragend`, Escape or `pagehide`. */
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
    // The source may leave the document on drop (its tab moved away), so the drop target ends
    // the session too; these catch every other way out.
    trackDragSession(this.session, source, () => this.endDrag());
  }

  /** An editor or group drag is going on. */
  get isDragging(): boolean {
    return !!this.source;
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

// --- extension tree items

/** The items of an extension's tree view one drag carries, and what the tree's `handleDrag` adds to it. */
export class DraggedTreeItems {
  constructor(
    readonly view: string,
    readonly extension: string,
    readonly handles: readonly string[],
    /** Names this drag in the extension host, which keeps the values `handleDrag` put in until it ends. */
    readonly drag: string,
    /** The drag's own types: the tree's `application/vnd.code.tree.<view>` and its `dragMimeTypes`. */
    readonly mimeTypes: readonly string[],
    /** The strings of what `handleDrag` put in, for a tree of another extension. */
    readonly data: Promise<readonly { readonly mimeType: string; readonly value: string }[]>,
  ) {}
}

/**
 * The one tree item drag of the window, kept apart from editor and view container drags by its own
 * marker type and session: the editor area and the view containers do not take it, and a tree does not
 * take theirs. The session ends however the drag ends.
 */
export class TreeDragAndDropObserver {
  static readonly INSTANCE = new TreeDragAndDropObserver();

  private readonly transfer = LocalSelectionTransfer.getInstance<DraggedTreeItems>();
  private readonly _onDidEndDrag = new Emitter<{ readonly item: DraggedTreeItems; readonly dropped: boolean }>();
  /** Fires once when the drag ends; `dropped` when a tree took it. */
  readonly onDidEndDrag = this._onDidEndDrag.event;
  private readonly session = new DisposableStore();
  private source: HTMLElement | undefined;
  private item: DraggedTreeItems | undefined;

  private constructor() {}

  /** Starts a drag of `item` from `source`, from inside its `dragstart` listener. */
  startDrag(event: DragEvent, source: HTMLElement, item: DraggedTreeItems): void {
    this.endDrag(false);
    this.source = source;
    this.item = item;
    this.transfer.setData([item], DraggedTreeItems.prototype);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copyMove';
      // The marker's value is not empty, so every browser starts the drag with it.
      event.dataTransfer.setData(treeMime, item.view);
      for (const type of item.mimeTypes) {
        event.dataTransfer.setData(type, '');
      }
    }
    trackDragSession(this.session, source, () => this.endDrag(false));
  }

  /** The tree items this drag carries, if it is ours and still going. */
  getDraggedItem(event: DragEvent, element: HTMLElement): DraggedTreeItems | undefined {
    if (this.item && this.source?.ownerDocument === element.ownerDocument && event.dataTransfer?.types.includes(treeMime)) {
      return this.transfer.getData(DraggedTreeItems.prototype)?.[0];
    }
    return undefined;
  }

  /** Ends the drag; a tree that took the drop says so with `dropped`. */
  endDrag(dropped: boolean): void {
    const item = this.item;
    if (item) {
      this.source = undefined;
      this.item = undefined;
      this.transfer.clearData(DraggedTreeItems.prototype);
      this.session.clear();
      this._onDidEndDrag.fire({ item, dropped });
    }
  }
}

export interface DraggedNavigatorItems {
  readonly workId: string;
  readonly nodeIds: readonly string[];
}

/** The marker is the only native payload. Work and node ids stay in the source document. */
export class NavigatorDragAndDropObserver {
  private readonly session = new DisposableStore();
  private readonly dragEnded = new Emitter<void>();
  readonly onDidEndDrag = this.dragEnded.event;
  private active: { readonly source: HTMLElement; readonly item: DraggedNavigatorItems } | undefined;

  constructor(private readonly mime: string) {}

  startDrag(event: DragEvent, source: HTMLElement, item: DraggedNavigatorItems): void {
    const transfer = event.dataTransfer;
    if (!transfer || event.defaultPrevented || !item.nodeIds.length) {
      return;
    }
    this.endDrag();
    this.active = { source, item: { workId: item.workId, nodeIds: [...item.nodeIds] } };
    transfer.effectAllowed = 'copyMove';
    transfer.setData(this.mime, '1');
    trackDragSession(this.session, source, () => this.endDrag());
  }

  getDraggedItems(event: DragEvent, element: HTMLElement): DraggedNavigatorItems | undefined {
    if (this.active?.source.ownerDocument === element.ownerDocument && event.dataTransfer?.types.includes(this.mime)) {
      return this.active.item;
    }
    return undefined;
  }

  get isDragging(): boolean {
    return !!this.active;
  }

  isSource(element: HTMLElement): boolean {
    return this.active?.source === element;
  }

  endDrag(): void {
    if (this.active) {
      this.active = undefined;
      this.session.clear();
      this.dragEnded.fire();
    }
  }
}

export type DraggedManuscriptItems = DraggedNavigatorItems;

export class ManuscriptDragAndDropObserver extends NavigatorDragAndDropObserver {
  static readonly INSTANCE = new ManuscriptDragAndDropObserver();

  private constructor() { super(manuscriptMime); }
}

export class CharactersDragAndDropObserver extends NavigatorDragAndDropObserver {
  static readonly INSTANCE = new CharactersDragAndDropObserver();

  private constructor() { super(charactersMime); }
}

/**
 * Whether the drag is one of the workbench's own that a tree view must not take: an editor, an editor
 * group, a view container or a core navigator row.
 */
export function isWorkbenchDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? [];
  return types.includes(editorMime) || types.includes(compositeMime) || types.includes(manuscriptMime) || types.includes(charactersMime)
    || EditorDragAndDropObserver.INSTANCE.isDragging || CompositeDragAndDropObserver.INSTANCE.isDragging
    || ManuscriptDragAndDropObserver.INSTANCE.isDragging || CharactersDragAndDropObserver.INSTANCE.isDragging;
}
