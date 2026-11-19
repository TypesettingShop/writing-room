import type * as vscode from 'vscode';
import { raceCancellation } from '../../../base/common/async.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import type { WebviewOrigin } from '../../contrib/webview/common/webviewOrigin.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { ExtHostCustomEditorsProxy, MainThreadCustomEditorsProxy } from './extHost.protocol.customEditor.js';
import type {
  CustomTextEditorResolveData, ExtHostCustomEditorsShape, MainThreadCustomEditorsShape,
} from './extHost.protocol.customEditor.js';
import type { WebviewPanelViewState, WebviewShowOptions } from './extHost.protocol.webview.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import type { ExtHostDocuments } from './extHostDocuments.js';
import { Disposable } from './extHostTypes.js';
import { ExtHostWebview } from './extHostWebview.js';
import type { SendWebviewCall } from './extHostWebview.js';

/**
 * The panel a custom editor's provider fills. The workbench owns the editor: the tab names the
 * resource, so `title` and `iconPath` are kept here only; `dispose()` closes the editor.
 */
class CustomEditorPanel implements vscode.WebviewPanel {
  readonly #viewChanged = new Emitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
  readonly #closed = new Emitter<void>();
  readonly onDidChangeViewState = this.#viewChanged.event;
  readonly onDidDispose = this.#closed.event;
  readonly #reveal: (show: WebviewShowOptions) => Promise<void>;
  readonly #close: () => void;
  #state: WebviewPanelViewState;
  #disposed = false;
  title: string;
  iconPath: vscode.IconPath | undefined;

  constructor(
    readonly viewType: string, title: string, readonly webview: ExtHostWebview, readonly options: vscode.WebviewPanelOptions,
    state: WebviewPanelViewState, reveal: (show: WebviewShowOptions) => Promise<void>, close: () => void,
  ) {
    this.title = title;
    this.#state = state;
    this.#reveal = reveal;
    this.#close = close;
  }

  get visible(): boolean { return this.#state.visible; }
  get active(): boolean { return this.#state.active; }
  get viewColumn(): vscode.ViewColumn | undefined { return this.#state.viewColumn; }

  reveal(viewColumn?: vscode.ViewColumn, preserveFocus?: boolean): void {
    this.#checkLive();
    void this.#reveal({ viewColumn, preserveFocus }).catch(console.error);
  }

  acceptViewState(state: WebviewPanelViewState): void {
    const before = this.#state;
    if (!this.#disposed && (before.active !== state.active || before.visible !== state.visible || before.viewColumn !== state.viewColumn)) {
      this.#state = state;
      this.#viewChanged.fire({ webviewPanel: this });
    }
  }

  dispose(): void {
    if (!this.#disposed) {
      this.#close();
    }
  }

  acceptDisposed(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#closed.fire();
    this.#closed.dispose();
    this.#viewChanged.dispose();
    this.webview.dispose();
  }

  #checkLive(): void {
    if (this.#disposed) {
      throw new Error('Webview panel is disposed.');
    }
  }
}

interface ProviderEntry {
  readonly extension: string;
  readonly provider: vscode.CustomTextEditorProvider;
  readonly ready: Promise<void>;
}

interface EditorEntry {
  readonly extension: string;
  readonly panel: CustomEditorPanel;
}

function contributes(extension: HostExtensionDescription, viewType: string): boolean {
  const editors = extension.manifest.contributes?.customEditors;
  return Array.isArray(editors) && editors.some(entry => typeof entry === 'object' && entry !== null
    && (entry as { viewType?: unknown }).viewType === viewType);
}

export class ExtHostCustomEditors implements ExtHostCustomEditorsShape {
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly editors = new Map<string, EditorEntry>();

  constructor(private readonly proxy: MainThreadCustomEditorsShape, private readonly documents: ExtHostDocuments) {}

  registerProvider(
    extension: HostExtensionDescription, viewType: string,
    provider: vscode.CustomTextEditorProvider | vscode.CustomReadonlyEditorProvider | vscode.CustomEditorProvider,
    options: { readonly webviewOptions?: vscode.WebviewPanelOptions; readonly supportsMultipleEditorsPerDocument?: boolean } = {},
  ): vscode.Disposable {
    if (typeof viewType !== 'string' || !viewType) {
      throw new TypeError('A custom editor viewType must be a non-empty string.');
    }
    if (!provider || typeof provider !== 'object') {
      throw new TypeError('A custom editor provider must be an object.');
    }
    if (typeof (provider as vscode.CustomTextEditorProvider).resolveCustomTextEditor !== 'function') {
      throw new Error('Only CustomTextEditorProvider is supported: the provider has no resolveCustomTextEditor.');
    }
    if (!contributes(extension, viewType)) {
      throw new Error(`The custom editor '${viewType}' is not contributed by ${extension.id}.`);
    }
    if (this.providers.has(viewType)) {
      throw new Error(`A custom editor provider is already registered for '${viewType}'.`);
    }
    const webviewOptions = Object.freeze({
      enableFindWidget: options.webviewOptions?.enableFindWidget === true,
      retainContextWhenHidden: options.webviewOptions?.retainContextWhenHidden === true,
    });
    const entry: ProviderEntry = {
      extension: extension.key, provider: provider as vscode.CustomTextEditorProvider,
      ready: this.proxy.$registerTextEditorProvider(extension.key, viewType, webviewOptions,
        options.supportsMultipleEditorsPerDocument === true),
    };
    this.providers.set(viewType, entry);
    void entry.ready.catch(error => {
      if (this.providers.get(viewType) === entry) {
        this.providers.delete(viewType);
      }
      console.error(`Could not register the custom editor provider for '${viewType}':`, error);
    });
    return new Disposable(() => this.unregister(viewType, entry));
  }

  private unregister(viewType: string, entry: ProviderEntry): void {
    if (this.providers.get(viewType) === entry) {
      this.providers.delete(viewType);
      // Sent now, so it precedes a registration for the same type made right after.
      void this.proxy.$unregisterProvider(entry.extension, viewType).catch(() => {});
    }
  }

  /** Waits for the registrations of `extension`, so an activation reports them to the workbench first. */
  async flush(extension: string): Promise<void> {
    await Promise.all([...this.providers.values()].filter(entry => entry.extension === extension)
      .map(entry => entry.ready.catch(() => {})));
  }

  async $resolveTextEditor(
    extension: string, handle: string, data: CustomTextEditorResolveData, origin: WebviewOrigin, token: CancellationToken,
  ): Promise<void> {
    const entry = this.providers.get(data.viewType);
    if (!entry || entry.extension !== extension) {
      throw new Error(`No custom editor provider is registered for '${data.viewType}'.`);
    }
    if (this.editors.has(handle)) {
      throw new Error('The custom editor is already resolved.');
    }
    const document = this.documents.get(data.documentId);
    if (!document || document.uri.toString() !== URI.revive(data.resource).toString()
      || !this.documents.canRead(extension, document)) {
      throw new Error('The text document of the custom editor is unavailable.');
    }
    if (token.isCancellationRequested) {
      return;
    }
    const send: SendWebviewCall = (call, fallback) => this.editors.has(handle) ? call() : Promise.resolve(fallback);
    const webview = new ExtHostWebview(origin, data.contentOptions as vscode.WebviewOptions, send, this.proxy, extension, handle);
    const panel = new CustomEditorPanel(data.viewType, data.title, webview, data.options, data.viewState,
      show => send(() => this.proxy.$reveal(extension, handle, show), undefined),
      () => {
        if (this.drop(extension, handle)) {
          void this.proxy.$disposeEditor(extension, handle).catch(() => {});
        }
      });
    this.editors.set(handle, { extension, panel });
    try {
      await raceCancellation(Promise.resolve(entry.provider.resolveCustomTextEditor(document, panel, token)), token);
    } catch (error) {
      this.drop(extension, handle);
      throw error;
    }
    if (token.isCancellationRequested) {
      this.drop(extension, handle);
    }
  }

  async $onMessage(extension: string, handle: string, message: unknown): Promise<void> {
    this.lookup(extension, handle)?.panel.webview.acceptMessage(message);
  }

  async $onViewState(extension: string, handle: string, state: WebviewPanelViewState): Promise<void> {
    this.lookup(extension, handle)?.panel.acceptViewState(state);
  }

  async $onDisposed(extension: string, handle: string): Promise<void> {
    this.drop(extension, handle);
  }

  /** The extension is going: its editors' panels close and its providers leave the workbench. */
  release(extension: string): void {
    for (const [viewType, entry] of this.providers) {
      if (entry.extension === extension) {
        this.unregister(viewType, entry);
      }
    }
    for (const [handle, entry] of this.editors) {
      if (entry.extension === extension) {
        this.drop(extension, handle);
      }
    }
  }

  dispose(): void {
    this.providers.clear();
    for (const [handle, { extension }] of this.editors) {
      this.drop(extension, handle);
    }
  }

  private lookup(extension: string, handle: string): EditorEntry | undefined {
    const entry = this.editors.get(handle);
    return entry?.extension === extension ? entry : undefined;
  }

  private drop(extension: string, handle: string): boolean {
    const entry = this.lookup(extension, handle);
    if (!entry) {
      return false;
    }
    this.editors.delete(handle);
    entry.panel.acceptDisposed();
    return true;
  }
}

extHostApiRegistry.register('customEditors', ({ rpc, getService }) => {
  const editors = new ExtHostCustomEditors(rpc.getProxy(MainThreadCustomEditorsProxy), getService<ExtHostDocuments>('documents'));
  rpc.set(ExtHostCustomEditorsProxy, editors);
  return {
    service: editors,
    create: extension => ({
      namespaces: {
        window: {
          registerCustomEditorProvider: (viewType, provider, options) => editors.registerProvider(extension, viewType, provider, options),
        } satisfies Pick<typeof vscode.window, 'registerCustomEditorProvider'>,
      },
    }),
    flush: key => editors.flush(key),
    release: key => editors.release(key),
    dispose: () => editors.dispose(),
  };
});
