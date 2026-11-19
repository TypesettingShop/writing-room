import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { product } from '../../../platform/product/common/product.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { normalizeWebviewResource } from '../../contrib/webview/browser/resourceLoading.js';
import { WebviewOverlay } from '../../contrib/webview/browser/webviewOverlay.js';
import { resolveWebviewOrigin } from '../../contrib/webview/browser/webviewOrigin.js';
import { WebviewEditorInput } from '../../contrib/webviewPanel/browser/webviewEditorInput.js';
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
  private scheduled = false;
  private stopped = false;

  constructor(
    private readonly proxy: ExtHostWebviewsShape, private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @IEditorService editors: IEditorService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
  ) {
    super();
    for (const event of [
      editors.onDidActiveEditorChange, editors.onDidVisibleEditorsChange, editors.onDidCloseEditor,
      groups.onDidAddGroup, groups.onDidRemoveGroup, groups.onDidMoveGroup,
    ]) {
      this._register(event(() => this.scheduleState()));
    }
  }

  async $createPanel(
    extension: string, handle: string, viewType: string, title: string, show: WebviewShowOptions,
    panelOptions: WebviewPanelOptions, options: WebviewContentOptions,
  ): Promise<void> {
    const owner = this.getExtension(extension);
    if (!owner || !/^[\da-f-]{36}$/.test(handle) || this.panels.has(handle) || !viewType || typeof title !== 'string') {
      throw new Error('Invalid Webview panel.');
    }
    const forwarding = await this.proxy.$getForwardingPorts();
    if (this.stopped || this.getExtension(extension) !== owner || this.panels.has(handle)) {
      return;
    }
    const origin = resolveWebviewOrigin(new URL(location.href), product.webviewContentExternalBaseUrlTemplate, handle, forwarding);
    const webview = this.instantiation.createInstance(WebviewOverlay, viewType, origin, panelOptions.retainContextWhenHidden === true);
    const input = new WebviewEditorInput(handle, owner.id, viewType, title, panelOptions, webview);
    const entry: PanelEntry = { owner: extension, input, listeners: new DisposableStore(), options: this.scope(owner, options), html: '' };
    this.panels.set(handle, entry);
    entry.listeners.add(input.onWillDispose(() => {
      this.drop(handle, entry);
      void this.proxy.$onPanelDisposed(extension, handle).catch(() => {});
    }));
    entry.listeners.add(webview.onDidReceiveMessage(message => {
      void this.proxy.$onMessage(extension, handle, message).catch(() => {});
    }));
    this.updateContent(entry);
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
      entry.options = this.scope(owner, options);
      this.updateContent(entry);
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

  async $disposePanel(extension: string, handle: string): Promise<void> {
    this.lookup(extension, handle)?.input.dispose();
  }

  remove(extension: string): void {
    for (const entry of this.panels.values()) {
      if (entry.owner === extension) {
        entry.input.dispose();
      }
    }
  }

  override dispose(): void {
    this.stopped = true;
    for (const { input } of this.panels.values()) {
      input.dispose();
    }
    super.dispose();
  }

  private validateIcon(owner: HostExtensionDescription, icon?: WebviewIcon): WebviewIcon | undefined {
    if (!icon || typeof icon !== 'object') {
      return undefined;
    }
    const root = normalizeWebviewResource(URI.parse(owner.location));
    const allowed = (uri: unknown): uri is URI => {
      const value = URI.isUri(uri) && normalizeWebviewResource(uri);
      return !!(root && value && isEqualOrParent(value, root));
    };
    if (URI.isUri(icon)) {
      return allowed(icon) ? icon : undefined;
    }
    if ('light' in icon) {
      return allowed(icon.light) && allowed(icon.dark) ? icon : undefined;
    }
    return typeof icon.id === 'string' && /^[\w-]+$/.test(icon.id) ? icon : undefined;
  }

  private scope(owner: HostExtensionDescription, options: WebviewContentOptions): WebviewContentOptions {
    const roots = [...this.workspace.getWorkspace().folders.map(folder => folder.uri), URI.parse(owner.location)]
      .map(normalizeWebviewResource).filter(root => root !== undefined);
    const explicit = Array.isArray(options.localResourceRoots) ? options.localResourceRoots : roots;
    return {
      enableScripts: options.enableScripts === true,
      enableForms: typeof options.enableForms === 'boolean' ? options.enableForms : undefined,
      localResourceRoots: explicit.filter(URI.isUri).map(normalizeWebviewResource).filter(
        (root): root is URI => root !== undefined && roots.some(scope => isEqualOrParent(root, scope))),
    };
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
          const group = this.containingGroup(entry.input);
          const column = group && editorGroupToColumn(this.groups, group);
          const state = {
            active: this.groups.activeGroup.activeEditor === entry.input,
            visible: entry.input.webview.isVisible,
            viewColumn: column === undefined || column < 0 ? undefined : column + 1,
          };
          const before = entry.state;
          if (!before || before.active !== state.active || before.visible !== state.visible || before.viewColumn !== state.viewColumn) {
            entry.state = state;
            void this.proxy.$onPanelViewState(entry.owner, handle, state).catch(() => {});
          }
        }
      });
    }
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
