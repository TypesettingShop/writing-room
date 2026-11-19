import { localizeManifest } from '../../../../platform/extensionManagement/common/extensionNls.js';
import { configurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { loadLocaleManifest } from './extensionLocalization.js';
import { isValidExtensionVersion } from '../../../../platform/extensions/common/extensionValidator.js';
import { product } from '../../../../platform/product/common/product.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionStorage } from '../../../api/browser/mainThreadStorage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { findWorkspaceActivation } from './workspaceActivation.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IWorkbenchLayoutService } from '../../layout/browser/layoutService.js';
import { RemoteExtensionIcons } from './remoteExtensionIcons.js';
import { IWebExtensionsScannerService, toExtensionDescription } from '../../extensionManagement/common/extensionManagementService.js';
import { TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { ExtensionTreeViews } from '../../../api/browser/mainThreadTreeViews.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ColorScheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { MainThreadExtensionService } from '../../../api/browser/mainThreadExtensionService.js';
import { ExtHostContext } from '../../../api/common/extHost.protocol.js';
import type { ExtHostExtensionServiceShape } from '../../../api/common/extHost.protocol.js';
import type { ExtensionHostStatus, HostExtensionDescription } from '../common/extensionHostProtocol.js';
import { resolveExtensionEntry } from '../common/extensionResources.js';
import { WebWorkerExtensionHost } from './webWorkerExtensionHost.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../platform/extensions/common/extensions.js';
import { ViewsExtensionHandler } from '../../../api/browser/viewsExtensionPoint.js';
import '../../actions/common/menusExtensionPoint.js';
import '../../keybinding/browser/keybindingsExtensionPoint.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../common/extensionsRegistry.js';
import type { ExtensionPointContext, IExtensionPointUser } from '../common/extensionsRegistry.js';
import type { IExtensionService } from '../common/extensions.js';

configurationRegistry.registerConfiguration({
  id: 'extensions.runtime',
  properties: { locale: { type: 'string', default: 'en', description: 'Language for extensions. Takes effect when the workbench restarts.' } },
});

type ExtensionScan = () => { extensions: readonly IExtensionDescription[]; messages: readonly IExtensionMessage[] };
interface HostSession {
  readonly worker: WebWorkerExtensionHost;
  readonly main: MainThreadExtensionService;
  readonly proxy: ExtHostExtensionServiceShape;
  registered: Map<string, HostExtensionDescription>;
  desired: Set<string>;
  readonly removing: Map<string, () => void>;
  synchronized: Promise<void>;
}

export class ExtensionService extends Disposable implements IExtensionService {
  declare readonly _serviceBrand: undefined;
  private readonly descriptions = new Map<string, IExtensionDescription>();
  private readonly messages = new Map<string, IExtensionMessage[]>();
  private readonly scanMessages: IExtensionMessage[] = [];
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChangeExtensions = this.changed.event;

  protected readonly recordedEvents = new Set<string>();
  protected readonly commandOwners = new Map<string, string>();
  protected readonly extensionEvents = new Map<string, Set<string>>();
  private readonly processed = new Map<string, Set<string>>();
  private readonly contributions = this._register(new MutableDisposable<DisposableStore>());
  private readonly treeViews = this._register(new ExtensionTreeViews());
  private readonly viewHandler = this._register(new ViewsExtensionHandler((parent, viewId) =>
    this.instantiation?.createInstance(TreeViewPane, parent, viewId, this, this.treeViews)));
  private readonly remoteIcons?: RemoteExtensionIcons;
  private initialized = false;
  private applying = false;
  private readonly activationStatus = new Map<string, ExtensionHostStatus>();
  private readonly extensionKeys = new Map<IExtensionDescription, string>();
  private nextExtensionKey = 0;
  private host?: HostSession;
  private hostFailure?: Error;
  private locale = 'en';
  private readonly localized = new WeakMap<IExtensionDescription, Readonly<Record<string, string>>>();
  private workspaceId?: string;
  private readonly incompatible = new Set<string>();
  private readonly removals = new Map<string, Promise<void>>();
  private readonly workspaceSearch = new AbortController();
  private readonly eventOperations = new Map<string, Promise<void>>();
  private readonly completedEvents = new Set<string>();
  private stopping = false;
  private readonly registered: Promise<boolean>;
  private finishRegistration!: (success: boolean) => void;

  constructor(
    private readonly scan: ExtensionScan,
    @IInstantiationService private readonly instantiation?: IInstantiationService,
    @IWebExtensionsScannerService private readonly installedScanner?: IWebExtensionsScannerService,
    @IThemeService private readonly themeService?: IThemeService,
  ) {
    super();
    this.registered = new Promise(resolve => { this.finishRegistration = resolve; });
    if (instantiation) {
      const workbench = instantiation.invokeFunction(accessor => accessor.get(IWorkbenchLayoutService).mainContainer);
      this.remoteIcons = this._register(new RemoteExtensionIcons(workbench));
      this._register(addDisposableListener(window, 'pagehide', event => {
        // A bfcache restore resumes the same workbench and worker.
        if (!event.persisted) {
          this.stopping = true;
          this.workspaceSearch.abort();
          this.host?.worker.shutdown();
        }
      }));
    }
    const refreshContributions = () => {
      if (this.initialized && !this.applying) {
        this.applyContributions();
      }
    };
    this._register(ExtensionsRegistry.onDidChange(refreshContributions));
    if (themeService) {
      this._register(themeService.onDidColorThemeChange(refreshContributions));
    }
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.instantiation?.invokeFunction(accessor => {
      const locale = accessor.get(IConfigurationService).getValue('locale');
      if (typeof locale === 'string' && /^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/i.test(locale)) {
        this.locale = locale.toLowerCase();
      }
      this.workspaceId = accessor.get(IWorkspaceContextService).getWorkspace().id;
    });
    const { extensions, messages } = this.scan();
    this.scanMessages.push(...messages);
    const installed = this.installedScanner?.scanUserExtensions().map(toExtensionDescription) ?? [];
    for (const extension of [...extensions, ...installed].sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin))) {
      this.addDescription(extension);
    }
    const finish = () => {
      this.applyContributions();
      this.finishRegistration(true);
      if (this.instantiation) {
        void this.searchWorkspaceActivation().catch(error => console.warn('Workspace activation search failed:', error));
      }
    };
    if (this.locale === 'en' || !this.instantiation) {
      finish();
    } else {
      void Promise.all(this.extensions.map(extension => this.readLocalizedManifest(extension))).then(() => {
        if (!this.stopping) {
          finish();
        }
      }).catch(error => {
        this.finishRegistration(false);
        console.error('Could not register localized extension contributions:', error);
      });
    }
  }

  get extensions(): readonly IExtensionDescription[] {
    return [...this.descriptions.values()];
  }

  addExtension(extension: IExtensionDescription): boolean {
    if (!this.addDescription(extension)) {
      return false;
    }
    if (this.initialized) {
      try {
        this.applyContributions();
        if (this.locale !== 'en') {
          void this.readLocalizedManifest(extension).then(changed => {
            if (changed && !this.stopping && this.descriptions.get(extension.identifier.value) === extension) {
              this.applyContributions();
            }
          }).catch(error => console.warn(`[${extension.identifier.value}] Could not localize contributions:`, error));
        }
      } catch (error) {
        this.removeExtension(extension.identifier.value);
        throw error;
      }
    }
    return true;
  }

  removeExtension(id: string): boolean {
    const identifier = id.toLowerCase();
    const description = this.descriptions.get(identifier);
    if (!description) {
      return false;
    }
    const containers = this.viewHandler.containerIds(identifier);
    this.descriptions.delete(identifier);
    this.processed.delete(identifier);
    this.activationStatus.delete(identifier);
    this.extensionKeys.delete(description);
    this.remoteIcons?.remove(identifier);
    if (this.initialized) {
      this.applyContributions();
      if (containers.length) {
        this.instantiation?.invokeFunction(accessor => {
          const views = accessor.get(IViewDescriptorService);
          views.forgetViewContainerPlacements(containers.filter(id => !views.getViewContainerById(id)));
        });
      }
    }
    return true;
  }

  async clearExtensionStorage(id: string): Promise<void> {
    await this.instantiation?.invokeFunction(accessor => accessor.get(IExtensionStorage).clear(id.toLowerCase()));
  }

  async whenExtensionRemoved(id: string): Promise<void> {
    await this.removals.get(id.toLowerCase());
  }

  private async searchWorkspaceActivation(): Promise<void> {
    const prefix = 'workspaceContains:';
    const events = new Set([...this.extensionEvents.values()].flatMap(events => [...events])
      .filter(event => event.startsWith(prefix)));
    if (!events.size) {
      return;
    }
    const { files, folders } = this.instantiation!.invokeFunction(accessor => ({
      files: accessor.get(IFileService),
      folders: accessor.get(IWorkspaceContextService).getWorkspace().folders,
    }));
    await Promise.all([...events].map(async event => {
      if (await findWorkspaceActivation(files, folders, event.slice(prefix.length), this.workspaceSearch.signal)) {
        await this.activateByEvent(event);
      }
    }));
  }

  private async readLocalizedManifest(extension: IExtensionDescription): Promise<boolean> {
    const files = this.instantiation?.invokeFunction(accessor => accessor.get(IFileService));
    const localized = files && await loadLocaleManifest(files, extension, this.locale);
    if (!localized) {
      return false;
    }
    this.localized.set(extension, localized);
    return true;
  }

  private addDescription(extension: IExtensionDescription): boolean {
    const id = extension.identifier.value;
    if (this.descriptions.has(id)) {
      const message: IExtensionMessage = { extensionId: id, severity: 'error', path: 'publisher/name', message: 'Duplicate extension identifier.' };
      if (this.initialized) {
        this.report(message);
      } else {
        this.scanMessages.push(message);
      }
      return false;
    }
    this.descriptions.set(id, extension);
    return true;
  }

  getExtensionsStatus(): Readonly<Record<string, { messages: readonly IExtensionMessage[]; activationEvents: readonly string[]; activation: ExtensionHostStatus }>> {
    const identifiers = new Set([...this.descriptions.keys(), ...this.messages.keys()]);
    return Object.fromEntries([...identifiers].map(id => [id, {
      messages: this.messages.get(id) ?? [],
      activationEvents: [...this.extensionEvents.get(id) ?? []],
      activation: this.activationStatus.get(id) ?? { state: 'inactive' },
    }]));
  }

  async activateByEvent(event: string, origin?: string): Promise<void> {
    this.recordedEvents.add(event);
    if (event === 'onStartupFinished' && !this.recordedEvents.has('*')) {
      // The default startup events can activate different extensions concurrently.
      void this.activateByEvent('*').catch(() => {});
    }
    if (!this.instantiation || this.applying || this.stopping) {
      return;
    }
    for (const [id, events] of this.extensionEvents) {
      if (events.has(event)) {
        this.remoteIcons?.activate(id);
      }
    }
    if (!this.matches(event) && !(origin && this.host)) {
      return;
    }
    if (this.hostFailure) {
      if (event.startsWith('onCommand:') && this.commandOwners.has(event.slice('onCommand:'.length))) {
        throw this.hostFailure;
      }
      return;
    }
    if (origin) {
      await this.dispatch(event, origin);
      return;
    }
    let operation = this.eventOperations.get(event);
    if (!operation) {
      operation = this.dispatch(event).then(() => {
        if (this.eventOperations.get(event) === operation) {
          this.completedEvents.add(event);
        }
      }).catch(error => {
        if (event.startsWith('onCommand:')) {
          throw error;
        }
      }).finally(() => {
        if (this.eventOperations.get(event) === operation) {
          this.eventOperations.delete(event);
        }
      });
      this.eventOperations.set(event, operation);
    }
    await operation;
  }

  activationEventIsDone(event: string): boolean {
    return this.recordedEvents.has(event) && (!this.instantiation || !this.matches(event) || this.completedEvents.has(event));
  }

  async restartExtensionHost(): Promise<void> {
    this.stopHost();
    this.hostFailure = undefined;
    await this.replayEvents();
  }

  private matches(event: string): boolean {
    return this.extensions.some(extension => extension.manifest.browser && !this.incompatible.has(extension.identifier.value)
      && this.extensionEvents.get(extension.identifier.value)?.has(event));
  }

  private async dispatch(event: string, origin?: string): Promise<void> {
    if (this.completedEvents.has(event) && !origin) {
      return;
    }
    const host = this.host ?? this.startHost();
    await host.synchronized;
    await host.proxy.$activateByEvent(event, origin);
  }

  private hostDescriptions(): Map<string, HostExtensionDescription> {
    const result = new Map<string, HostExtensionDescription>();
    for (const description of this.extensions) {
      const { identifier, location, manifest } = description;
      const entry = !this.incompatible.has(identifier.value) && manifest.browser && resolveExtensionEntry(location, manifest.browser);
      let key = this.extensionKeys.get(description);
      if (!key) {
        key = String(++this.nextExtensionKey);
        this.extensionKeys.set(description, key);
      }
      result.set(key, { id: identifier.value, key, location, entry: entry ? entry.href : '', manifest,
        disabled: this.incompatible.has(identifier.value),
        runtime: { locale: this.locale, workspaceId: this.workspaceId },
        activationEvents: [...this.extensionEvents.get(identifier.value) ?? []], views: this.viewHandler.viewIds(identifier.value) });
    }
    return result;
  }

  private startHost(): HostSession {
    const registered = this.hostDescriptions();
    const worker = new WebWorkerExtensionHost([...registered.values()]);
    const host: HostSession = {
      worker, registered, desired: new Set(registered.keys()), removing: new Map(), synchronized: worker.ready,
      proxy: worker.rpc.getProxy(ExtHostContext.ExtHostExtensionService),
      main: this.instantiation!.createInstance(MainThreadExtensionService, worker.rpc, {
        getExtension: key => this.host === host ? host.registered.get(key) : undefined,
        commandOwner: id => this.commandOwners.get(id),
        activate: (event, origin) => this.activateByEvent(event, origin),
        setStatus: (key, status) => {
          const id = host.registered.get(key)?.id;
          if (this.host === host && id) {
            const finishRemoval = host.removing.get(key);
            if (finishRemoval && status.state === 'inactive') {
              host.registered.delete(key);
              host.removing.delete(key);
              host.main.remove(key);
              finishRemoval();
              return;
            }
            if (finishRemoval) {
              return;
            }
            this.activationStatus.set(id, status);
            if (status.state === 'failed') {
              host.main.remove(key);
            }
          }
        },
      }, this.treeViews),
    };
    this.host = host;
    worker.onDidExit(error => {
      if (this.host === host) {
        this.hostFailure = error;
        this.stopHost();
        if (!this.stopping) {
          console.warn(error.message);
        }
      }
    });
    return host;
  }

  private stopHost(): void {
    const host = this.host;
    this.host = undefined;
    this.eventOperations.clear();
    this.completedEvents.clear();
    this.activationStatus.clear();
    host?.main.dispose();
    host?.worker.dispose();
    for (const finishRemoval of host?.removing.values() ?? []) {
      finishRemoval();
    }
  }

  private extensionsChanged(): void {
    this.completedEvents.clear();
    this.eventOperations.clear();
    const host = this.host;
    if (host) {
      const next = this.hostDescriptions();
      const removed = [...host.desired].filter(key => !next.has(key));
      host.desired = new Set(next.keys());
      for (const key of removed) {
        const { id } = host.registered.get(key)!;
        const previous = this.removals.get(id);
        const removal = new Promise<void>(resolve => host.removing.set(key, resolve));
        const completed = Promise.all([previous, removal]).then(() => {
          if (this.removals.get(id) === completed) {
            this.removals.delete(id);
          }
        });
        this.removals.set(id, completed);
      }
      for (const [key, description] of next) {
        host.registered.set(key, description);
      }
      host.synchronized = host.synchronized.then(() => host.proxy.$deltaExtensions([...next.values()], removed));
      // A replay may match no event, so nothing else is sure to await this chain before the host stops.
      host.synchronized.catch(() => {});
    }
    void this.replayEvents().catch(() => {});
  }

  private async replayEvents(): Promise<void> {
    await Promise.all([...this.recordedEvents].map(event => this.activateByEvent(event)));
  }

  override dispose(): void {
    this.stopping = true;
    this.workspaceSearch.abort();
    this.stopHost();
    super.dispose();
  }

  whenInstalledExtensionsRegistered(): Promise<boolean> {
    return this.registered;
  }

  private applyContributions(): void {
    this.applying = true;
    try {
      this.registerContributions();
    } finally {
      this.applying = false;
    }
    this.extensionsChanged();
    this.changed.fire();
  }

  private registerContributions(): void {
    this.contributions.clear();
    this.messages.clear();
    this.extensionEvents.clear();
    this.commandOwners.clear();
    this.incompatible.clear();
    const contributions = new DisposableStore();
    this.contributions.value = contributions;
    const entries = this.extensions.map(extension => ({
      ...extension, manifest: localizeManifest(extension.manifest, this.localized.get(extension) ?? extension.nls),
    }));
    for (const extension of entries) {
      const id = extension.identifier.value;
      const { manifest } = extension;
      this.extensionEvents.set(id, new Set(manifest.activationEvents));
      const range = manifest.engines?.vscode;
      if (range !== undefined && (typeof range !== 'string' || !isValidExtensionVersion(product.version, range))) {
        this.incompatible.add(id);
        this.report({ extensionId: id, severity: 'warn', path: 'engines.vscode', message: `This extension requires VS Code ${String(range)}. Writing Room provides API ${product.version}.` });
      }
      if (Array.isArray(manifest.enabledApiProposals) && manifest.enabledApiProposals.length) {
        this.report({ extensionId: id, severity: 'info', path: 'enabledApiProposals', message: 'Proposed APIs are not supported.' });
      }
      if (manifest.main && !manifest.browser) {
        this.report({ extensionId: id, severity: 'info', path: 'main', message: 'This extension has no web entry point. Only its contributions are available.' });
      }
      const unsupported = Object.keys(extension.manifest.contributes ?? {}).filter(key => !ExtensionsRegistry.has(key));
      if (unsupported.length) {
        this.report({ extensionId: id, severity: 'info', path: 'contributes', message: 'Unsupported contributions: ' + unsupported.join(', ') });
      }
    }

    const users = <T>(key: string, validate: (value: unknown) => value is T): IExtensionPointUser<T>[] => {
      const result: IExtensionPointUser<T>[] = [];
      for (const description of entries) {
        const value = description.manifest.contributes?.[key];
        if (value === undefined) {
          continue;
        }
        const collector = new ExtensionMessageCollector(description.identifier.value, message => this.report(message));
        if (!validate(value)) {
          collector.error('contributes.' + key, 'Expected a contribution object.');
        } else {
          const id = description.identifier.value;
          const resolveIcon = description.isBuiltin ? undefined
            : (url: URL) => this.remoteIcons?.resolve(id, url) ?? url;
          result.push({ value, description, collector, resolveIcon });
        }
      }
      return result;
    };
    const colorScheme = this.themeService?.getColorTheme().type;
    const context: ExtensionPointContext = {
      instantiation: this.instantiation,
      isLightTheme: colorScheme === ColorScheme.LIGHT || colorScheme === ColorScheme.HIGH_CONTRAST_LIGHT,
      viewHandler: this.viewHandler,
      addActivationEvent: (id, event) => this.extensionEvents.get(id)?.add(event),
      setCommandOwner: (command, id) => this.commandOwners.set(command, id),
      getCommandOwner: command => this.commandOwners.get(command),
    };
    for (const point of ExtensionsRegistry.getExtensionPoints()) {
      const registrations = contributions.add(new DisposableStore());
      try {
        point.accept(users(point.name, point.validate), registrations, context);
      } catch (error) {
        registrations.dispose();
        throw error;
      }
    }
    for (const message of this.scanMessages) {
      this.report(message);
    }
  }

  protected report(message: IExtensionMessage): void {
    const { extensionId, path, severity } = message;
    const entries = this.messages.get(extensionId) ?? [];
    entries.push(message);
    this.messages.set(extensionId, entries);
    const key = JSON.stringify(message);
    const seen = this.processed.get(extensionId) ?? new Set();
    this.processed.set(extensionId, seen);
    if (!seen.has(key)) {
      seen.add(key);
      console[severity](`[${extensionId}] ${path}: ${message.message}`);
    }
  }
}
