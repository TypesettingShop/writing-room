import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import type { IExtensionContributions, IExtensionDescription, IExtensionMessage } from '../../../../platform/extensions/common/extensions.js';
import { ViewsExtensionHandler } from '../../../api/browser/viewsExtensionPoint.js';
import { registerCommands, registerMenus } from '../../actions/common/menusExtensionPoint.js';
import { registerExtensionKeybindings } from '../../keybinding/browser/keybindingService.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../common/extensionsRegistry.js';
import type { IExtensionPointUser } from '../common/extensionsRegistry.js';
import type { IExtensionService } from '../common/extensions.js';

type ExtensionScan = () => { extensions: readonly IExtensionDescription[]; messages: readonly IExtensionMessage[] };
type ContributionRecord = Readonly<Record<string, unknown>>;

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
  private readonly viewHandler = this._register(new ViewsExtensionHandler(this));
  private readonly registry = new ExtensionsRegistry();
  private readonly points = {
    commands: this.registry.registerExtensionPoint<unknown>('commands'),
    menus: this.registry.registerExtensionPoint<ContributionRecord>('menus'),
    keybindings: this.registry.registerExtensionPoint<unknown>('keybindings'),
    viewsContainers: this.registry.registerExtensionPoint<ContributionRecord>('viewsContainers'),
    views: this.registry.registerExtensionPoint<ContributionRecord>('views'),
  };
  private initialized = false;
  private readonly registered: Promise<boolean>;
  private finishRegistration!: (success: boolean) => void;

  constructor(private readonly scan: ExtensionScan) {
    super();
    this.registered = new Promise(resolve => { this.finishRegistration = resolve; });
    this.points.commands.setHandler((users, registrations) => registerCommands(users, registrations, this.commandOwners, this.extensionEvents));
    this.points.menus.setHandler((users, registrations) => registerMenus(users, registrations, this.commandOwners));
    this.points.keybindings.setHandler(registerExtensionKeybindings);
    this.points.viewsContainers.setHandler(users => this.viewHandler.acceptContainers(users));
    this.points.views.setHandler(users => this.viewHandler.acceptViews(users, this.extensionEvents));
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const { extensions, messages } = this.scan();
    this.scanMessages.push(...messages);
    for (const extension of [...extensions].sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin))) {
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
      this.applyContributions();
    }
    return true;
  }

  removeExtension(id: string): boolean {
    if (!this.descriptions.delete(id.toLowerCase())) {
      return false;
    }
    this.processed.delete(id.toLowerCase());
    if (this.initialized) {
      this.applyContributions();
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

  getExtensionsStatus(): Readonly<Record<string, { messages: readonly IExtensionMessage[]; activationEvents: readonly string[] }>> {
    const identifiers = new Set([...this.descriptions.keys(), ...this.messages.keys()]);
    return Object.fromEntries([...identifiers].map(id => [id, {
      messages: this.messages.get(id) ?? [],
      activationEvents: [...this.extensionEvents.get(id) ?? []],
    }]));
  }

  async activateByEvent(event: string): Promise<void> {
    this.recordedEvents.add(event);
  }

  activationEventIsDone(event: string): boolean {
    return this.recordedEvents.has(event);
  }

  whenInstalledExtensionsRegistered(): Promise<boolean> {
    return this.registered;
  }

  private applyContributions(): void {
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
      const unsupported = Object.keys(extension.manifest.contributes ?? {}).filter(key => !Object.hasOwn(this.points, key));
      if (unsupported.length) {
        this.report({ extensionId: id, severity: 'info', path: 'contributes', message: 'Unsupported contributions: ' + unsupported.join(', ') });
      }
    }

    const users = <T>(key: keyof IExtensionContributions, validate: (value: unknown) => value is T): IExtensionPointUser<T>[] => {
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
          result.push({ value, description, collector });
        }
      }
      return result;
    };
    const any = (_value: unknown): _value is unknown => true;
    contributions.add(this.points.commands.acceptUsers(users('commands', any)));
    contributions.add(this.points.menus.acceptUsers(users('menus', isRecord)));
    contributions.add(this.points.keybindings.acceptUsers(users('keybindings', any)));
    contributions.add(this.points.viewsContainers.acceptUsers(users('viewsContainers', isRecord)));
    contributions.add(this.points.views.acceptUsers(users('views', isRecord)));
    for (const message of this.scanMessages) {
      this.report(message);
    }
    this.changed.fire();
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
