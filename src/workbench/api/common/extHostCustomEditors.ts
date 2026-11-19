import type * as vscode from 'vscode';
import { raceCancellation } from '../../../base/common/async.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import type { WebviewOrigin } from '../../contrib/webview/common/webviewOrigin.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { ExtHostCustomEditorsProxy, MainThreadCustomEditorsProxy } from './extHost.protocol.customEditor.js';
import type {
  CustomEditorResolveData, CustomTextEditorResolveData, ExtHostCustomEditorsShape, MainThreadCustomEditorsShape,
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

type ProviderEntry = {
  readonly extension: string;
  readonly ready: Promise<void>;
  readonly listener?: vscode.Disposable;
} & ({ readonly kind: 'text'; readonly provider: vscode.CustomTextEditorProvider }
  | { readonly kind: 'custom'; readonly provider: vscode.CustomReadonlyEditorProvider | vscode.CustomEditorProvider });

interface DocumentEntry {
  readonly extension: string;
  readonly viewType: string;
  readonly document: vscode.CustomDocument;
  /** The provider's undoable edits, by the id the main thread knows them by. */
  readonly edits: Map<number, vscode.CustomDocumentEditEvent>;
}

function documentKey(viewType: string, resource: URI): string {
  return JSON.stringify([viewType, resource.toString()]);
}

function isEditable(provider: object): provider is vscode.CustomEditorProvider {
  const candidate = provider as Partial<vscode.CustomEditorProvider>;
  return typeof candidate.onDidChangeCustomDocument === 'function' && typeof candidate.saveCustomDocument === 'function'
    && typeof candidate.saveCustomDocumentAs === 'function' && typeof candidate.revertCustomDocument === 'function';
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
  private readonly documentEntries = new Map<string, DocumentEntry>();
  private nextEdit = 0;

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
    const text = typeof (provider as vscode.CustomTextEditorProvider).resolveCustomTextEditor === 'function';
    const custom = typeof (provider as vscode.CustomReadonlyEditorProvider).openCustomDocument === 'function'
      && typeof (provider as vscode.CustomReadonlyEditorProvider).resolveCustomEditor === 'function';
    if (!text && !custom) {
      throw new TypeError('A custom editor provider needs resolveCustomTextEditor, or openCustomDocument and resolveCustomEditor.');
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
    const multiple = options.supportsMultipleEditorsPerDocument === true;
    let entry: ProviderEntry;
    if (text) {
      entry = {
        kind: 'text', extension: extension.key, provider: provider as vscode.CustomTextEditorProvider,
        ready: this.proxy.$registerTextEditorProvider(extension.key, viewType, webviewOptions, multiple),
      };
    } else {
      const editable = isEditable(provider);
      entry = {
        kind: 'custom', extension: extension.key, provider: provider as vscode.CustomReadonlyEditorProvider,
        ready: this.proxy.$registerCustomEditorProvider(extension.key, viewType, webviewOptions, multiple, editable),
        listener: editable ? provider.onDidChangeCustomDocument(event => this.acceptChange(viewType, event)) : undefined,
      };
    }
    this.providers.set(viewType, entry);
    void entry.ready.catch(error => {
      if (this.providers.get(viewType) === entry) {
        this.providers.delete(viewType);
        entry.listener?.dispose();
      }
      console.error(`Could not register the custom editor provider for '${viewType}':`, error);
    });
    return new Disposable(() => this.unregister(viewType, entry));
  }

  private unregister(viewType: string, entry: ProviderEntry): void {
    if (this.providers.get(viewType) === entry) {
      this.providers.delete(viewType);
      entry.listener?.dispose();
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
    const entry = this.provider(extension, data.viewType, 'text');
    const document = this.documents.get(data.documentId);
    if (!document || document.uri.toString() !== URI.revive(data.resource).toString()
      || !this.documents.canRead(extension, document)) {
      throw new Error('The text document of the custom editor is unavailable.');
    }
    await this.resolvePanel(extension, handle, data, origin, token,
      panel => entry.provider.resolveCustomTextEditor(document, panel, token));
  }

  async $resolveCustomEditor(
    extension: string, handle: string, data: CustomEditorResolveData, origin: WebviewOrigin, token: CancellationToken,
  ): Promise<void> {
    const entry = this.provider(extension, data.viewType, 'custom');
    const document = this.documentEntries.get(documentKey(data.viewType, URI.revive(data.resource)));
    if (!document || document.extension !== extension) {
      throw new Error('The custom document is unavailable.');
    }
    await this.resolvePanel(extension, handle, data, origin, token,
      panel => entry.provider.resolveCustomEditor(document.document, panel, token));
  }

  private provider<K extends ProviderEntry['kind']>(extension: string, viewType: string, kind: K): Extract<ProviderEntry, { kind: K }> {
    const entry = this.providers.get(viewType);
    if (!entry || entry.extension !== extension || entry.kind !== kind) {
      throw new Error(`No custom editor provider is registered for '${viewType}'.`);
    }
    return entry as Extract<ProviderEntry, { kind: K }>;
  }

  private async resolvePanel(
    extension: string, handle: string, data: CustomEditorResolveData, origin: WebviewOrigin, token: CancellationToken,
    resolve: (panel: CustomEditorPanel) => Thenable<void> | void,
  ): Promise<void> {
    if (this.editors.has(handle)) {
      throw new Error('The custom editor is already resolved.');
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
      await raceCancellation(Promise.resolve(resolve(panel)), token);
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

  async $createCustomDocument(extension: string, viewType: string, resource: URI, token: CancellationToken): Promise<void> {
    const entry = this.provider(extension, viewType, 'custom');
    const uri = URI.revive(resource);
    const key = documentKey(viewType, uri);
    if (this.documentEntries.has(key)) {
      throw new Error('The custom document is already open.');
    }
    const document = await entry.provider.openCustomDocument(uri as vscode.Uri, { backupId: undefined, untitledDocumentData: undefined }, token);
    if (!document || typeof document !== 'object' || typeof document.dispose !== 'function') {
      throw new TypeError('openCustomDocument must return a CustomDocument.');
    }
    // A provider that went meanwhile, or a request cancelled meanwhile, gets the document back at once.
    if (this.providers.get(viewType) !== entry || token.isCancellationRequested) {
      document.dispose();
      throw new Error('The custom document was not opened.');
    }
    this.documentEntries.set(key, { extension, viewType, document, edits: new Map() });
  }

  async $disposeCustomDocument(extension: string, viewType: string, resource: URI): Promise<void> {
    const key = documentKey(viewType, URI.revive(resource));
    const entry = this.documentEntries.get(key);
    if (entry?.extension === extension) {
      this.documentEntries.delete(key);
      entry.document.dispose();
    }
  }

  async $undo(extension: string, viewType: string, resource: URI, editId: number): Promise<void> {
    await this.lookupEdit(extension, viewType, resource, editId).undo();
  }

  async $redo(extension: string, viewType: string, resource: URI, editId: number): Promise<void> {
    await this.lookupEdit(extension, viewType, resource, editId).redo();
  }

  async $save(extension: string, viewType: string, resource: URI, token: CancellationToken): Promise<void> {
    const { provider, document } = this.editableDocument(extension, viewType, resource);
    await provider.saveCustomDocument(document.document, token);
  }

  async $saveAs(extension: string, viewType: string, resource: URI, target: URI, token: CancellationToken): Promise<void> {
    const { provider, document } = this.editableDocument(extension, viewType, resource);
    await provider.saveCustomDocumentAs(document.document, URI.revive(target) as vscode.Uri, token);
  }

  async $revert(extension: string, viewType: string, resource: URI, token: CancellationToken): Promise<void> {
    const { provider, document } = this.editableDocument(extension, viewType, resource);
    await provider.revertCustomDocument(document.document, token);
    document.edits.clear();
  }

  private editableDocument(extension: string, viewType: string, resource: URI) {
    const entry = this.provider(extension, viewType, 'custom');
    const document = this.documentEntries.get(documentKey(viewType, URI.revive(resource)));
    if (!document || document.extension !== extension || !isEditable(entry.provider)) {
      throw new Error('The custom document is unavailable.');
    }
    return { provider: entry.provider, document };
  }

  private lookupEdit(extension: string, viewType: string, resource: URI, editId: number): vscode.CustomDocumentEditEvent {
    const edit = this.editableDocument(extension, viewType, resource).document.edits.get(editId);
    if (!edit) {
      throw new Error('The edit is unknown.');
    }
    return edit;
  }

  /** An event of the provider: an undoable edit gets an id the main thread orders; any change makes the document dirty. */
  private acceptChange(viewType: string, event: vscode.CustomDocumentEditEvent | vscode.CustomDocumentContentChangeEvent): void {
    const entry = [...this.documentEntries.values()].find(candidate => candidate.viewType === viewType && candidate.document === event?.document);
    if (!entry) {
      return;
    }
    const resource = entry.document.uri as URI;
    if ('undo' in event && typeof event.undo === 'function' && typeof event.redo === 'function') {
      const id = ++this.nextEdit;
      entry.edits.set(id, event);
      void this.proxy.$onDidEdit(entry.extension, viewType, resource, id).catch(() => {});
    } else {
      void this.proxy.$onDidChangeContent(entry.extension, viewType, resource).catch(() => {});
    }
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
    for (const [key, entry] of this.documentEntries) {
      if (entry.extension === extension) {
        this.documentEntries.delete(key);
        entry.document.dispose();
      }
    }
  }

  dispose(): void {
    for (const entry of this.providers.values()) {
      entry.listener?.dispose();
    }
    this.providers.clear();
    for (const entry of this.documentEntries.values()) {
      entry.document.dispose();
    }
    this.documentEntries.clear();
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
