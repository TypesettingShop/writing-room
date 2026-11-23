import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { ICharactersService } from '../../../services/characters/common/charactersService.js';
import { CharacterCardForm } from './characterCardForm.js';
import { CharacterEditorInput } from './characterEditorInput.js';
import './media/characterCard.css';

export class CharacterEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.character';

  private card!: HTMLElement;
  private readonly form = this._register(new MutableDisposable<CharacterCardForm>());
  private templateRequest = 0;

  constructor(
    @ICharactersService private readonly characters: ICharactersService,
    @IKeybindingService private readonly keybindings: IKeybindingService,
  ) {
    super(CharacterEditorPane.ID);
    this._register(characters.onDidChangeTemplate(workId => {
      if (this.input instanceof CharacterEditorInput && this.input.workId === workId && this.form.value) {
        void this.readTemplate(workId, this.form.value);
      }
    }));
  }

  protected createEditor(parent: HTMLElement): void {
    this.card = parent.appendChild(parent.ownerDocument.createElement('section'));
    this.card.className = 'character-card';
    this.card.tabIndex = -1;
    this.card.setAttribute('aria-label', 'Character card');
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    this.form.clear();
    await super.setInput(input, options);
    if (this.input !== input || input.isDisposed() || !(input instanceof CharacterEditorInput)) {
      return;
    }
    this.card.scrollTop = 0;
    const form = new CharacterCardForm(this.card, input.model, this.keybindings);
    this.form.value = form;
    void this.readTemplate(input.workId, form);
  }

  override clearInput(): void {
    this.form.clear();
    super.clearInput();
  }

  override layout(): void {}

  override focus(): void {
    this.card.focus();
  }

  private async readTemplate(workId: string, form: CharacterCardForm): Promise<void> {
    const request = ++this.templateRequest;
    try {
      const template = await this.characters.store.getTemplate(workId);
      if (this.form.value === form && this.templateRequest === request) {
        form.setTemplate(template.fields);
      }
    } catch {
      if (this.form.value === form && this.templateRequest === request) {
        form.showTemplateError();
      }
    }
  }
}
