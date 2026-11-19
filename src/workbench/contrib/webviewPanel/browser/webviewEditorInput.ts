import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import type { WebviewIcon, WebviewPanelOptions } from '../../../api/common/extHost.protocol.webview.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import type { WebviewOverlay } from '../../webview/browser/webviewOverlay.js';

export class WebviewEditorInput extends EditorInput {
  static readonly typeId = 'workbench.input.webviewPanel';
  readonly typeId = WebviewEditorInput.typeId;
  readonly resource: URI;
  private icon: WebviewIcon | undefined;

  constructor(
    readonly id: string,
    readonly extensionId: string,
    readonly viewType: string,
    private title: string,
    readonly options: WebviewPanelOptions,
    readonly webview: WebviewOverlay,
  ) {
    super();
    this.resource = URI.from({ scheme: Schemas.webviewPanel, path: id });
    this._register(webview);
  }

  override getName(): string {
    return this.title;
  }

  override isReadonly(): boolean {
    return true;
  }

  setTitle(title: string): void {
    if (this.title !== title) {
      this.title = title;
      this._onDidChangeLabel.fire();
    }
  }

  get iconPath(): WebviewIcon | undefined {
    return this.icon;
  }

  setIconPath(icon: WebviewIcon | undefined): void {
    this.icon = icon;
    this._onDidChangeLabel.fire();
  }
}
