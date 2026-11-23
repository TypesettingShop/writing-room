import { $, addDisposableListener, append, type Dimension } from '../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { CharacterTemplateEditorInput } from './characterTemplateEditorInput.js';
import { CharacterTemplateFieldList } from './characterTemplateFieldList.js';
import './media/characterCard.css';
import './media/characterTemplate.css';

export class CharacterTemplateEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.characterTemplatePane';

  private readonly inputListeners = this._register(new DisposableStore());
  private readonly fieldList = this._register(new MutableDisposable<CharacterTemplateFieldList>());
  private page!: HTMLElement;
  private status!: HTMLElement;
  private problem!: HTMLElement;
  private reload!: HTMLButtonElement;
  private overwrite!: HTMLButtonElement;
  private content!: HTMLDivElement;

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {
    super(CharacterTemplateEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.page = append(parent, $('section.character-template', { 'aria-label': 'Field Template', tabindex: -1 }));
    append(this.page, $('h1', null, 'Field Template'));
    this.status = append(this.page, $('p.character-template-status', { role: 'status' }));
    this.problem = append(this.page, $('p.character-template-problem', { role: 'alert', hidden: true }));
    const actions = append(this.page, $('.character-template-actions'));
    this.reload = append(actions, $('button', { type: 'button', hidden: true }));
    this.overwrite = append(actions, $('button', { type: 'button', hidden: true }, 'Overwrite Saved Template'));
    this.content = append(this.page, $('div', { class: 'character-template-content' }));
    this.bindRecoveryAction(this.reload, input => input.reload());
    this.bindRecoveryAction(this.overwrite, input => input.overwrite());
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    if (this.input !== input) {
      this.inputListeners.clear();
      this.fieldList.clear();
    }
    const setting = super.setInput(input, options);
    if (input instanceof CharacterTemplateEditorInput) {
      if (!this.fieldList.value) {
        this.inputListeners.add(input.onDidChangeState(() => this.render(input)));
        this.fieldList.value = this.instantiation.createInstance(CharacterTemplateFieldList, this.content, input);
      }
      this.render(input);
      await input.resolve();
    }
    await setting;
  }

  override clearInput(): void {
    this.inputListeners.clear();
    this.fieldList.clear();
    super.clearInput();
    this.status.textContent = '';
    this.problem.hidden = this.reload.hidden = this.overwrite.hidden = true;
  }

  override layout(dimension: Dimension): void {
    this.page.style.width = `${dimension.width}px`;
    this.page.style.height = `${dimension.height}px`;
  }

  override focus(): void {
    this.page.focus({ preventScroll: true });
  }

  private bindRecoveryAction(
    button: HTMLButtonElement, run: (input: CharacterTemplateEditorInput) => Promise<unknown>,
  ): void {
    this._register(addDisposableListener(button, 'click', async () => {
      const input = this.input;
      if (input instanceof CharacterTemplateEditorInput) {
        const document = this.page.ownerDocument;
        const restoreFocus = button === document.activeElement;
        await run(input);
        if (restoreFocus && this.input === input && button.hidden && document.activeElement === document.body) {
          this.focus();
        }
      }
    }));
  }

  private render(input: CharacterTemplateEditorInput): void {
    this.status.textContent = input.isSaving ? 'Saving…'
      : input.isDirty() ? 'Unsaved changes'
      : input.fields ? 'Saved'
      : input.hasReadError ? '' : 'Loading fields…';
    const message = input.hasConflict
      ? input.hasReadError
        ? 'The field template changed. The saved version could not be loaded. Your draft is still open.'
        : 'The field template changed. Reload the saved version or replace it with your draft.'
      : input.hasReadError ? 'Could not load the field template.' : '';
    this.problem.hidden = !message;
    if (this.problem.textContent !== message) {
      this.problem.textContent = message;
    }
    this.reload.hidden = !message;
    this.reload.disabled = input.isSaving;
    this.reload.textContent = input.hasConflict ? 'Discard Draft and Reload' : 'Retry';
    this.overwrite.hidden = !input.hasConflict || input.hasReadError;
    this.overwrite.disabled = !input.canOverwrite;
  }
}
