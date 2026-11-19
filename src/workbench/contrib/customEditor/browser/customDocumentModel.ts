import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';

/** What the extension's `CustomEditorProvider` does for a document; the main thread calls it in order. */
export interface ICustomDocumentBackend {
  undo(editId: number): Promise<void>;
  redo(editId: number): Promise<void>;
  save(): Promise<void>;
  saveAs(target: URI): Promise<void>;
  revert(): Promise<void>;
}

/** Dirty documents of custom editors; while there is one, the browser asks before the page goes. */
const dirtyDocuments = new Set<CustomDocumentModel>();
const beforeUnload = new MutableDisposable();

function updateBeforeUnload(): void {
  if (!dirtyDocuments.size) {
    beforeUnload.clear();
  } else if (!beforeUnload.value && typeof window !== 'undefined') {
    // Custom documents have no backups: leaving the page would lose the changes.
    beforeUnload.value = addDisposableListener(window, 'beforeunload', event => {
      event.preventDefault();
      event.returnValue = ' ';
    });
  }
}

/**
 * The main thread's side of a document of a `CustomReadonlyEditorProvider` or `CustomEditorProvider`,
 * one per `viewType` and resource, shared by its editors. It keeps the order of the extension's
 * edits and where the document was saved: undo and redo walk the edits, and a document is dirty when
 * it stands anywhere but at the save point, or after a change that has no undo.
 */
export class CustomDocumentModel extends Disposable {
  private readonly dirtyChanged = this._register(new Emitter<void>());
  readonly onDidChangeDirty: Event<void> = this.dirtyChanged.event;

  private edits: number[] = [];
  /** The last edit applied; -1 before the first. */
  private index = -1;
  /** `index` when the document was last saved or reverted; -2 once that point was cut off the history. */
  private savePoint = -1;
  private changedWithoutUndo = false;
  /** Undo, redo, save and revert one after another, in the order asked. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly viewType: string,
    readonly resource: URI,
    readonly editable: boolean,
    private readonly backend: ICustomDocumentBackend,
  ) {
    super();
  }

  isDirty(): boolean {
    return this.editable && (this.changedWithoutUndo || this.index !== this.savePoint);
  }

  get canUndo(): boolean {
    return this.index >= 0;
  }

  get canRedo(): boolean {
    return this.index < this.edits.length - 1;
  }

  /** The extension made an edit it can undo (`CustomDocumentEditEvent`). */
  acceptEdit(editId: number): void {
    this.change(() => {
      // What was undone is gone; a save point among it can no longer be reached.
      this.edits.splice(this.index + 1);
      if (this.savePoint > this.index) {
        this.savePoint = -2;
      }
      this.edits.push(editId);
      this.index++;
    });
  }

  /** The extension changed the document without an undo (`CustomDocumentContentChangeEvent`). */
  acceptContentChange(): void {
    this.change(() => { this.changedWithoutUndo = true; });
  }

  undo(): Promise<void> {
    return this.enqueue(async () => {
      if (this.index < 0) {
        return;
      }
      await this.backend.undo(this.edits[this.index]!);
      this.change(() => { this.index--; });
    });
  }

  redo(): Promise<void> {
    return this.enqueue(async () => {
      if (this.index >= this.edits.length - 1) {
        return;
      }
      await this.backend.redo(this.edits[this.index + 1]!);
      this.change(() => { this.index++; });
    });
  }

  /** Saves; it rejects with the extension's error, and the document stays dirty. */
  save(): Promise<void> {
    return this.enqueue(async () => {
      const at = this.index;
      await this.backend.save();
      this.change(() => {
        this.savePoint = at;
        this.changedWithoutUndo = false;
      });
    });
  }

  /** Writes the document to `target`; this document keeps its state, as its editor makes way for the target's. */
  saveAs(target: URI): Promise<void> {
    return this.enqueue(() => this.backend.saveAs(target));
  }

  /** Goes back to the saved document, forgetting the edits. */
  revert(): Promise<void> {
    return this.enqueue(async () => {
      await this.backend.revert();
      this.change(() => {
        this.edits = [];
        this.index = -1;
        this.savePoint = -1;
        this.changedWithoutUndo = false;
      });
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  private change(update: () => void): void {
    const before = this.isDirty();
    update();
    const after = this.isDirty();
    if (after && !this.isDisposed) {
      dirtyDocuments.add(this);
    } else {
      dirtyDocuments.delete(this);
    }
    updateBeforeUnload();
    if (before !== after) {
      this.dirtyChanged.fire();
    }
  }

  private isDisposed = false;

  override dispose(): void {
    this.isDisposed = true;
    dirtyDocuments.delete(this);
    updateBeforeUnload();
    super.dispose();
  }
}
