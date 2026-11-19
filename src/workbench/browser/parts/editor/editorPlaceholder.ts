import { $, append } from '../../../../base/browser/dom.js';
import type { Dimension } from '../../../../base/browser/dom.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { ErrorEditorInput } from '../../../common/editor/errorEditorInput.js';
import { EditorPane } from './editorPane.js';
import './media/editorPlaceholder.css';

/** Shows why an `ErrorEditorInput`'s resource could not be opened. */
export class ErrorPlaceholderEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.errorEditor';

  private page!: HTMLElement;
  private message!: HTMLElement;

  constructor() {
    super(ErrorPlaceholderEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.page = append(parent, $('.editor-placeholder', { tabindex: -1 }));
    this.message = append(this.page, $('.editor-placeholder-message', { role: 'alert' }));
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    await super.setInput(input, options);
    this.message.textContent = input instanceof ErrorEditorInput
      ? `The editor could not be opened: ${input.message}`
      : 'The editor could not be opened.';
  }

  override clearInput(): void {
    this.message.textContent = '';
    super.clearInput();
  }

  override layout(dimension: Dimension): void {
    this.page.style.width = `${dimension.width}px`;
    this.page.style.height = `${dimension.height}px`;
  }

  override focus(): void {
    this.page.focus({ preventScroll: true });
  }

  override dispose(): void {
    super.dispose();
    this.page?.remove();
  }
}
