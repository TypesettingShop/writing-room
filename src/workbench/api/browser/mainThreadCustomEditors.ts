import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { isTooLargeForSyncing } from '../../../editor/common/model.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { CustomEditorInput, CustomEditorResolution } from '../../contrib/customEditor/browser/customEditorInput.js';
import { ICustomEditorService } from '../../contrib/customEditor/browser/customEditorService.js';
import { IWebviewOriginService } from '../../contrib/webview/browser/webviewOriginService.js';
import { scopeWebviewOptions } from '../../contrib/webview/browser/webviewResourceScope.js';
import { columnToEditorGroup, editorGroupToColumn } from '../../services/editor/common/editorGroupColumn.js';
import { GroupDirection, GroupsOrder, IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import type { IEditorGroup } from '../../services/editor/common/editorGroupsService.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../services/editor/common/editorService.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { ExtHostCustomEditorsProxy, MainThreadCustomEditorsProxy } from '../common/extHost.protocol.customEditor.js';
import type { ExtHostCustomEditorsShape, MainThreadCustomEditorsShape } from '../common/extHost.protocol.customEditor.js';
import type {
  WebviewContentOptions, WebviewPanelOptions, WebviewPanelViewState, WebviewShowOptions,
} from '../common/extHost.protocol.webview.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';

interface EditorEntry {
  /** The extension's key in this host. */
  readonly owner: string;
  readonly input: CustomEditorInput;
  readonly listeners: DisposableStore;
  html: string;
  options: WebviewContentOptions;
  state?: WebviewPanelViewState;
}

function declares(extension: HostExtensionDescription, viewType: string): boolean {
  const editors = extension.manifest.contributes?.customEditors;
  return Array.isArray(editors) && editors.some(entry => typeof entry === 'object' && entry !== null
    && (entry as { viewType?: unknown }).viewType === viewType);
}

/**
 * Custom text editors of one extension host. A provider registers here for a `viewType` its
 * extension contributes, and the custom editor service calls it to resolve an editor: this side
 * binds the editor's Webview to a new handle, owned by that extension, and asks the extension host.
 * The model is the input's; the text document reaches the extension host before the request does,
 * since both travel the same ordered channel.
 */
export class MainThreadCustomEditors extends Disposable implements MainThreadCustomEditorsShape {
  private readonly editors = new Map<string, EditorEntry>();
  private readonly providers = new Map<string, { readonly owner: string; readonly registration: IDisposable }>();
  /** Editors this host is resolving: when the host stops, they start over in the next one. */
  private readonly resolving = new Set<CustomEditorInput>();
  private scheduled = false;
  private stopped = false;

  constructor(
    private readonly proxy: ExtHostCustomEditorsShape,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    @ICustomEditorService private readonly customEditors: ICustomEditorService,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @IEditorService editorService: IEditorService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IWebviewOriginService private readonly origins: IWebviewOriginService,
  ) {
    super();
    for (const event of [
      editorService.onDidActiveEditorChange, editorService.onDidVisibleEditorsChange, editorService.onDidCloseEditor,
      groups.onDidAddGroup, groups.onDidRemoveGroup, groups.onDidMoveGroup,
    ]) {
      this._register(event(() => this.scheduleState()));
    }
  }

  async $registerTextEditorProvider(
    extension: string, viewType: string, options: WebviewPanelOptions, supportsMultipleEditorsPerDocument: boolean,
  ): Promise<void> {
    const owner = this.getExtension(extension);
    if (!owner || typeof viewType !== 'string' || !viewType || !declares(owner, viewType)) {
      throw new Error(`The custom editor '${String(viewType)}' is not contributed by this extension.`);
    }
    if (this.stopped) {
      return;
    }
    const registration = this.customEditors.registerProvider(viewType, {
      extensionId: owner.id,
      kind: 'text',
      options: {
        retainContextWhenHidden: options?.retainContextWhenHidden === true,
        enableFindWidget: options?.enableFindWidget === true,
      },
      supportsMultipleEditorsPerDocument: supportsMultipleEditorsPerDocument === true,
      resolve: (input, token) => this.resolveText(extension, owner, input, token),
    });
    this.providers.set(viewType, { owner: extension, registration });
  }

  async $unregisterProvider(extension: string, viewType: string): Promise<void> {
    const entry = this.providers.get(viewType);
    if (entry?.owner === extension) {
      this.providers.delete(viewType);
      entry.registration.dispose();
    }
  }

  async $setHtml(extension: string, handle: string, html: string): Promise<void> {
    const entry = this.lookup(extension, handle);
    if (entry && typeof html === 'string') {
      entry.html = html;
      entry.input.webview.setContent(html, entry.options);
    }
  }

  async $setOptions(extension: string, handle: string, options: WebviewContentOptions): Promise<void> {
    const entry = this.lookup(extension, handle);
    const owner = entry && this.getExtension(extension);
    if (entry && owner) {
      entry.options = this.scope(owner, options);
      entry.input.webview.setContent(entry.html, entry.options);
    }
  }

  async $postMessage(extension: string, handle: string, message: unknown): Promise<boolean> {
    return this.lookup(extension, handle)?.input.webview.postMessage(message) ?? false;
  }

  async $reveal(extension: string, handle: string, show: WebviewShowOptions): Promise<void> {
    const entry = this.lookup(extension, handle);
    const current = entry && this.containingGroup(entry.input);
    if (!entry || !current) {
      return;
    }
    const target = typeof show?.viewColumn === 'number' ? this.targetGroup(show.viewColumn) : current;
    if (current !== target) {
      current.moveEditor(entry.input, target, { preserveFocus: show.preserveFocus === true });
    } else {
      await current.openEditor(entry.input, { preserveFocus: show?.preserveFocus === true });
    }
    this.scheduleState();
  }

  async $disposeEditor(extension: string, handle: string): Promise<void> {
    // The editor goes without asking: unsaved text stays in its model, as when any editor of it closes.
    this.lookup(extension, handle)?.input.dispose();
  }

  /** The extension is going: its editors resolve again (in the text editor if nothing provides them any more). */
  remove(extension: string): void {
    for (const [viewType, entry] of this.providers) {
      if (entry.owner === extension) {
        void this.$unregisterProvider(extension, viewType);
      }
    }
    for (const [handle, entry] of this.editors) {
      if (entry.owner === extension) {
        this.release(handle, entry);
      }
    }
  }

  /** The extension host stops: every editor waits and resolves again in the next host. */
  override dispose(): void {
    this.stopped = true;
    for (const [handle, entry] of this.editors) {
      this.release(handle, entry);
    }
    // A request this host never answers would leave the editor waiting.
    for (const input of this.resolving) {
      this.restart(input);
    }
    this.resolving.clear();
    for (const { registration } of this.providers.values()) {
      registration.dispose();
    }
    this.providers.clear();
    super.dispose();
  }

  private release(handle: string, entry: EditorEntry): void {
    this.drop(handle, entry);
    void this.proxy.$onDisposed(entry.owner, handle).catch(() => {});
    this.resolving.delete(entry.input);
    this.restart(entry.input);
  }

  private restart(input: CustomEditorInput): void {
    input.resetResolution();
    if (input.webview.isVisible) {
      // After the host that went has let go; a hidden editor resolves when it is next shown.
      queueMicrotask(() => this.customEditors.resolve(input));
    }
  }

  private async resolveText(extension: string, owner: HostExtensionDescription, input: CustomEditorInput, token: CancellationToken): Promise<void> {
    this.resolving.add(input);
    try {
      await this.doResolveText(extension, owner, input, token);
    } finally {
      this.resolving.delete(input);
    }
  }

  private async doResolveText(extension: string, owner: HostExtensionDescription, input: CustomEditorInput, token: CancellationToken): Promise<void> {
    const live = () => !this.stopped && !token.isCancellationRequested && this.getExtension(extension) === owner;
    const model = await input.acquireModel();
    if (isTooLargeForSyncing(model)) {
      throw new Error('The document is too large for extensions (more than 50 MiB).');
    }
    const handle = crypto.randomUUID();
    const origin = await this.origins.resolve(input.id);
    // An origin that cannot be set up is shown by the Webview itself, with what to configure.
    if (!live()) {
      return;
    }
    const entry: EditorEntry = { owner: extension, input, listeners: new DisposableStore(), html: '', options: this.scope(owner, {}) };
    this.editors.set(handle, entry);
    entry.listeners.add(input.onWillDispose(() => {
      if (this.drop(handle, entry)) {
        void this.proxy.$onDisposed(extension, handle).catch(() => {});
      }
    }));
    entry.listeners.add(input.webview.onDidReceiveMessage(message => {
      void this.proxy.$onMessage(extension, handle, message).catch(() => {});
    }));
    input.webview.setContent('', entry.options);
    input.webview.setOrigin(origin);
    const state = entry.state = this.viewState(input);
    try {
      await this.proxy.$resolveTextEditor(extension, handle, {
        viewType: input.viewType, resource: input.resource, documentId: model.id, title: input.getName(),
        options: input.options, contentOptions: entry.options, viewState: state,
      }, origin, token);
    } catch (error) {
      if (this.drop(handle, entry)) {
        void this.proxy.$onDisposed(extension, handle).catch(() => {});
      }
      throw error;
    }
    // Resolved after the editor was closed or asked for again: the handle is let go.
    if (token.isCancellationRequested && this.drop(handle, entry)) {
      void this.proxy.$onDisposed(extension, handle).catch(() => {});
    }
  }

  private scope(owner: HostExtensionDescription, options: WebviewContentOptions): WebviewContentOptions {
    return scopeWebviewOptions(owner.location, this.workspace.getWorkspace().folders.map(folder => folder.uri), options);
  }

  private containingGroup(input: CustomEditorInput): IEditorGroup | undefined {
    const active = this.groups.activeGroup;
    return active.contains(input) ? active : this.groups.getGroups(GroupsOrder.GRID_APPEARANCE)
      .find(group => group.isActive(input)) ?? this.groups.groups.find(group => group.contains(input));
  }

  private targetGroup(column: number): IEditorGroup {
    const id = columnToEditorGroup(this.groups, column < 0 ? column : column - 1);
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
        for (const [handle, entry] of this.editors) {
          if (entry.input.resolutionState !== CustomEditorResolution.Resolved) {
            continue;
          }
          const state = this.viewState(entry.input);
          const before = entry.state;
          if (!before || before.active !== state.active || before.visible !== state.visible || before.viewColumn !== state.viewColumn) {
            entry.state = state;
            void this.proxy.$onViewState(entry.owner, handle, state).catch(() => {});
          }
        }
      });
    }
  }

  private viewState(input: CustomEditorInput): WebviewPanelViewState {
    const group = this.containingGroup(input);
    const column = group && editorGroupToColumn(this.groups, group);
    return {
      active: this.groups.activeGroup.activeEditor === input,
      visible: input.webview.isVisible,
      viewColumn: column === undefined || column < 0 ? undefined : column + 1,
    };
  }

  private lookup(extension: string, handle: string): EditorEntry | undefined {
    const entry = this.editors.get(handle);
    return entry?.owner === extension ? entry : undefined;
  }

  private drop(handle: string, entry: EditorEntry): boolean {
    if (this.editors.get(handle) !== entry) {
      return false;
    }
    this.editors.delete(handle);
    entry.listeners.dispose();
    return true;
  }
}

mainThreadCustomers.register('customEditors', ({ rpc, instantiation, getExtension }) => {
  const editors = instantiation.createInstance(MainThreadCustomEditors, rpc.getProxy(ExtHostCustomEditorsProxy), getExtension);
  rpc.set(MainThreadCustomEditorsProxy, editors);
  return editors;
});
