import { $, append } from '../../../../../base/browser/dom.js';
import type { Dimension } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { ErrorPlaceholderEditorPane } from '../../../../browser/parts/editor/editorPlaceholder.js';
import { TextEditorPane } from '../../../../browser/parts/editor/textEditor.js';
import type { EditorInput } from '../../../../common/editor/editorInput.js';
import { ErrorEditorInput } from '../../../../common/editor/errorEditorInput.js';
import { TextFileOperationError, TextFileOperationResult } from '../../../../services/textfile/common/textfiles.js';
import type { IStandaloneCodeEditor } from '../../../../../editor/browser/monaco.js';

/** Why a file is not in the text editor, in VS Code's words. */
export function describeFileOpenError(error: unknown): string {
  if (error instanceof TextFileOperationError) {
    switch (error.textFileOperationResult) {
      case TextFileOperationResult.FILE_IS_BINARY:
        return 'the file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.';
      case TextFileOperationResult.FILE_TOO_LARGE:
        return 'the file is not displayed in the text editor because it is larger than 20 MB.';
      case TextFileOperationResult.FILE_NOT_FOUND:
        return 'the file was not found.';
      case TextFileOperationResult.FILE_IS_DIRECTORY:
        return 'the resource is a folder, not a file.';
    }
  }
  return error instanceof Error && error.message ? error.message : 'the file could not be read.';
}

/**
 * The editor of files, `workbench.editors.files.textFileEditor`. It shows the file in the text editor
 * pane, which it holds; a file that cannot be text (binary, too large, missing) shows why in the
 * error pane instead, never an empty editor. A read-only file cannot be typed into.
 */
export class TextFileEditor extends EditorPane {
  static readonly ID = 'workbench.editors.files.textFileEditor';

  private textContainer!: HTMLElement;
  private errorContainer!: HTMLElement;
  private textPane!: TextEditorPane;
  private errorPane!: ErrorPlaceholderEditorPane;
  /** The input the error pane stands for, while it shows. */
  private readonly errorInput = this._register(new MutableDisposable<ErrorEditorInput>());
  /** Keeps the editor read-only while the shown file is. */
  private readonly readonlyListener = this._register(new MutableDisposable());
  /** Increases with every `setInput` and `clearInput`; an older load's outcome is dropped. */
  private request = 0;
  private readonly controlChanged = this._register(new Emitter<void>());
  readonly onDidChangeControl = this.controlChanged.event;

  constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
    super(TextFileEditor.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.textContainer = append(parent, $('.file-text-editor'));
    this.errorContainer = append(parent, $('.file-error-editor', { hidden: '' }));
    this.textPane = this._register(this.instantiationService.createInstance(TextEditorPane));
    this.textPane.create(this.textContainer);
    this.errorPane = this._register(new ErrorPlaceholderEditorPane());
    this.errorPane.create(this.errorContainer);
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    // Recorded at once, as the text pane does, so a newer call cannot slip in before this one.
    void super.setInput(input, options);
    const request = ++this.request;
    this.readonlyListener.clear();
    this.hideError();
    // The text pane loads the input itself; the same resolve says whether it can be text.
    const shown = this.textPane.setInput(input, options);
    let failure: unknown;
    try {
      await input.resolve();
    } catch (error) {
      failure = error ?? new Error('The file could not be read.');
    }
    if (request !== this.request) {
      await shown;
      return;
    }
    if (failure !== undefined) {
      this.textPane.clearInput();
      await this.showError(input, failure);
      if (request === this.request) this.controlChanged.fire();
      return;
    }
    await shown;
    if (request === this.request) {
      const update = () => this.textPane.getControl()?.updateOptions({ readOnly: input.isReadonly() });
      update();
      this.readonlyListener.value = input.onDidChangeLabel(update);
      this.controlChanged.fire();
    }
  }

  override clearInput(): void {
    this.request++;
    this.readonlyListener.clear();
    this.hideError();
    this.textPane.clearInput();
    super.clearInput();
    this.controlChanged.fire();
  }

  override layout(dimension: Dimension): void {
    const created = !this.textPane.getControl();
    for (const container of [this.textContainer, this.errorContainer]) {
      container.style.width = `${dimension.width}px`;
      container.style.height = `${dimension.height}px`;
    }
    this.textPane.layout(dimension);
    this.errorPane.layout(dimension);
    // The Monaco editor is made at the first real size, without knowing the input.
    const control = this.getControl();
    if (created && control && this.input) {
      if (this.readonlyListener.value) control.updateOptions({ readOnly: this.input.isReadonly() });
      this.controlChanged.fire();
    }
  }

  override focus(): void {
    if (this.errorInput.value) {
      this.errorPane.focus();
    } else {
      this.textPane.focus();
    }
  }

  override getViewState(input?: EditorInput): object | undefined {
    return this.textPane.getViewState(input);
  }

  override get scopedContextKeyService(): IContextKeyService | undefined {
    return this.textPane.scopedContextKeyService;
  }

  /**
   * The code editor this pane shows the file in, as VS Code's text file editor gives it: none while
   * the error pane stands for a file that cannot be text. Extensions see the file editor through it.
   */
  getControl(): IStandaloneCodeEditor | undefined {
    return this.errorInput.value ? undefined : this.textPane.getControl();
  }

  /** The text pane, which holds the Monaco editor. */
  get textEditorPane(): TextEditorPane {
    return this.textPane;
  }

  private async showError(input: EditorInput, error: unknown): Promise<void> {
    const errorInput = new ErrorEditorInput(input.resource!, describeFileOpenError(error));
    this.errorInput.value = errorInput;
    this.textContainer.hidden = true;
    this.errorContainer.hidden = false;
    await this.errorPane.setInput(errorInput, undefined);
  }

  private hideError(): void {
    if (this.errorInput.value) {
      this.errorPane.clearInput();
      this.errorInput.clear();
    }
    this.errorContainer.hidden = true;
    this.textContainer.hidden = false;
  }

  override dispose(): void {
    this.request++;
    super.dispose();
    this.textContainer?.remove();
    this.errorContainer?.remove();
  }
}
