import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { product } from '../../../platform/product/common/product.js';
import { asWebviewUri } from '../../contrib/webview/browser/resourceLoading.js';
import { getWebviewForwardingPorts, resolveWebviewOrigin } from '../../contrib/webview/browser/webviewOrigin.js';
import type { WebviewOrigin } from '../../contrib/webview/browser/webviewOrigin.js';
import { ExtHostWebviewsProxy, MainThreadWebviewsProxy } from './extHost.protocol.webview.js';
import type {
  ExtHostWebviewsShape, MainThreadWebviewsShape, WebviewContentOptions, WebviewIcon, WebviewPanelViewState, WebviewShowOptions,
} from './extHost.protocol.webview.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';

const page = typeof location === 'undefined' ? undefined : new URL(location.href);
const template = product.webviewContentExternalBaseUrlTemplate;
// Resolve forwarding once in the trusted Worker bootstrap. Extension code reads cspSource synchronously.
const forwarding = page && await getWebviewForwardingPorts(page, template);
const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);

type SendWebviewCall = <T>(call: () => Promise<T>, fallback: T) => Promise<T>;

export function toContentOptions(options: vscode.WebviewOptions): WebviewContentOptions {
  return {
    enableScripts: options.enableScripts,
    enableForms: options.enableForms,
    localResourceRoots: options.localResourceRoots as readonly URI[] | undefined,
  };
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
    proxy: MainThreadWebviewsShape, extension: string, handle: string,
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
  ) {
    this.#title = title;
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

class ExtHostWebviews implements ExtHostWebviewsShape {
  private readonly panels = new Map<string, PanelEntry>();

  constructor(private readonly proxy: MainThreadWebviewsShape) {}

  async $getForwardingPorts() {
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
    const origin = page ? resolveWebviewOrigin(page, template, id, forwarding) : { error: 'No Webview origin' };
    const ready = this.proxy.$createPanel(extension, id, viewType, title, show, panelOptions, toContentOptions(options));
    const send: SendWebviewCall = (call, fallback) => ready.then(() => this.panels.has(id) ? call() : fallback);
    const webview = new ExtHostWebview(origin, options, send, this.proxy, extension, id);
    const panel = new ExtHostWebviewPanel(viewType, title, webview, panelOptions, {
      active: !show.preserveFocus, visible: true,
      viewColumn: show.viewColumn !== undefined && show.viewColumn > 0 ? show.viewColumn : undefined,
    }, send, () => this.disposePanel(extension, id), this.proxy, extension, id);
    this.panels.set(id, { extension, panel, ready });
    void ready.catch(error => {
      this.drop(extension, id);
      console.error('Could not open Webview panel:', error);
    });
    return panel;
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
    for (const [id, entry] of this.panels) {
      if (entry.extension === extension) {
        this.disposePanel(extension, id);
      }
    }
  }

  dispose(): void {
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
    create: ({ key }) => ({
      namespaces: {
        window: {
          createWebviewPanel: (viewType, title, show, options) => webviews.createPanel(key, viewType, title, show, options),
        } satisfies Pick<typeof vscode.window, 'createWebviewPanel'>,
      },
    }),
    release: key => webviews.remove(key),
    dispose: () => webviews.dispose(),
  };
});
