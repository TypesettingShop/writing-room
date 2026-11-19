import type { Dimension } from '../../../../base/browser/dom.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { WebviewEditorInput } from './webviewEditorInput.js';

export class WebviewEditor extends EditorPane {
  static readonly id = 'workbench.editors.webviewPanel';
  private readonly focusListener = this._register(new MutableDisposable<IDisposable>());
  private anchor!: HTMLElement;
  private dimensions: Dimension | undefined;

  constructor(@IEditorGroupsService private readonly groups: IEditorGroupsService) {
    super(WebviewEditor.id);
  }

  protected createEditor(parent: HTMLElement): void {
    this.anchor = parent.ownerDocument.createElement('div');
    this.anchor.tabIndex = -1;
    this.anchor.className = 'webview-editor-anchor';
    this.anchor.style.cssText = 'width:100%;height:100%';
    parent.append(this.anchor);
  }

  override async setInput(input: WebviewEditorInput, options: IEditorOptions | undefined): Promise<void> {
    if (this.input === input) {
      return super.setInput(input, options);
    }
    this.clearInput();
    const updated = super.setInput(input, options);
    input.webview.show(this.anchor, this.dimensions);
    this.focusListener.value = input.webview.onDidFocus(() => {
      const group = this.groups.groups.find(group => group.element.contains(this.anchor));
      if (group && group.activeEditor === input) {
        this.groups.activateGroup(group);
      }
    });
    await updated;
  }

  override clearInput(): void {
    this.focusListener.clear();
    (this.input as WebviewEditorInput | undefined)?.webview.hide(this.anchor);
    super.clearInput();
  }

  layout(dimension: Dimension): void {
    this.dimensions = dimension;
    (this.input as WebviewEditorInput | undefined)?.webview.layout(this.anchor, dimension);
  }

  override focus(): void {
    (this.input as WebviewEditorInput | undefined)?.webview.focus();
  }

  override dispose(): void {
    this.clearInput();
    super.dispose();
  }
}
