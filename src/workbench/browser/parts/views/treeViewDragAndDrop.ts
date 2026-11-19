import { DragAndDropObserver } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ExtensionTreeViews, TreeDataSource } from '../../../api/browser/mainThreadTreeViews.js';
import type { DataTransferItemDto } from '../../../api/common/extHost.protocol.js';
import { DraggedTreeItems, isWorkbenchDrag, TreeDragAndDropObserver } from '../../dnd.js';

/** The most a file dragged in from the operating system may hold for `asFile()`. */
export const maxDroppedFileSize = 50 * 1024 * 1024;

let nextDrag = 0;

function treeType(view: string): string {
  return 'application/vnd.code.tree.' + view.toLowerCase();
}

function hasDragAndDrop(source: TreeDataSource | undefined): boolean {
  const options = source?.options;
  return !!options && (options.hasHandleDrag || options.hasHandleDrop || options.dragMimeTypes.length > 0 || options.dropMimeTypes.length > 0);
}

/**
 * Drags of one extension tree view's items and drops on it. A drag of tree items carries the
 * window's tree marker and session (`TreeDragAndDropObserver`), so the editor area and the view
 * containers do not take it; this view does not take theirs. What the source tree's `handleDrag`
 * fills stays in the extension host until the drag ends, and a drop on a tree of the same extension
 * gets those values themselves.
 */
export class TreeViewDragAndDrop extends Disposable {
  private readonly observer = TreeDragAndDropObserver.INSTANCE;
  /** The drags this view started and the cancellation of their `handleDrag`. */
  private readonly started = new Map<string, { readonly cancellation: CancellationTokenSource; readonly source: TreeDataSource }>();
  private highlighted: HTMLElement | undefined;

  constructor(
    private readonly viewId: string,
    private readonly content: HTMLElement,
    private readonly views: ExtensionTreeViews,
    /** The handle of the row an element is in, or `undefined` for the empty part of the view. */
    private readonly handleAt: (target: EventTarget | null) => { readonly handle: string; readonly row: HTMLElement } | undefined,
    /** The handles a drag from `handle` takes: the selection when it holds the row, else the row. */
    private readonly draggedHandles: (handle: string) => readonly string[],
  ) {
    super();
    this._register(this.observer.onDidEndDrag(({ item, dropped }) => {
      this.highlight(undefined);
      const started = this.started.get(item.drag);
      if (started) {
        this.started.delete(item.drag);
        if (!dropped) {
          started.cancellation.dispose(true);
          started.source.releaseDrag?.(item.drag);
        } else {
          started.cancellation.dispose();
        }
      }
    }));
    this._register(new DragAndDropObserver(content, {
      onDragOver: event => this.onDragOver(event),
      onDragLeave: () => this.highlight(undefined),
      onDrop: event => void this.onDrop(event),
    }));
    this._register(toDisposable(() => this.sourceChanged()));
  }

  private get source(): TreeDataSource | undefined {
    return this.views.get(this.viewId);
  }

  /** Lets `row` be dragged when the tree has a drag and drop controller. */
  makeDraggable(row: HTMLElement, handle: string): void {
    const source = this.source;
    if (!source || !hasDragAndDrop(source)) {
      return;
    }
    row.draggable = true;
    row.addEventListener('dragstart', event => {
      if (event.target !== row || !source.extension) {
        return;
      }
      const handles = this.draggedHandles(handle);
      const drag = this.viewId + ':' + ++nextDrag;
      const cancellation = new CancellationTokenSource();
      const data = source.options?.hasHandleDrag && source.handleDrag
        ? source.handleDrag(handles, drag, cancellation.token).catch(() => [])
        : Promise.resolve([]);
      this.started.set(drag, { cancellation, source });
      this.observer.startDrag(event, row, new DraggedTreeItems(this.viewId, source.extension, handles, drag,
        [treeType(this.viewId), ...source.options?.dragMimeTypes ?? []], data));
    });
  }

  /** Ends the drags of a provider that went away, and releases what their host kept. */
  sourceChanged(): void {
    for (const [drag, { source }] of [...this.started]) {
      if (source !== this.source) {
        this.observer.endDrag(false);
        if (this.started.has(drag)) {
          this.started.delete(drag);
          source.releaseDrag?.(drag);
        }
      }
    }
    this.highlight(undefined);
  }

  private accepts(event: DragEvent): boolean {
    const source = this.source;
    const options = source?.options;
    if (!source || !options?.hasHandleDrop || !event.dataTransfer) {
      return false;
    }
    const item = this.observer.getDraggedItem(event, this.content);
    if (item) {
      return item.view === this.viewId || item.mimeTypes.some(type => options.dropMimeTypes.includes(type));
    }
    const types = [...event.dataTransfer.types].map(type => type.toLowerCase());
    // A tree drag without its session belongs to no live drag; the workbench's own drags are never a tree's.
    if (types.includes('application/x-writing-room-tree') || isWorkbenchDrag(event)) {
      return false;
    }
    const files = [...event.dataTransfer.items].filter(entry => entry.kind === 'file');
    return types.some(type => type !== 'files' && options.dropMimeTypes.includes(type))
      || files.some(file => options.dropMimeTypes.includes('files') || options.dropMimeTypes.includes(file.type.toLowerCase()));
  }

  private onDragOver(event: DragEvent): void {
    if (!this.accepts(event)) {
      this.highlight(undefined);
      return;
    }
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
    this.highlight(this.handleAt(event.target)?.row ?? this.content);
  }

  private async onDrop(event: DragEvent): Promise<void> {
    this.highlight(undefined);
    const source = this.source;
    if (!this.accepts(event) || !source?.handleDrop || !source.options) {
      return;
    }
    event.preventDefault();
    const { dropMimeTypes } = source.options;
    const target = this.handleAt(event.target)?.handle;
    const item = this.observer.getDraggedItem(event, this.content);
    const items: DataTransferItemDto[] = [];
    let drag: string | undefined;
    const files: { readonly type: string; readonly file: File }[] = [];
    if (item) {
      // The drop is read now; the session ends with it.
      this.observer.endDrag(true);
      items.push({ mimeType: treeType(item.view), value: JSON.stringify({ id: item.view, itemHandles: item.handles }) });
      const sameExtension = item.extension === source.extension;
      drag = sameExtension ? item.drag : undefined;
      for (const entry of await item.data) {
        if (sameExtension || dropMimeTypes.includes(entry.mimeType)) {
          items.push({ mimeType: entry.mimeType, value: entry.value });
        }
      }
    } else {
      const transfer = event.dataTransfer!;
      for (const type of transfer.types) {
        const mimeType = type.toLowerCase();
        if (mimeType !== 'files' && dropMimeTypes.includes(mimeType)) {
          items.push({ mimeType, value: transfer.getData(type) });
        }
      }
      for (const file of transfer.files) {
        const type = file.type.toLowerCase() || 'application/octet-stream';
        if (dropMimeTypes.includes('files') || dropMimeTypes.includes(type)) {
          files.push({ type, file });
        }
      }
    }
    for (const { type, file } of files) {
      const data = file.size <= maxDroppedFileSize ? new Uint8Array(await file.arrayBuffer()) : undefined;
      items.push({ mimeType: type, value: '', file: { name: file.name, data } });
    }
    const cancellation = new CancellationTokenSource();
    try {
      await source.handleDrop(target, items, drag, cancellation.token);
    } catch (error) {
      console.error(error);
    } finally {
      cancellation.dispose();
      if (item) {
        this.views.get(item.view)?.releaseDrag?.(item.drag);
      }
    }
  }

  private highlight(element: HTMLElement | undefined): void {
    if (this.highlighted !== element) {
      this.highlighted?.classList.remove('drop-target');
      this.highlighted = element;
      element?.classList.add('drop-target');
    }
  }
}

