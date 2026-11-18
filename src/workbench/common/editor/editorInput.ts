import { Emitter } from '../../../base/common/event.js';
import type { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';

/**
 * What is open in an editor. An input names its content and owns whatever holds it (a text model,
 * say); an `EditorPane` shows it. Panes are reused, so nothing that belongs to one editor lives in a
 * pane — it lives here or in the model the input resolves to.
 */
export abstract class EditorInput extends Disposable {
  protected readonly _onDidChangeDirty = this._register(new Emitter<void>());
  readonly onDidChangeDirty: Event<void> = this._onDidChangeDirty.event;

  protected readonly _onDidChangeLabel = this._register(new Emitter<void>());
  readonly onDidChangeLabel: Event<void> = this._onDidChangeLabel.event;

  private readonly _onWillDispose = this._register(new Emitter<void>());
  /** Fires once, before the input releases what it owns, so a pane can let go of it first. */
  readonly onWillDispose: Event<void> = this._onWillDispose.event;

  private disposed = false;

  /** The kind of input. The editor pane registry maps it to the pane that shows the input. */
  abstract get typeId(): string;

  abstract get resource(): URI | undefined;

  getName(): string {
    return `Editor ${this.typeId}`;
  }

  isDirty(): boolean {
    return false;
  }

  /**
   * Loads what the input shows. Text inputs resolve to an `ITextEditorModel`. The input owns the
   * result; callers must not dispose it.
   */
  async resolve(): Promise<IDisposable | null> {
    return null;
  }

  /** Whether `other` opens the same thing, so a group shows it once. */
  matches(other: EditorInput): boolean {
    return this === other;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  override dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this._onWillDispose.fire();
    }
    super.dispose();
  }
}
