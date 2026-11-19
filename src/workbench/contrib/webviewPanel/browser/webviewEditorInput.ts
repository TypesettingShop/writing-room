import { Emitter } from '../../../../base/common/event.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import type { WebviewContentOptions, WebviewIcon, WebviewPanelOptions } from '../../../api/common/extHost.protocol.webview.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IWebviewStateStore } from '../../webview/browser/webviewStateStore.js';
import type { WebviewOverlay } from '../../webview/browser/webviewOverlay.js';

const themeIconId = new RegExp('^' + ThemeIcon.iconIdExpression + '$');

/** Reads a theme icon from an extension call or a stored layout, keeping only the codicon id and color id. */
export function toWebviewThemeIcon(value: unknown): WebviewIcon | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const { id, color } = value as { readonly id?: unknown; readonly color?: unknown };
  if (typeof id !== 'string' || !themeIconId.test(id)) {
    return undefined;
  }
  const colorId = color && typeof color === 'object' ? (color as { readonly id?: unknown }).id : undefined;
  return typeof colorId === 'string' && /^[\w.-]+$/.test(colorId) ? { id, color: { id: colorId } } : { id };
}

export class WebviewEditorInput extends EditorInput {
  static readonly typeId = 'workbench.input.webviewPanel';
  readonly typeId = WebviewEditorInput.typeId;
  readonly resource: URI;
  private readonly tabIconChanged = this._register(new Emitter<void>());
  override readonly onDidChangeTabIcon = this.tabIconChanged.event;
  private icon: WebviewIcon | undefined;
  private storedIcon: WebviewIcon | undefined;
  private generation = 0;
  private restorePending = false;
  contentOptions: WebviewContentOptions = {};

  constructor(
    readonly id: string,
    readonly extensionId: string,
    readonly viewType: string,
    private title: string,
    readonly options: WebviewPanelOptions,
    readonly webview: WebviewOverlay,
    readonly persistent: boolean,
    @IWebviewStateStore states: IWebviewStateStore,
  ) {
    super();
    this.resource = URI.from({ scheme: Schemas.webviewPanel, path: id });
    this._register(webview);
    if (persistent) {
      this._register(this.onWillDispose(() => states.delete(id, extensionId)));
    }
  }

  get restoreGeneration(): number | undefined {
    return this.restorePending ? this.generation : undefined;
  }

  markForRestore(): void {
    this.generation++;
    this.restorePending = true;
    this.webview.resetForRestore();
  }

  completeRestore(generation: number, error?: string): void {
    if (this.restoreGeneration === generation && !this.isDisposed()) {
      this.restorePending = false;
      if (error) {
        this.webview.setError(error);
      }
    }
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

  override getTabIcon(): WebviewIcon | undefined {
    return this.icon;
  }

  get iconPath(): WebviewIcon | undefined {
    return this.icon;
  }

  get persistedIconPath(): WebviewIcon | undefined {
    return this.storedIcon ?? this.icon;
  }

  setStoredIconPath(icon: WebviewIcon | undefined): void {
    this.storedIcon = icon;
  }

  setIconPath(icon: WebviewIcon | undefined): void {
    this.storedIcon = undefined;
    if (this.icon !== icon) {
      this.icon = icon;
      this.tabIconChanged.fire();
    }
  }
}
