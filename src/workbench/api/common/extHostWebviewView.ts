import type * as vscode from 'vscode';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import { ExtHostWebviewViewsProxy, MainThreadWebviewViewsProxy } from './extHost.protocol.webview.js';
import type { ExtHostWebviewViewsShape, MainThreadWebviewViewsShape } from './extHost.protocol.webview.js';
import { Disposable } from './extHostTypes.js';
import { ExtHostWebview, extHostWebviewOrigin } from './extHostWebview.js';
import type { SendWebviewCall } from './extHostWebview.js';

class ExtHostWebviewView implements vscode.WebviewView {
  readonly #visibility = new Emitter<void>();
  readonly #closed = new Emitter<void>();
  readonly onDidChangeVisibility = this.#visibility.event;
  readonly onDidDispose = this.#closed.event;
  #title: string | undefined;
  #description: string | undefined;
  #visible: boolean;
  #disposed = false;
  readonly #setLabel: (label: 'title' | 'description', value: string | undefined) => void;
  readonly #show: (preserveFocus: boolean) => void;

  constructor(
    readonly viewType: string, readonly webview: ExtHostWebview, title: string, visible: boolean,
    setLabel: (label: 'title' | 'description', value: string | undefined) => void, show: (preserveFocus: boolean) => void,
  ) {
    this.#title = title;
    this.#visible = visible;
    this.#setLabel = setLabel;
    this.#show = show;
  }

  get visible(): boolean { return this.#visible; }

  get title(): string | undefined { return this.#title; }
  set title(value: string | undefined) {
    this.#title = value;
    this.#setLabel('title', value);
  }

  get description(): string | undefined { return this.#description; }
  set description(value: string | undefined) {
    this.#description = value;
    this.#setLabel('description', value);
  }

  show(preserveFocus = false): void {
    this.#show(preserveFocus);
  }

  acceptVisibility(visible: boolean): void {
    if (!this.#disposed && this.#visible !== visible) {
      this.#visible = visible;
      this.#visibility.fire();
    }
  }

  dispose(): void {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#closed.fire();
      this.#closed.dispose();
      this.#visibility.dispose();
      this.webview.dispose();
    }
  }
}

interface ProviderRegistration {
  readonly provider: vscode.WebviewViewProvider;
  readonly ready: Promise<void>;
}

class ExtHostWebviewViews implements ExtHostWebviewViewsShape {
  private readonly providers = new Map<string, Map<string, ProviderRegistration>>();
  private readonly views = new Map<string, { extension: string; view: ExtHostWebviewView }>();

  constructor(private readonly proxy: MainThreadWebviewViewsShape) {}

  register(extension: string, id: string, provider: vscode.WebviewViewProvider, retain: boolean): Disposable {
    let entries = this.providers.get(extension);
    if (!entries) {
      entries = new Map();
      this.providers.set(extension, entries);
    }
    if (entries.has(id)) {
      throw new Error('A Webview view provider is already registered for ' + id);
    }
    const registration = { provider, ready: this.proxy.$registerProvider(extension, id, retain) };
    entries.set(id, registration);
    void registration.ready.catch(console.error);
    return new Disposable(() => {
      if (entries.get(id) === registration) {
        entries.delete(id);
        if (!entries.size) {
          this.providers.delete(extension);
        }
        void registration.ready.then(() => this.proxy.$unregisterProvider(extension, id)).catch(() => {});
      }
    });
  }

  async flush(extension: string): Promise<void> {
    await Promise.all([...this.providers.get(extension)?.values() ?? []].map(({ ready }) => ready));
  }

  async $resolveView(
    extension: string, handle: string, viewId: string, title: string, state: unknown, visible: boolean, token: CancellationToken,
  ): Promise<void> {
    const registration = this.providers.get(extension)?.get(viewId);
    if (!registration || this.views.has(handle) || token.isCancellationRequested) {
      return;
    }
    const send: SendWebviewCall = (call, fallback) => this.views.has(handle) ? call() : Promise.resolve(fallback);
    const webview = new ExtHostWebview(extHostWebviewOrigin(handle), {}, send, this.proxy, extension, handle);
    const view = new ExtHostWebviewView(viewId, webview, title, visible,
      (label, value) => { void send(() => this.proxy.$setViewLabel(extension, handle, label, value), undefined).catch(console.error); },
      preserve => { void send(() => this.proxy.$showView(extension, handle, preserve), undefined).catch(console.error); });
    this.views.set(handle, { extension, view });
    let listener: vscode.Disposable | undefined;
    const cancelled = new Promise<void>(resolve => {
      listener = token.onCancellationRequested(() => {
        this.drop(extension, handle);
        resolve();
      });
    });
    try {
      await Promise.race([registration.provider.resolveWebviewView(view, { state }, token), cancelled]);
    } catch (error) {
      this.drop(extension, handle);
      throw error;
    } finally {
      listener?.dispose();
    }
  }

  async $onViewMessage(extension: string, handle: string, value: unknown): Promise<void> {
    this.lookup(extension, handle)?.webview.acceptMessage(value);
  }

  async $onViewVisibility(extension: string, handle: string, visible: boolean): Promise<void> {
    this.lookup(extension, handle)?.acceptVisibility(visible);
  }

  async $onViewDisposed(extension: string, handle: string): Promise<void> {
    this.drop(extension, handle);
  }

  remove(extension: string): void {
    const entries = this.providers.get(extension);
    this.providers.delete(extension);
    for (const [id, registration] of entries ?? []) {
      void registration.ready.then(() => this.proxy.$unregisterProvider(extension, id)).catch(() => {});
    }
    entries?.clear();
    for (const [handle, entry] of this.views) {
      if (entry.extension === extension) {
        this.drop(extension, handle);
      }
    }
  }

  dispose(): void {
    for (const key of this.providers.keys()) {
      this.remove(key);
    }
    for (const [handle, { extension }] of this.views) {
      this.drop(extension, handle);
    }
  }

  private lookup(extension: string, handle: string): ExtHostWebviewView | undefined {
    const entry = this.views.get(handle);
    return entry?.extension === extension ? entry.view : undefined;
  }

  private drop(extension: string, handle: string): void {
    const view = this.lookup(extension, handle);
    if (view) {
      this.views.delete(handle);
      view.dispose();
    }
  }
}

extHostApiRegistry.register('webviewViews', ({ rpc, getViews }) => {
  const views = new ExtHostWebviewViews(rpc.getProxy(MainThreadWebviewViewsProxy));
  rpc.set(ExtHostWebviewViewsProxy, views);
  return {
    create: ({ key }) => ({
      namespaces: {
        window: {
          registerWebviewViewProvider: (id, provider, options) => {
            if (!getViews(key).includes(id)) {
              throw new Error('No view is registered with id: ' + id);
            }
            return views.register(key, id, provider, options?.webviewOptions?.retainContextWhenHidden === true);
          },
        } satisfies Pick<typeof vscode.window, 'registerWebviewViewProvider'>,
      },
    }),
    flush: key => views.flush(key),
    release: key => views.remove(key),
    dispose: () => views.dispose(),
  };
});
