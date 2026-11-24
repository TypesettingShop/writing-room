import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
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
  private readonly inputListeners = this._register(new DisposableStore());
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
    this.clearInput();
    await super.setInput(input, options);
    if (this.input !== input || input.isDisposed() || !(input instanceof CharacterEditorInput)) {
      return;
    }
    this.card.scrollTop = 0;
    this.inputListeners.add(input.onDidChangeAvailability(() => this.showCard(input)));
    this.showCard(input);
  }

  override clearInput(): void {
    this.inputListeners.clear();
    this.form.clear();
    this.card.replaceChildren();
    super.clearInput();
  }

  private showCard(input: CharacterEditorInput): void {
    this.card.replaceChildren();
    const model = input.model;
    if (model) {
      const form = new CharacterCardForm(this.card, model, this.keybindings);
      this.form.value = form;
      void this.readTemplate(input.workId, form);
      return;
    }
    const document = this.card.ownerDocument;
    const status = this.card.appendChild(document.createElement('p'));
    status.className = 'character-card-status';
    status.setAttribute('role', 'status');
    status.textContent = input.availability === 'loading' ? 'Loading character…' : 'Could not load the character.';
    if (input.availability === 'unavailable') {
      const retry = this.card.appendChild(document.createElement('button'));
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => { void input.resolve(); }, { once: true });
    }
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
