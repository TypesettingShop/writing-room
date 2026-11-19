import './mainThreadWebviewViews.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { normalizeWebviewResource } from '../../contrib/webview/browser/resourceLoading.js';
import { IWebviewStateStore } from '../../contrib/webview/browser/webviewStateStore.js';
import { scopeWebviewOptions } from '../../contrib/webview/browser/webviewResourceScope.js';
import { WebviewOverlay } from '../../contrib/webview/browser/webviewOverlay.js';
import { IWebviewOriginService } from '../../contrib/webview/browser/webviewOriginService.js';
import type { WebviewOrigin } from '../../contrib/webview/common/webviewOrigin.js';
import { WebviewEditorInput } from '../../contrib/webviewPanel/browser/webviewEditorInput.js';
import { IWebviewPanelRestoreService } from '../../contrib/webviewPanel/browser/webviewPanelRestoreService.js';
import { columnToEditorGroup, editorGroupToColumn } from '../../services/editor/common/editorGroupColumn.js';
import { GroupDirection, GroupsOrder, IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import type { IEditorGroup } from '../../services/editor/common/editorGroupsService.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../services/editor/common/editorService.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { ExtHostWebviewsProxy, MainThreadWebviewsProxy } from '../common/extHost.protocol.webview.js';
import type {
  ExtHostWebviewsShape, MainThreadWebviewsShape, WebviewContentOptions, WebviewIcon, WebviewPanelOptions, WebviewPanelViewState,
  WebviewShowOptions,
} from '../common/extHost.protocol.webview.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';

interface PanelEntry {
  readonly owner: string;
  readonly input: WebviewEditorInput;
  readonly listeners: DisposableStore;
  options: WebviewContentOptions;
  html: string;
  state?: WebviewPanelViewState;
}

export class MainThreadWebviews extends Disposable implements MainThreadWebviewsShape {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly serializers = new Map<string, Map<string, IDisposable>>();
  /** Restores that have not bound their panel yet, with the generation each one serves. */
  private readonly restoring = new Map<WebviewEditorInput, number>();
  private scheduled = false;
  private stopped = false;

  constructor(
    private readonly proxy: ExtHostWebviewsShape, private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @IEditorService editors: IEditorService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IWebviewPanelRestoreService private readonly restore: IWebviewPanelRestoreService,
    @IWebviewStateStore private readonly states: IWebviewStateStore,
    @IWebviewOriginService private readonly origins: IWebviewOriginService,
  ) {
    super();
    for (const event of [
      editors.onDidActiveEditorChange, editors.onDidVisibleEditorsChange, editors.onDidCloseEditor,
      groups.onDidAddGroup, groups.onDidRemoveGroup, groups.onDidMoveGroup,
    ]) {
      this._register(event(() => this.scheduleState()));
    }
  }

  async $getForwardingHint() {
    return this.origins.getForwardingHint();
  }

  async $createPanel(
    extension: string, handle: string, viewType: string, title: string, show: WebviewShowOptions,
    panelOptions: WebviewPanelOptions, options: WebviewContentOptions,
  ): Promise<void> {
    const owner = this.getExtension(extension);
    if (!owner || !/^[\da-f-]{36}$/.test(handle) || this.panels.has(handle)
      || typeof viewType !== 'string' || !viewType || typeof title !== 'string') {
      throw new Error('Invalid Webview panel.');
    }
    const origin = await this.origins.resolve(handle);
    if (this.stopped || this.getExtension(extension) !== owner || this.panels.has(handle)) {
      return;
    }
    const webview = this.instantiation.createInstance(WebviewOverlay, viewType, origin, panelOptions.retainContextWhenHidden === true);
    const persistent = owner.manifest.activationEvents?.includes('onWebviewPanel:' + viewType) === true;
    const input = this.instantiation.createInstance(WebviewEditorInput,
      handle, owner.id, viewType, title, panelOptions, webview, persistent);
    this.bindPanel(extension, handle, owner, input, options);
    try {
      await this.targetGroup(show.viewColumn).openEditor(input, { preserveFocus: show.preserveFocus });
    } catch (error) {
      input.dispose();
      throw error;
    } finally {
      this.scheduleState();
    }
  }

  async $setHtml(extension: string, handle: string, html: string): Promise<void> {
    const entry = this.lookup(extension, handle);
    if (entry && typeof html === 'string') {
      entry.html = html;
      this.updateContent(entry);
    }
  }

  async $setOptions(extension: string, handle: string, options: WebviewContentOptions): Promise<void> {
    const entry = this.lookup(extension, handle);
    const owner = entry && this.getExtension(extension);
    if (entry && owner) {
      this.setContentOptions(owner, entry, options);
    }
  }

  async $postMessage(extension: string, handle: string, message: unknown): Promise<boolean> {
    return this.lookup(extension, handle)?.input.webview.postMessage(message) ?? false;
  }

  async $setTitle(extension: string, handle: string, title: string): Promise<void> {
    if (typeof title === 'string') {
      this.lookup(extension, handle)?.input.setTitle(title);
    }
  }

  async $setIcon(extension: string, handle: string, icon?: WebviewIcon): Promise<void> {
    const entry = this.lookup(extension, handle);
    const owner = entry && this.getExtension(extension);
    if (entry && owner) {
      entry.input.setIconPath(this.validateIcon(owner, icon));
    }
  }

  async $revealPanel(extension: string, handle: string, show: WebviewShowOptions): Promise<void> {
    const entry = this.lookup(extension, handle);
    const current = entry && this.containingGroup(entry.input);
    if (!entry || !current) {
      return;
    }
    const target = show.viewColumn === undefined ? current : this.targetGroup(show.viewColumn);
    if (current !== target) {
      current.moveEditor(entry.input, target, { preserveFocus: show.preserveFocus });
    } else {
      await current.openEditor(entry.input, { preserveFocus: show.preserveFocus });
    }
    this.scheduleState();
  }

  async $registerPanelSerializer(extension: string, viewType: string): Promise<void> {
    const owner = this.getExtension(extension);
    if (!owner || typeof viewType !== 'string' || !viewType) {
      throw new Error('Invalid Webview panel serializer.');
    }
    let registrations = this.serializers.get(extension);
    if (!registrations) {
      registrations = new Map();
      this.serializers.set(extension, registrations);
    }
    if (registrations.has(viewType)) {
      throw new Error('A Webview panel serializer is already registered for ' + viewType);
    }
    const registration = this.restore.register(owner.id, viewType, (input, generation) =>
      this.restorePanel(extension, input, generation));
    registrations.set(viewType, registration);
  }

  async $unregisterPanelSerializer(extension: string, viewType: string): Promise<void> {
    const registrations = this.serializers.get(extension);
    registrations?.get(viewType)?.dispose();
    registrations?.delete(viewType);
    if (registrations?.size === 0) {
      this.serializers.delete(extension);
    }
  }

  async $disposePanel(extension: string, handle: string): Promise<void> {
    this.lookup(extension, handle)?.input.dispose();
  }

  remove(extension: string): void {
    for (const entry of this.panels.values()) {
      if (entry.owner === extension) {
        entry.input.dispose();
      }
    }
    this.removeSerializers(extension);
  }

  override dispose(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const [handle, entry] of this.panels) {
      const { owner, input } = entry;
      if (input.persistent && this.serializers.get(owner)?.has(input.viewType)) {
        this.drop(handle, entry);
        void this.proxy.$onPanelDisposed(owner, handle).catch(() => {});
        input.markForRestore();
        if (input.webview.isVisible) {
          this.restore.show(input);
        }
      } else {
        input.dispose();
      }
    }
    // A restore still waiting for this host starts again in the next one instead of reporting success.
    for (const [input, generation] of this.restoring) {
      if (!input.isDisposed() && input.restoreGeneration === generation) {
        input.markForRestore();
        if (input.webview.isVisible) {
          this.restore.show(input);
        }
      }
    }
    this.restoring.clear();
    for (const extension of this.serializers.keys()) {
      this.removeSerializers(extension);
    }
    // This runs on the same port before the worker starts disposing extension subscriptions.
    void this.proxy.$prepareShutdown().catch(() => {});
    super.dispose();
  }

  private async restorePanel(extension: string, input: WebviewEditorInput, generation: number): Promise<void> {
    const owner = this.getExtension(extension);
    const isCurrent = () => !this.stopped && !input.isDisposed() && input.restoreGeneration === generation;
    if (!isCurrent()) {
      return;
    }
    if (!owner || owner.id !== input.extensionId) {
      throw new Error('The extension that provides this Webview is unavailable.');
    }
    const handle = crypto.randomUUID();
    this.restoring.set(input, generation);
    let origin: WebviewOrigin;
    try {
      origin = await this.origins.resolve(input.id);
    } finally {
      if (this.restoring.get(input) === generation) {
        this.restoring.delete(input);
      }
    }
    if (!isCurrent()) {
      return;
    }
    if (this.getExtension(extension) !== owner) {
      throw new Error('The extension that provides this Webview is unavailable.');
    }
    const entry = this.bindPanel(extension, handle, owner, input, input.contentOptions);
    const saved = this.states.get(input.id, owner.id);
    input.setIconPath(this.validateIcon(owner, input.persistedIconPath));
    input.webview.setState(saved);
    input.webview.setOrigin(origin);
    const cancellation = new CancellationTokenSource();
    entry.listeners.add(toDisposable(() => cancellation.dispose(true)));
    try {
      await this.proxy.$deserializePanel(extension, handle, {
        id: input.id, viewType: input.viewType, title: input.getName(), options: input.options,
        contentOptions: input.contentOptions, icon: input.iconPath, viewState: this.viewState(input),
        state: saved === undefined ? undefined : JSON.parse(saved),
      }, origin, cancellation.token);
    } catch (error) {
      if (this.lookup(extension, handle) === entry) {
        this.drop(handle, entry);
      }
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  private bindPanel(
    extension: string, handle: string, owner: HostExtensionDescription, input: WebviewEditorInput, options: WebviewContentOptions,
  ): PanelEntry {
    const entry: PanelEntry = { owner: extension, input, listeners: new DisposableStore(), options: {}, html: '' };
    this.panels.set(handle, entry);
    entry.listeners.add(input.onWillDispose(() => {
      this.drop(handle, entry);
      void this.proxy.$onPanelDisposed(extension, handle).catch(() => {});
    }));
    entry.listeners.add(input.webview.onDidReceiveMessage(message => {
      void this.proxy.$onMessage(extension, handle, message).catch(() => {});
    }));
    if (input.persistent) {
      entry.listeners.add(input.webview.onDidChangeState(state => this.states.set(input.id, owner.id, state)));
    }
    this.setContentOptions(owner, entry, options);
    return entry;
  }

  private setContentOptions(owner: HostExtensionDescription, entry: PanelEntry, options: WebviewContentOptions): void {
    entry.options = scopeWebviewOptions(owner.location, this.workspace.getWorkspace().folders.map(folder => folder.uri), options);
    entry.input.contentOptions = {
      ...entry.options, localResourceRoots: options.localResourceRoots === undefined ? undefined : entry.options.localResourceRoots,
    };
    this.updateContent(entry);
  }

  private removeSerializers(extension: string): void {
    for (const registration of this.serializers.get(extension)?.values() ?? []) {
      registration.dispose();
    }
    this.serializers.delete(extension);
  }

  private validateIcon(owner: HostExtensionDescription, icon?: WebviewIcon): WebviewIcon | undefined {
    if (!icon || typeof icon !== 'object') {
      return undefined;
    }
    const root = normalizeWebviewResource(URI.parse(owner.location));
    const allowed = (uri: unknown): URI | undefined => {
      const value = URI.isUri(uri) && normalizeWebviewResource(uri);
      return root && value && isEqualOrParent(value, root) ? value : undefined;
    };
    if (URI.isUri(icon)) {
      return allowed(icon);
    }
    if ('light' in icon) {
      const light = allowed(icon.light);
      const dark = allowed(icon.dark);
      return light && dark ? { light, dark } : undefined;
    }
    return typeof icon.id === 'string' && /^[\w-]+$/.test(icon.id) ? icon : undefined;
  }

  private updateContent(entry: PanelEntry): void {
    entry.input.webview.setContent(entry.html, entry.options);
  }

  private containingGroup(input: WebviewEditorInput): IEditorGroup | undefined {
    const active = this.groups.activeGroup;
    return active.contains(input) ? active : this.groups.getGroups(GroupsOrder.GRID_APPEARANCE)
      .find(group => group.isActive(input)) ?? this.groups.groups.find(group => group.contains(input));
  }

  private targetGroup(column: number | undefined): IEditorGroup {
    const id = columnToEditorGroup(this.groups, column === undefined || column < 0 ? column : column - 1);
    const active = this.groups.activeGroup;
    if (id === SIDE_GROUP) {
      return this.groups.findGroup({ direction: GroupDirection.RIGHT }, active) ?? this.groups.addGroup(active, GroupDirection.RIGHT);
    }
    return id === ACTIVE_GROUP ? active : this.groups.getGroup(id) ?? active;
  }

  private scheduleState(): void {
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        for (const [handle, entry] of this.panels) {
          const state = this.viewState(entry.input);
          const before = entry.state;
          if (!before || before.active !== state.active || before.visible !== state.visible || before.viewColumn !== state.viewColumn) {
            entry.state = state;
            void this.proxy.$onPanelViewState(entry.owner, handle, state).catch(() => {});
          }
        }
      });
    }
  }

  private viewState(input: WebviewEditorInput): WebviewPanelViewState {
    const group = this.containingGroup(input);
    const column = group && editorGroupToColumn(this.groups, group);
    return {
      active: this.groups.activeGroup.activeEditor === input,
      visible: input.webview.isVisible,
      viewColumn: column === undefined || column < 0 ? undefined : column + 1,
    };
  }

  private lookup(extension: string, handle: string): PanelEntry | undefined {
    const entry = this.panels.get(handle);
    return entry?.owner === extension ? entry : undefined;
  }

  private drop(handle: string, entry: PanelEntry): void {
    this.panels.delete(handle);
    entry.listeners.dispose();
  }
}

mainThreadCustomers.register('webviews', ({ rpc, instantiation, getExtension }) => {
  const webviews = instantiation.createInstance(MainThreadWebviews, rpc.getProxy(ExtHostWebviewsProxy), getExtension);
  rpc.set(MainThreadWebviewsProxy, webviews);
  return webviews;
});
