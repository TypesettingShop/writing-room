import { addDisposableListener } from '../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { WorldItemCardForm } from './worldItemCardForm.js';
import { WorldItemEditorInput } from './worldItemEditorInput.js';
import './media/worldItemCard.css';

export class WorldItemEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.worldItem';
  private card!: HTMLElement;
  private readonly form = this._register(new MutableDisposable<WorldItemCardForm>());
  private readonly inputListeners = this._register(new DisposableStore());
  private readonly retry = this._register(new MutableDisposable());

  constructor(
    @IKeybindingService private readonly keybindings: IKeybindingService,
    @ICommandService private readonly commands: ICommandService,
  ) {
    super(WorldItemEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.card = parent.appendChild(parent.ownerDocument.createElement('section'));
    this.card.className = 'world-item-card';
    this.card.tabIndex = -1;
    this.card.setAttribute('aria-label', 'Item card');
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    this.clearInput();
    await super.setInput(input, options);
    if (this.input !== input || input.isDisposed() || !(input instanceof WorldItemEditorInput)) {
      return;
    }
    this.card.scrollTop = 0;
    this.inputListeners.add(input.onDidChangePresentation(() => {
      if (!this.form.value) {
        this.showCard(input);
      }
    }));
    this.showCard(input);
  }

  override clearInput(): void {
    this.inputListeners.clear();
    this.retry.clear();
    this.form.clear();
    this.card.replaceChildren();
    super.clearInput();
  }

  private showCard(input: WorldItemEditorInput): void {
    this.retry.clear();
    this.card.replaceChildren();
    if (input.model) {
      this.form.value = new WorldItemCardForm(this.card, input, input.model, this.keybindings, this.commands);
      return;
    }
    const document = this.card.ownerDocument;
    const status = this.card.appendChild(document.createElement('p'));
    status.setAttribute('role', 'status');
    status.textContent = input.availability === 'loading' ? 'Loading item…'
      : input.availability === 'missing' ? 'Item deleted' : 'Could not load the item.';
    if (input.availability === 'unavailable') {
      const retry = this.card.appendChild(document.createElement('button'));
      retry.type = 'button';
      retry.textContent = 'Retry';
      this.retry.value = addDisposableListener(retry, 'click', () => { void input.resolve(); });
    }
  }

  override layout(): void {}
  override focus(): void { this.card.focus(); }
}
