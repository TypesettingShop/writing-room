import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { CharacterEditorInput } from './characterEditorInput.js';

export class CharacterEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.character';

  private card!: HTMLElement;
  private readonly inputListeners = this._register(new DisposableStore());

  constructor() {
    super(CharacterEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.card = parent.appendChild(parent.ownerDocument.createElement('section'));
    this.card.className = 'character-card';
    this.card.tabIndex = -1;
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    this.inputListeners.clear();
    await super.setInput(input, options);
    if (this.input !== input || !(input instanceof CharacterEditorInput)) {
      return;
    }
    const render = () => {
      const title = this.card.ownerDocument.createElement('h1');
      const icon = input.getTabIcon();
      const image = renderIcon(icon);
      if (image) {
        title.append(image, ' ');
      }
      title.append(input.getName());
      const detail = this.card.ownerDocument.createElement('p');
      detail.textContent = input.deleted ? `${icon.label} · Character deleted` : icon.label;
      this.card.replaceChildren(title, detail);
    };
    render();
    this.inputListeners.add(input.onDidChangeCharacter(render));
  }

  override clearInput(): void {
    this.inputListeners.clear();
    this.card.replaceChildren();
    super.clearInput();
  }

  override layout(): void {}

  override focus(): void {
    this.card.focus();
  }
}
