import { IViewDescriptorService } from '../../../common/views.js';
import { IWorkbenchLayoutService } from '../../layout/browser/layoutService.js';
import { RemoteExtensionIcons } from './remoteExtensionIcons.js';
import { IWebExtensionsScannerService, toExtensionDescription } from '../../extensionManagement/common/extensionManagementService.js';
import { TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { ExtensionTreeViews } from '../../../api/browser/mainThreadTreeViews.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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

type ExtensionScan = () => { extensions: readonly IExtensionDescription[]; messages: readonly IExtensionMessage[] };
interface HostSession {
  readonly worker: WebWorkerExtensionHost;
  readonly main: MainThreadExtensionService;
  readonly proxy: ExtHostExtensionServiceShape;
  registered: Map<string, HostExtensionDescription>;
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
  private readonly eventOperations = new Map<string, Promise<void>>();
  private readonly completedEvents = new Set<string>();
  private stopping = false;
  private readonly registered: Promise<boolean>;
  private finishRegistration!: (success: boolean) => void;

  constructor(
    private readonly scan: ExtensionScan,
    @IInstantiationService private readonly instantiation?: IInstantiationService,
    @IWebExtensionsScannerService private readonly installedScanner?: IWebExtensionsScannerService,
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
          this.host?.worker.shutdown();
        }
      }));
    }
    this._register(ExtensionsRegistry.onDidChange(() => {
      if (this.initialized && !this.applying) {
        this.applyContributions();
      }
    }));
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const { extensions, messages } = this.scan();
    this.scanMessages.push(...messages);
    const installed = this.installedScanner?.scanUserExtensions().map(toExtensionDescription) ?? [];
    for (const extension of [...extensions, ...installed].sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin))) {
      this.addDescription(extension);
    }
    this.applyContributions();
    this.finishRegistration(true);
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
    if (!this.matches(event)) {
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
    return this.extensions.some(extension => extension.manifest.browser
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
      const entry = manifest.browser && resolveExtensionEntry(location, manifest.browser);
      if (!entry) {
        continue;
      }
      let key = this.extensionKeys.get(description);
      if (!key) {
        key = String(++this.nextExtensionKey);
        this.extensionKeys.set(description, key);
      }
      result.set(key, { id: identifier.value, key, location, entry: entry.href, manifest,
        activationEvents: [...this.extensionEvents.get(identifier.value) ?? []], views: this.viewHandler.viewIds(identifier.value) });
    }
    return result;
  }

  private startHost(): HostSession {
    const registered = this.hostDescriptions();
    const worker = new WebWorkerExtensionHost([...registered.values()]);
    const host: HostSession = {
      worker, registered, synchronized: worker.ready,
      proxy: worker.rpc.getProxy(ExtHostContext.ExtHostExtensionService),
      main: this.instantiation!.createInstance(MainThreadExtensionService, worker.rpc, {
        getExtension: key => this.host === host ? host.registered.get(key) : undefined,
        commandOwner: id => this.commandOwners.get(id),
        activate: (event, origin) => this.activateByEvent(event, origin),
        setStatus: (key, status) => {
          const id = host.registered.get(key)?.id;
          if (this.host === host && id) {
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
  }

  private extensionsChanged(): void {
    this.completedEvents.clear();
    this.eventOperations.clear();
    const host = this.host;
    if (host) {
      const next = this.hostDescriptions();
      const removed = [...host.registered.keys()].filter(key => !next.has(key));
      host.registered = next;
      for (const key of removed) {
        host.main.remove(key);
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
    const contributions = new DisposableStore();
    this.contributions.value = contributions;
    const entries = this.extensions;
    for (const extension of entries) {
      const id = extension.identifier.value;
      this.extensionEvents.set(id, new Set(extension.manifest.activationEvents));
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
    const context: ExtensionPointContext = {
      instantiation: this.instantiation,
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
