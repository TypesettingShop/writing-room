import { Emitter } from '../../../base/common/event.js';
import type { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { ThemeIcon } from '../../../base/common/themables.js';
import type { URI } from '../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../platform/editor/common/editor.js';
import type { GroupIdentifier, IEditorIdentifier } from '../editor.js';

/** The answer to "this editor has changes: close it anyway?". */
export enum ConfirmResult {
  SAVE,
  DONT_SAVE,
  CANCEL,
}

/**
 * Lets an input ask before it closes. A group asks only when the editor would leave the last group
 * that shows it.
 */
export interface IEditorCloseHandler {
  /** Whether closing now needs an answer, such as while there are unsaved changes. */
  showConfirm(): boolean;
  /** Asks about `editors`, all of this input's kind. Only `CANCEL` keeps them open. */
  confirm(editors: readonly IEditorIdentifier[]): Promise<ConfirmResult>;
}

export interface ISaveOptions {
  /** Why the save happens; `explicit` for the save command. */
  readonly reason?: 'explicit' | 'auto';
}

export interface IRevertOptions {
  /** Revert without reading the saved state again, as before a close that discards changes. */
  readonly soft?: boolean;
}

/** Tab images use resource URIs that the input has authorized for display. */
export type TabIcon = URI | { readonly light: URI; readonly dark: URI }
  | (ThemeIcon & { readonly color?: { readonly id: string } });

/**
 * What is open in an editor. An input names its content and owns whatever holds it (a text model,
 * say); an `EditorPane` shows it. Panes are reused, so nothing that belongs to one editor lives in a
 * pane — it lives here or in the model the input resolves to.
 *
 * Other areas tell inputs apart by `resource` and, for webview and custom editors, a `viewType`
 * property, never by class, so they need not import each other's inputs.
 */
export abstract class EditorInput extends Disposable {
  protected readonly _onDidChangeDirty = this._register(new Emitter<void>());
  readonly onDidChangeDirty: Event<void> = this._onDidChangeDirty.event;

  protected readonly _onDidChangeLabel = this._register(new Emitter<void>());
  readonly onDidChangeLabel: Event<void> = this._onDidChangeLabel.event;

  readonly onDidChangeTabIcon?: Event<void>;

  private readonly _onWillDispose = this._register(new Emitter<void>());
  /** Fires once, before the input releases what it owns, so a pane can let go of it first. */
  readonly onWillDispose: Event<void> = this._onWillDispose.event;

  private disposed = false;

  /** Set by an input that asks before it closes. By default nothing asks. */
  readonly closeHandler?: IEditorCloseHandler;

  /** The kind of input. The editor pane registry maps it to the pane that shows the input. */
  abstract get typeId(): string;

  abstract get resource(): URI | undefined;

  getName(): string {
    return `Editor ${this.typeId}`;
  }

  /** A longer line about the editor, such as its folder; nothing by default. */
  getDescription(): string | undefined {
    return undefined;
  }

  /** What a tab's tooltip shows, such as the whole path; the name by default. */
  getTitle(): string {
    return this.getName();
  }

  getTabIcon(): TabIcon | undefined {
    return undefined;
  }

  isDirty(): boolean {
    return false;
  }

  isReadonly(): boolean {
    return false;
  }

  /**
   * Saves the input. It resolves to what now stands for the saved editor: this input, another input,
   * or a resource for the editor resolver to open (an untitled text saved to a file names the file)
   * — or to `undefined` when it did not save, failed or cancelled, which the input has told the user
   * about itself. `IEditorService.save` puts what it resolves to in the editor's place.
   */
  async save(_group: GroupIdentifier, _options?: ISaveOptions): Promise<EditorInput | IResourceEditorInput | undefined> {
    return this;
  }

  /** Saves under a resource the user picks. Like `save` unless the input knows more. */
  saveAs(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IResourceEditorInput | undefined> {
    return this.save(group, options);
  }

  /** Drops unsaved changes. */
  async revert(_group: GroupIdentifier, _options?: IRevertOptions): Promise<void> {}

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
