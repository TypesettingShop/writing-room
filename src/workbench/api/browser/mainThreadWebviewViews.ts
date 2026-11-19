import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WebviewOverlay } from '../../contrib/webview/browser/webviewOverlay.js';
import { IWebviewOriginService } from '../../contrib/webview/browser/webviewOriginService.js';
import { scopeWebviewOptions } from '../../contrib/webview/browser/webviewResourceScope.js';
import { IWebviewStateStore } from '../../contrib/webview/browser/webviewStateStore.js';
import type { WebviewViewPane } from '../../contrib/webviewView/browser/webviewViewPane.js';
import { IWebviewViewService } from '../../contrib/webviewView/browser/webviewViewService.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { IViewsService } from '../../services/views/browser/viewsService.js';
import { ExtHostWebviewViewsProxy, MainThreadWebviewViewsProxy } from '../common/extHost.protocol.webview.js';
import type {
  ExtHostWebviewViewsShape, MainThreadWebviewViewsShape, WebviewContentOptions,
} from '../common/extHost.protocol.webview.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';

interface ViewEntry {
  readonly owner: string;
  readonly pane: WebviewViewPane;
  readonly webview: WebviewOverlay;
  readonly listeners: DisposableStore;
  html: string;
  options: WebviewContentOptions;
}

export class MainThreadWebviewViews extends Disposable implements MainThreadWebviewViewsShape {
  private readonly entries = new Map<string, ViewEntry>();
  private readonly registrations = new Map<string, { owner: string; registration: IDisposable }>();

  constructor(
    private readonly proxy: ExtHostWebviewViewsShape,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IWebviewViewService private readonly webviewViews: IWebviewViewService,
    @IViewsService private readonly views: IViewsService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IWebviewStateStore private readonly states: IWebviewStateStore,
    @IWebviewOriginService private readonly origins: IWebviewOriginService,
  ) {
    super();
  }

  async $registerProvider(extension: string, viewId: string, retain: boolean): Promise<void> {
    const owner = this.getExtension(extension);
    const views = owner?.manifest.contributes?.views;
    const declaresWebview = views && typeof views === 'object' && Object.values(views).some(entries =>
      Array.isArray(entries) && entries.some(entry => entry?.id === viewId && entry.type === 'webview'));
    if (!owner || !owner.views?.includes(viewId) || !declaresWebview) {
      throw new Error('No Webview view with id ' + viewId + ' is owned by ' + extension);
    }
    const registration = this.webviewViews.register(viewId, owner.id,
      (pane, token) => this.resolve(extension, owner, pane, retain === true, token));
    this.registrations.set(viewId, { owner: extension, registration });
  }

  async $unregisterProvider(extension: string, viewId: string): Promise<void> {
    this.unregister(extension, viewId);
  }

  async $setHtml(extension: string, handle: string, html: string): Promise<void> {
    const entry = this.lookup(extension, handle);
    if (entry && typeof html === 'string') {
      entry.html = html;
      entry.webview.setContent(html, entry.options);
    }
  }

  async $setOptions(extension: string, handle: string, options: WebviewContentOptions): Promise<void> {
    const entry = this.lookup(extension, handle);
    const owner = entry && this.getExtension(extension);
    if (entry && owner) {
      entry.options = this.scope(owner, options);
      entry.webview.setContent(entry.html, entry.options);
    }
  }

  async $postMessage(extension: string, handle: string, value: unknown): Promise<boolean> {
    return this.lookup(extension, handle)?.webview.postMessage(value) ?? false;
  }

  async $setViewLabel(extension: string, handle: string, label: 'title' | 'description', value?: string): Promise<void> {
    const entry = this.lookup(extension, handle);
    if (entry && (value === undefined || typeof value === 'string')) {
      if (label === 'title') {
        entry.pane.setTitle(value);
      } else if (label === 'description') {
        entry.pane.setDescription(value);
      }
    }
  }

  async $showView(extension: string, handle: string, preserveFocus: boolean): Promise<void> {
    const entry = this.lookup(extension, handle);
    if (entry && await this.views.openView(entry.pane.id, !preserveFocus) && !preserveFocus) {
      entry.pane.focus();
    }
  }

  remove(extension: string): void {
    for (const [id, entry] of this.registrations) {
      if (entry.owner === extension) {
        this.unregister(extension, id);
      }
    }
  }

  override dispose(): void {
    for (const [id, entry] of this.registrations) {
      this.unregister(entry.owner, id);
    }
    super.dispose();
  }

  private async resolve(
    extension: string, owner: HostExtensionDescription, pane: WebviewViewPane, retain: boolean, token: CancellationToken,
  ): Promise<void> {
    const handle = crypto.randomUUID();
    const origin = await this.origins.resolve(handle);
    if (token.isCancellationRequested || this.getExtension(extension) !== owner) {
      return;
    }
    const webview = this.instantiation.createInstance(WebviewOverlay, pane.id, origin, retain);
    const stateId = 'view/' + pane.id;
    const state = this.states.get(stateId, owner.id);
    webview.setState(state);
    const options = this.scope(owner, {});
    webview.setContent('', options);
    const mount = pane.mount(token, webview);
    if (!mount) {
      return;
    }
    const listeners = new DisposableStore();
    const entry: ViewEntry = { owner: extension, pane, webview, listeners, html: '', options };
    this.entries.set(handle, entry);
    listeners.add(mount);
    listeners.add(webview.onDidChangeState(value => this.states.set(stateId, owner.id, value)));
    listeners.add(webview.onDidReceiveMessage(value => {
      void this.proxy.$onViewMessage(extension, handle, value).catch(() => {});
    }));
    listeners.add(pane.onDidChangeVisibility(visible => {
      void this.proxy.$onViewVisibility(extension, handle, visible).catch(() => {});
    }));
    listeners.add(token.onCancellationRequested(() => this.drop(handle, entry)));
    listeners.add(pane.onDidDispose(() => this.drop(handle, entry)));
    try {
      await this.proxy.$resolveView(extension, handle, pane.id, pane.originalTitle,
        state === undefined ? undefined : JSON.parse(state), pane.visible, origin, token);
    } catch (error) {
      this.drop(handle, entry);
      throw error;
    }
  }

  private lookup(extension: string, handle: string): ViewEntry | undefined {
    const entry = this.entries.get(handle);
    return entry?.owner === extension ? entry : undefined;
  }

  private unregister(extension: string, viewId: string): void {
    const entry = this.registrations.get(viewId);
    if (entry?.owner === extension) {
      this.registrations.delete(viewId);
      entry.registration.dispose();
    }
  }

  private drop(handle: string, entry: ViewEntry): void {
    if (this.entries.get(handle) === entry) {
      this.entries.delete(handle);
      entry.listeners.dispose();
      void this.proxy.$onViewDisposed(entry.owner, handle).catch(() => {});
    }
  }

  private scope(owner: HostExtensionDescription, options: WebviewContentOptions): WebviewContentOptions {
    return scopeWebviewOptions(owner.location, this.workspace.getWorkspace().folders.map(folder => folder.uri), options);
  }
}

mainThreadCustomers.register('webviewViews', ({ rpc, instantiation, getExtension }) => {
  const views = instantiation.createInstance(MainThreadWebviewViews, rpc.getProxy(ExtHostWebviewViewsProxy), getExtension);
  rpc.set(MainThreadWebviewViewsProxy, views);
  return views;
});
