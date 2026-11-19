import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqual } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { IResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import {
  DEFAULT_EDITOR_ID, IEditorResolverService, RegisteredEditorPriority,
} from '../../../services/editor/common/editorResolverService.js';
import type { EditorInputWithOptions } from '../../../services/editor/common/editorResolverService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { isTextFileResource } from '../../../services/textfile/common/textfiles.js';
import { CONTEXT_ACTIVE_CUSTOM_EDITOR_ID, customEditorContributions, customEditorMatches } from '../common/customEditor.js';
import type { CustomEditorContributions, CustomEditorInfo } from '../common/customEditor.js';
import { CustomEditorInput, CustomEditorResolution } from './customEditorInput.js';
import { ICustomEditorService } from './customEditorService.js';
import type { ICustomEditorProvider } from './customEditorService.js';

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Puts the contributed custom editors in the editor resolver and resolves their inputs with the
 * providers extensions register.
 *
 * Which editor opens a resource (no association, no override): the one `default` custom editor whose
 * pattern takes it; when two or more `default` editors take it, the text editor, so that none of them
 * wins by the order of installation. VS Code asks the user in that case and remembers the answer.
 * Each editor registers twice with the resolver, at `default` and at `option`, and exactly one of the
 * two takes a given resource, so "Reopen Editor With..." and `override` find every editor once.
 */
export class CustomEditorService extends Disposable implements ICustomEditorService {
  declare readonly _serviceBrand: undefined;

  private readonly providers = new Map<string, ICustomEditorProvider>();
  private readonly registered = new Map<string, { readonly info: CustomEditorInfo; readonly registration: IDisposable }>();
  /** `viewType`s whose missing provider was already told about; once each per page. */
  private readonly reported = new Set<string>();
  private reconciling = false;
  private extensionsRegistered = false;

  constructor(
    private readonly contributions: CustomEditorContributions,
    @IEditorResolverService private readonly resolver: IEditorResolverService,
    @IExtensionService private readonly extensions: IExtensionService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @INotificationService private readonly notifications: INotificationService,
    @IFileService private readonly files: IFileService,
    @IContextKeyService contextKeys: IContextKeyService,
  ) {
    super();
    this._register(toDisposable(() => {
      for (const { registration } of this.registered.values()) {
        registration.dispose();
      }
      this.registered.clear();
    }));
    // The extension point puts a whole new list in place on each change; read it once it settled.
    this._register(contributions.onDidChange(() => this.scheduleReconcile()));
    this.reconcile();
    void extensions.whenInstalledExtensionsRegistered().then(() => {
      this.extensionsRegistered = true;
      this.scheduleReconcile();
    });

    const activeId = CONTEXT_ACTIVE_CUSTOM_EDITOR_ID.bindTo(contextKeys);
    const update = () => {
      const editor = groups.activeGroup.activeEditor;
      activeId.set(editor instanceof CustomEditorInput ? editor.viewType : undefined);
    };
    this._register(groups.onDidActiveEditorChange(update));
    this._register(groups.onDidChangeActiveGroup(update));
    update();
  }

  registerProvider(viewType: string, provider: ICustomEditorProvider): IDisposable {
    if (this.providers.has(viewType)) {
      throw new Error(`A custom editor provider is already registered for '${viewType}'.`);
    }
    this.providers.set(viewType, provider);
    return toDisposable(() => {
      if (this.providers.get(viewType) === provider) {
        this.providers.delete(viewType);
      }
    });
  }

  getProvider(viewType: string): ICustomEditorProvider | undefined {
    return this.providers.get(viewType);
  }

  resolve(input: CustomEditorInput): void {
    if (input.isDisposed() || input.resolutionState !== CustomEditorResolution.Pending) {
      return;
    }
    const { generation, token } = input.startResolution();
    // Taken now, before anything waits: a text editor of the same file that this editor replaces lets
    // go of the model only after this, so the model (and its unsaved text) stays.
    if (input.kind === 'text' && input.resource.scheme !== Schemas.untitled) {
      input.acquireModel().catch(() => {});
    }
    void (async () => {
      await this.extensions.whenInstalledExtensionsRegistered();
      if (!input.isResolving(generation)) {
        return;
      }
      const info = this.contributions.get(input.viewType);
      const provider = info && await this.activateProvider(info.id);
      if (!input.isResolving(generation)) {
        return;
      }
      if (!info || !provider) {
        await this.reopenInTextEditor(input, info?.displayName ?? input.viewType);
        return;
      }
      if (provider.kind !== input.kind) {
        throw new Error('the extension provides it differently now; reopen the editor.');
      }
      if (input.kind === 'text') {
        await input.acquireModel();
        if (!input.isResolving(generation)) {
          return;
        }
      }
      await provider.resolve(input, token);
      input.completeResolution(generation);
    })().catch(error => input.completeResolution(generation, 'The custom editor could not be opened: ' + describeError(error)));
  }

  /** Wakes the extension behind `viewType` and gives what it registered, if it did. */
  private async activateProvider(viewType: string): Promise<ICustomEditorProvider | undefined> {
    await this.extensions.activateByEvent('onCustomEditor:' + viewType);
    return this.providers.get(viewType);
  }

  /** The text editor in `input`'s place, in each group that shows it; told once per `viewType`. */
  private async reopenInTextEditor(input: CustomEditorInput, name: string): Promise<void> {
    this.reportMissing(input.viewType, name);
    for (const group of this.groups.groups.filter(candidate => candidate.contains(input))) {
      const resolved = await this.resolver.resolveEditor({ resource: input.resource, options: { override: DEFAULT_EDITOR_ID } }, group);
      if (!input.isDisposed() && group.contains(input)) {
        await group.replaceEditors([{ editor: input, replacement: resolved.editor }]);
      }
    }
  }

  private reportMissing(viewType: string, name: string): void {
    if (!this.reported.has(viewType)) {
      this.reported.add(viewType);
      this.notifications.info(`The custom editor '${name}' is unavailable. Its files open in the text editor.`);
    }
  }

  private scheduleReconcile(): void {
    if (!this.reconciling) {
      this.reconciling = true;
      queueMicrotask(() => {
        this.reconciling = false;
        if (!this.disposed) {
          this.reconcile();
        }
      });
    }
  }

  private disposed = false;

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }

  /** Brings the resolver's registrations in line with the contributions, and drops editors whose type went. */
  private reconcile(): void {
    const current = new Map(this.contributions.editors.map(info => [info.id, info]));
    for (const [viewType, entry] of this.registered) {
      if (current.get(viewType) !== entry.info) {
        entry.registration.dispose();
        this.registered.delete(viewType);
      }
    }
    for (const info of current.values()) {
      if (!this.registered.has(info.id)) {
        this.registered.set(info.id, { info, registration: this.registerWithResolver(info) });
      }
    }
    // Before the installed extensions are registered, every type looks missing.
    if (this.extensionsRegistered) {
      const orphans = this.groups.groups.flatMap(group => group.editors)
        .filter((editor): editor is CustomEditorInput => editor instanceof CustomEditorInput && !current.has(editor.viewType));
      for (const input of new Set(orphans)) {
        void this.reopenInTextEditor(input, input.viewType).catch(error => console.error(error));
      }
    }
  }

  private registerWithResolver(info: CustomEditorInfo): IDisposable {
    const store = new DisposableStore();
    const label = { id: info.id, label: info.displayName, detail: info.providerDisplayName };
    const supported = (resource: URI) => resource.scheme === Schemas.untitled || isTextFileResource(resource, this.files);
    const create = (input: IResourceEditorInput, group: IEditorGroup) => this.createEditor(info, input, group);
    for (const pattern of info.filenamePatterns) {
      if (info.priority === 'default') {
        store.add(this.resolver.registerEditor(pattern, { ...label, priority: RegisteredEditorPriority.default },
          { canSupportResource: resource => supported(resource) && this.soleDefault(resource) === info }, create));
        store.add(this.resolver.registerEditor(pattern, { ...label, priority: RegisteredEditorPriority.option },
          { canSupportResource: resource => supported(resource) && this.soleDefault(resource) !== info }, create));
      } else {
        store.add(this.resolver.registerEditor(pattern, { ...label, priority: RegisteredEditorPriority.option },
          { canSupportResource: supported }, create));
      }
    }
    return store;
  }

  /** The only `default` custom editor that takes `resource`, if exactly one does. */
  private soleDefault(resource: URI): CustomEditorInfo | undefined {
    const defaults = this.contributions.editors.filter(info => info.priority === 'default' && customEditorMatches(info, resource));
    return defaults.length === 1 ? defaults[0] : undefined;
  }

  /**
   * The input for `resource` in `group`. The extension is woken first, so the provider's options are
   * known; without a provider the text editor opens instead. One editor per resource, unless the
   * provider allows more: an open one moves to `group`, as in VS Code.
   */
  private async createEditor(info: CustomEditorInfo, { resource, options }: IResourceEditorInput, group: IEditorGroup): Promise<EditorInputWithOptions> {
    await this.extensions.whenInstalledExtensionsRegistered();
    const provider = await this.activateProvider(info.id);
    if (!provider || this.contributions.get(info.id) !== info) {
      this.reportMissing(info.id, info.displayName);
      const text = await this.resolver.resolveEditor({ resource, options: { ...options, override: DEFAULT_EDITOR_ID } }, group);
      return { editor: text.editor, options: text.options };
    }
    if (!provider.supportsMultipleEditorsPerDocument) {
      for (const holder of this.groups.groups) {
        const open = holder.editors.find((editor): editor is CustomEditorInput => editor instanceof CustomEditorInput
          && editor.viewType === info.id && isEqual(editor.resource, resource));
        if (open) {
          if (holder !== group && this.groups.getGroup(group.id) === group) {
            holder.moveEditor(open, group, { inactive: true, preserveFocus: true });
          }
          return { editor: open, options };
        }
      }
    }
    const editor = this.instantiation.createInstance(CustomEditorInput, resource, info.id, info.extensionId,
      provider.options, provider.supportsMultipleEditorsPerDocument, provider.kind);
    return { editor, options };
  }
}

registerSingleton(ICustomEditorService, new SyncDescriptor(CustomEditorService, [customEditorContributions]));
