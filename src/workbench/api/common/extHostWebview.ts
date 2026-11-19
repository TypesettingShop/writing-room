import './extHostWebviewView.js';
import type * as vscode from 'vscode';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { product } from '../../../platform/product/common/product.js';
import { asWebviewUri } from '../../contrib/webview/common/webviewUri.js';
import { getWebviewForwardingPorts, resolveWebviewOrigin } from '../../contrib/webview/common/webviewOrigin.js';
import type { WebviewForwardingPorts, WebviewOrigin } from '../../contrib/webview/common/webviewOrigin.js';
import { ExtHostWebviewsProxy, MainThreadWebviewsProxy } from './extHost.protocol.webview.js';
import type {
  ExtHostWebviewsShape, MainThreadWebviewContent, MainThreadWebviewsShape, WebviewContentOptions, WebviewIcon, WebviewPanelRestoreData, WebviewPanelViewState, WebviewShowOptions,
} from './extHost.protocol.webview.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import { Disposable } from './extHostTypes.js';

const page = typeof location === 'undefined' ? undefined : new URL(location.href);
const template = product.webviewContentExternalBaseUrlTemplate;
// Let the Worker attach its RPC port while forwarding loads. Activation waits before exposing the
// synchronous cspSource and asWebviewUri APIs.
let forwarding: WebviewForwardingPorts | undefined;
const forwardingReady = page && getWebviewForwardingPorts(page, template).then(ports => { forwarding = ports; });
const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);

export type SendWebviewCall = <T>(call: () => Promise<T>, fallback: T) => Promise<T>;

export function toContentOptions(options: vscode.WebviewOptions): WebviewContentOptions {
  return {
    enableScripts: options.enableScripts,
    enableForms: options.enableForms,
    localResourceRoots: options.localResourceRoots as readonly URI[] | undefined,
  };
}

export function extHostWebviewOrigin(id: string): WebviewOrigin {
  return page ? resolveWebviewOrigin(page, template, id, forwarding) : { error: 'No Webview origin' };
}

export class ExtHostWebview implements vscode.Webview {
  #html = '';
  #disposed = false;
  #options: vscode.WebviewOptions;
  readonly #origin: WebviewOrigin;
  readonly #events = new Emitter<unknown>();
  readonly onDidReceiveMessage = this.#events.event;
  readonly #updateHtml: (html: string) => Promise<void>;
  readonly #updateOptions: (options: WebviewContentOptions) => Promise<void>;
  readonly #sendMessage: (value: unknown) => Promise<boolean>;

  constructor(
    origin: WebviewOrigin, options: vscode.WebviewOptions, send: SendWebviewCall,
    proxy: MainThreadWebviewContent, extension: string, handle: string,
  ) {
    this.#origin = origin;
    this.#options = options;
    this.#updateHtml = html => send(() => proxy.$setHtml(extension, handle, html), undefined);
    this.#updateOptions = options => send(() => proxy.$setOptions(extension, handle, options), undefined);
    this.#sendMessage = value => send(() => proxy.$postMessage(extension, handle, value), false);
  }

  get cspSource(): string {
    return 'origin' in this.#origin ? this.#origin.origin : "'none'";
  }

  get html(): string {
    this.#checkLive();
    return this.#html;
  }

  set html(value: string) {
    this.#checkLive();
    if (this.#html !== value) {
      this.#html = value;
      void this.#updateHtml(value).catch(console.error);
    }
  }

  get options(): vscode.WebviewOptions {
    this.#checkLive();
    return this.#options;
  }

  set options(options: vscode.WebviewOptions) {
    this.#checkLive();
    this.#options = options;
    void this.#updateOptions(toContentOptions(options)).catch(console.error);
  }

  asWebviewUri(localResource: vscode.Uri): vscode.Uri {
    this.#checkLive();
    return 'origin' in this.#origin ? asWebviewUri(this.#origin.origin, localResource as URI) : localResource;
  }

  postMessage(message: unknown): Promise<boolean> {
    return this.#disposed ? Promise.resolve(false) : this.#sendMessage(message);
  }

  acceptMessage(message: unknown): void {
    this.#events.fire(message);
  }

  dispose(): void {
    this.#disposed = true;
    this.#events.dispose();
  }

  #checkLive(): void {
    if (this.#disposed) {
      throw new Error('Webview is disposed.');
    }
  }
}

class ExtHostWebviewPanel implements vscode.WebviewPanel {
  readonly #viewChanged = new Emitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
  readonly #closed = new Emitter<void>();
  readonly onDidChangeViewState = this.#viewChanged.event;
  readonly onDidDispose = this.#closed.event;
  readonly #updateTitle: (title: string) => Promise<void>;
  readonly #updateIcon: (icon?: WebviewIcon) => Promise<void>;
  readonly #reveal: (show: WebviewShowOptions) => Promise<void>;
  readonly #close: () => void;
  #title: string;
  #icon: vscode.IconPath | undefined;
  #state: WebviewPanelViewState;
  #disposed = false;

  constructor(
    readonly viewType: string, title: string, readonly webview: ExtHostWebview,
    readonly options: vscode.WebviewPanelOptions, state: WebviewPanelViewState,
    send: SendWebviewCall, close: () => void, proxy: MainThreadWebviewsShape, extension: string, handle: string,
    icon?: vscode.IconPath,
  ) {
    this.#title = title;
    this.#icon = icon;
    this.#state = state;
    this.#close = close;
    this.#updateTitle = value => send(() => proxy.$setTitle(extension, handle, value), undefined);
    this.#updateIcon = value => send(() => proxy.$setIcon(extension, handle, value), undefined);
    this.#reveal = show => send(() => proxy.$revealPanel(extension, handle, show), undefined);
  }

  get title(): string { return this.#title; }
  set title(value: string) {
    this.#checkLive();
    if (this.#title !== value) {
      this.#title = value;
      void this.#updateTitle(value).catch(console.error);
    }
  }

  get iconPath(): vscode.IconPath | undefined { return this.#icon; }
  set iconPath(value: vscode.IconPath | undefined) {
    this.#checkLive();
    this.#icon = value;
    void this.#updateIcon(value as WebviewIcon | undefined).catch(console.error);
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

interface PanelEntry {
  readonly extension: string;
  readonly panel: ExtHostWebviewPanel;
  readonly ready: Promise<void>;
}

interface SerializerRegistration {
  readonly serializer: vscode.WebviewPanelSerializer;
  readonly ready: Promise<void>;
}

class ExtHostWebviews implements ExtHostWebviewsShape {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly serializers = new Map<string, Map<string, SerializerRegistration>>();

  constructor(private readonly proxy: MainThreadWebviewsShape) {}

  async $getForwardingPorts() {
    await forwardingReady;
    return forwarding;
  }

  createPanel(
    extension: string, viewType: string, title: string, showOptions: number | WebviewShowOptions,
    options: vscode.WebviewPanelOptions & vscode.WebviewOptions = {},
  ): vscode.WebviewPanel {
    if (!randomUUID) {
      throw new Error('Webviews require a secure workbench address.');
    }
    const id = randomUUID();
    const show = typeof showOptions === 'number' ? { viewColumn: showOptions } : showOptions;
    const panelOptions = Object.freeze({
      enableFindWidget: options.enableFindWidget, retainContextWhenHidden: options.retainContextWhenHidden,
    });
    const ready = this.proxy.$createPanel(extension, id, viewType, title, show, panelOptions, toContentOptions(options));
    const panel = this.attachPanel(extension, id, {
      id, viewType, title, options: panelOptions, contentOptions: options, state: undefined, viewState: {
        active: !show.preserveFocus, visible: true,
        viewColumn: show.viewColumn !== undefined && show.viewColumn > 0 ? show.viewColumn : undefined,
      },
    }, ready);
    void ready.catch(error => {
      this.drop(extension, id);
      console.error('Could not open Webview panel:', error);
    });
    return panel;
  }

  private attachPanel(
    extension: string, handle: string, data: Omit<WebviewPanelRestoreData, 'contentOptions'> & {
      readonly contentOptions: vscode.WebviewOptions;
    }, ready: Promise<void>,
  ): ExtHostWebviewPanel {
    const origin = extHostWebviewOrigin(data.id);
    const send: SendWebviewCall = (call, fallback) => ready.then(() => this.panels.has(handle) ? call() : fallback);
    const webview = new ExtHostWebview(origin, data.contentOptions, send, this.proxy, extension, handle);
    const panel = new ExtHostWebviewPanel(data.viewType, data.title, webview, data.options, data.viewState, send,
      () => this.disposePanel(extension, handle), this.proxy, extension, handle, data.icon as vscode.IconPath | undefined);
    this.panels.set(handle, { extension, panel, ready });
    return panel;
  }

  registerSerializer(extension: string, viewType: string, serializer: vscode.WebviewPanelSerializer): Disposable {
    let owned = this.serializers.get(extension);
    if (!owned) {
      owned = new Map();
      this.serializers.set(extension, owned);
    }
    if (owned.has(viewType)) {
      throw new Error('A Webview panel serializer is already registered for ' + viewType);
    }
    const registration = { serializer, ready: this.proxy.$registerPanelSerializer(extension, viewType) };
    owned.set(viewType, registration);
    void registration.ready.catch(console.error);
    return new Disposable(() => {
      if (owned.get(viewType) === registration) {
        owned.delete(viewType);
        if (owned.size === 0) {
          this.serializers.delete(extension);
        }
        void registration.ready.then(() => this.proxy.$unregisterPanelSerializer(extension, viewType)).catch(() => {});
      }
    });
  }

  async flush(extension: string): Promise<void> {
    await Promise.all([...this.serializers.get(extension)?.values() ?? []].map(({ ready }) => ready));
  }

  async $deserializePanel(
    extension: string, handle: string, data: WebviewPanelRestoreData, token: CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }
    const serializer = this.serializers.get(extension)?.get(data.viewType)?.serializer;
    if (!serializer || this.panels.has(handle)) {
      throw new Error('The Webview panel serializer is unavailable.');
    }
    const panel = this.attachPanel(extension, handle, {
      ...data, contentOptions: data.contentOptions as vscode.WebviewOptions,
    }, Promise.resolve());
    let listener: vscode.Disposable | undefined;
    const cancelled = new Promise<void>(resolve => {
      listener = token.onCancellationRequested(() => {
        this.drop(extension, handle);
        resolve();
      });
    });
    try {
      await Promise.race([serializer.deserializeWebviewPanel(panel, data.state), cancelled]);
    } catch (error) {
      this.drop(extension, handle);
      throw error;
    } finally {
      listener?.dispose();
    }
  }

  async $onMessage(extension: string, handle: string, message: unknown): Promise<void> {
    this.lookup(extension, handle)?.panel.webview.acceptMessage(message);
  }

  async $onPanelViewState(extension: string, handle: string, state: WebviewPanelViewState): Promise<void> {
    this.lookup(extension, handle)?.panel.acceptViewState(state);
  }

  async $onPanelDisposed(extension: string, handle: string): Promise<void> {
    this.drop(extension, handle);
  }

  remove(extension: string): void {
    const owned = this.serializers.get(extension);
    this.serializers.delete(extension);
    for (const [type, { ready }] of owned ?? []) {
      void ready.then(() => this.proxy.$unregisterPanelSerializer(extension, type)).catch(() => {});
    }
    owned?.clear();
    for (const [id, entry] of this.panels) {
      if (entry.extension === extension) {
        this.disposePanel(extension, id);
      }
    }
  }

  dispose(): void {
    this.serializers.clear();
    for (const [id, { extension }] of this.panels) {
      this.drop(extension, id);
    }
  }

  private lookup(extension: string, handle: string): PanelEntry | undefined {
    const entry = this.panels.get(handle);
    return entry?.extension === extension ? entry : undefined;
  }

  private drop(extension: string, handle: string): PanelEntry | undefined {
    const entry = this.lookup(extension, handle);
    if (entry) {
      this.panels.delete(handle);
      entry.panel.acceptDisposed();
    }
    return entry;
  }

  private disposePanel(extension: string, handle: string): void {
    const entry = this.drop(extension, handle);
    void entry?.ready.then(() => this.proxy.$disposePanel(extension, handle)).catch(() => {});
  }
}

extHostApiRegistry.register('webviews', ({ rpc }) => {
  const webviews = new ExtHostWebviews(rpc.getProxy(MainThreadWebviewsProxy));
  rpc.set(ExtHostWebviewsProxy, webviews);
  return {
    service: webviews,
    ready: forwardingReady,
    create: ({ key }) => ({
      namespaces: {
        window: {
          createWebviewPanel: (viewType, title, show, options) => webviews.createPanel(key, viewType, title, show, options),
          registerWebviewPanelSerializer: (type, serializer) => webviews.registerSerializer(key, type, serializer),
        } satisfies Pick<typeof vscode.window, 'createWebviewPanel' | 'registerWebviewPanelSerializer'>,
      },
    }),
    flush: key => webviews.flush(key),
    release: key => webviews.remove(key),
    dispose: () => webviews.dispose(),
  };
});
