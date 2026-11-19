import type * as vscode from 'vscode';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { EventEmitter, Uri } from './extHostTypes.js';
import { dispose } from '../../../base/common/lifecycle.js';
import type { MainThreadExtensionServiceShape } from './extHost.protocol.js';

export interface IExtensionModule {
  activate?(context: vscode.ExtensionContext): unknown;
  deactivate?(): unknown;
}

export type ExtensionLoader = (
  extension: HostExtensionDescription, api: typeof vscode, signal: AbortSignal,
) => Promise<IExtensionModule>;

type BaseExtensionContext = Pick<vscode.ExtensionContext, 'subscriptions' | 'extensionUri'> & {
  readonly extension: vscode.Extension<unknown>;
};

class Activation {
  readonly abort = new AbortController();
  readonly aborted = new Promise<void>(resolve => {
    this.abort.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  readonly subscriptions: vscode.ExtensionContext['subscriptions'] = [];
  readonly context: BaseExtensionContext;
  module?: IExtensionModule;
  exports?: unknown;
  readonly commands = new Set<string>();
  readonly waitingFor = new Map<Activation, number>();
  operation?: Promise<void>;
  state: 'inactive' | 'activating' | 'active' | 'failed' | 'deactivating' = 'inactive';


  constructor(public description: HostExtensionDescription, ownExtension: () => vscode.Extension<unknown>) {
    this.context = {
      subscriptions: this.subscriptions,
      extensionUri: Uri.parse(description.location),
      get extension() { return ownExtension(); },
    };
  }
}

export interface ExtensionActivationAccess {
  readonly commands: Set<string>;
  readonly all: () => readonly vscode.Extension<unknown>[];
  readonly getExtension: (id: string) => vscode.Extension<unknown> | undefined;
  readonly onDidChange: vscode.Event<void>;
  prepare?: () => Promise<void>;
}

export const extensionActivation = new WeakMap<HostExtensionDescription, ExtensionActivationAccess>();

export class ExtensionsActivator {
  private readonly extensions = new Map<string, Activation>();
  private readonly removing = new Set<Activation>();
  private readonly onDidChange = new EventEmitter<void>();

  constructor(
    private readonly main: MainThreadExtensionServiceShape,
    private readonly load: ExtensionLoader,
    private readonly createApi: (
      extension: HostExtensionDescription, isLive: () => boolean, context: BaseExtensionContext,
    ) => { api: typeof vscode; context: vscode.ExtensionContext },
    private readonly flush: (key: string) => Promise<void>,
    private readonly release: (key: string) => void,
  ) {}

  isLive(key: string): boolean {
    const extension = this.extensions.get(key);
    return extension?.state === 'activating' || extension?.state === 'active' || extension?.state === 'deactivating';
  }

  getViews(key: string): readonly string[] {
    return this.extensions.get(key)?.description.views ?? [];
  }

  deltaExtensions(added: readonly HostExtensionDescription[], removed: readonly string[]): void {
    let changed = false;
    for (const key of removed) {
      const extension = this.extensions.get(key);
      if (extension && !this.removing.has(extension)) {
        this.removing.add(extension);
        changed = true;
        void this.deactivate(extension);
      }
    }
    for (const description of added) {
      const existing = this.extensions.get(description.key);
      if (existing) {
        existing.description = description;
      } else {
        const activation: Activation = new Activation(description, () => this.extensionView(activation, activation));
        this.extensions.set(description.key, activation);
        changed = true;
      }
    }
    if (changed) {
      this.onDidChange.fire();
    }
  }

  private extensionView(target: Activation, caller: Activation): vscode.Extension<unknown> {
    const activator = this;
    const { id, key, location } = target.description;
    const extensionUri = Uri.parse(location);
    const isActive = () => target.state === 'active' || target.state === 'deactivating';
    return Object.freeze({
      id, extensionUri, extensionPath: extensionUri.fsPath,
      get isActive() { return isActive(); },
      get packageJSON() { return structuredClone(target.description.manifest); },
      extensionKind: 2 as vscode.ExtensionKind.Workspace,
      get exports() { return isActive() ? target.exports : undefined; },
      async activate() {
        if (!activator.isLive(caller.description.key) || activator.extensions.get(key) !== target
          || activator.removing.has(target)) {
          throw new Error(`Extension '${id}' is no longer available.`);
        }
        if (target.state !== 'active' && activator.reaches(target, caller)) {
          throw new Error(`Cyclic activation request for '${id}'.`);
        }
        await activator.waitFor(caller, target, false);
        if (target.state !== 'active') {
          throw new Error(`Extension '${id}' did not activate.`);
        }
        return target.exports;
      },
    });
  }

  private catalog(caller: Activation): ExtensionActivationAccess {
    const available = () => [...this.extensions.values()].filter(extension => !this.removing.has(extension));
    return {
      commands: caller.commands,
      all: () => available().map(extension => this.extensionView(extension, caller)),
      getExtension: id => {
        const match = available().find(extension => extension.description.id.toLowerCase() === id.toLowerCase());
        return match && this.extensionView(match, caller);
      },
      onDidChange: (listener, thisArgs, disposables) => {
        const subscription = this.onDidChange.event(listener, thisArgs, disposables);
        caller.subscriptions.push(subscription);
        return subscription;
      },
    };
  }

  async activateByEvent(event: string, origin?: string): Promise<void> {
    const caller = origin ? this.extensions.get(origin) : undefined;
    const command = event.startsWith('onCommand:') ? event.slice('onCommand:'.length) : undefined;
    const extensions = [...this.extensions.values()];
    const targets = extensions.filter(extension =>
      !this.removing.has(extension) && !extension.description.disabled && extension.description.activationEvents.includes(event),
    );
    if (caller && command && targets.length === 0) {
      const registered = extensions.reverse().find(extension => !this.removing.has(extension) && extension.commands.has(command));
      if (registered) {
        targets.push(registered);
      }
    }
    await Promise.all(targets.map(extension => this.waitFor(caller, extension, false)));
  }

  private async waitFor(caller: Activation | undefined, target: Activation, dependency: boolean): Promise<void> {
    if (target.state === 'active') {
      return;
    }
    const wait = () => Promise.race([this.activate(target), target.aborted]);
    if (!caller) {
      await wait();
      return;
    }
    if (this.reaches(target, caller)) {
      if (dependency) {
        throw new Error(`Cyclic activation dependency on '${target.description.id}'.`);
      }
      return;
    }
    caller.waitingFor.set(target, (caller.waitingFor.get(target) ?? 0) + 1);
    try {
      await wait();
    } finally {
      const remaining = (caller.waitingFor.get(target) ?? 1) - 1;
      if (remaining) {
        caller.waitingFor.set(target, remaining);
      } else {
        caller.waitingFor.delete(target);
      }
    }
  }

  private reaches(start: Activation, target: Activation): boolean {
    const pending = [start];
    const visited = new Set<Activation>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next === target) {
        return true;
      }
      if (!visited.has(next)) {
        visited.add(next);
        for (const waiting of next.waitingFor.keys()) {
          pending.push(waiting);
        }
      }
    }
    return false;
  }

  private async activateDependencies(extension: Activation): Promise<void> {
    const dependencies = extension.description.manifest.extensionDependencies;
    if (dependencies === undefined) {
      return;
    }
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== 'string')) {
      throw new Error('Expected extensionDependencies to contain extension identifiers.');
    }
    for (const id of dependencies) {
      const target = [...this.extensions.values()].find(candidate =>
        !this.removing.has(candidate) && candidate.description.id.toLowerCase() === id.toLowerCase(),
      );
      if (!target) {
        throw new Error(`Missing extension dependency '${id}'.`);
      }
      await this.waitFor(extension, target, true);
      if (target.state !== 'active') {
        throw new Error(`Extension dependency '${id}' did not activate.`);
      }
      extension.abort.signal.throwIfAborted();
    }
  }

  private activate(extension: Activation): Promise<void> {
    return extension.operation ??= Promise.resolve().then(async () => {
      const { description, abort } = extension;
      if (abort.signal.aborted) {
        return;
      }
      extension.state = 'activating';
      void this.main.$setActivationStatus(description.key, { state: 'activating' }).catch(() => {});
      const slow = setTimeout(() => console.warn(`[${description.id}] Activation is still running after 10 seconds.`), 10_000);
      const cancelSlowWarning = () => clearTimeout(slow);
      abort.signal.addEventListener('abort', cancelSlowWarning, { once: true });
      try {
        if (description.disabled) {
          throw new Error('The requested VS Code API version is not available.');
        }
        await this.activateDependencies(extension);
        abort.signal.throwIfAborted();
        if (description.entry) {
          const access = this.catalog(extension);
          extensionActivation.set(description, access);
          const { api, context } = this.createApi(description, () => {
            if (!this.isLive(description.key)) {
              throw new Error(`Extension '${description.id}' is no longer active.`);
            }
            return true;
          }, extension.context);
          await access.prepare?.();
          abort.signal.throwIfAborted();
          extension.module = await this.load(description, api, abort.signal);
          abort.signal.throwIfAborted();
          extension.exports = await extension.module.activate?.(context);
          abort.signal.throwIfAborted();
          await this.flush(description.key);
          abort.signal.throwIfAborted();
        }
        extension.state = 'active';
        await this.main.$setActivationStatus(description.key, { state: 'active' });
      } catch (error) {
        if (abort.signal.aborted) {
          this.disposeSubscriptions(extension);
          return;
        }
        extension.state = 'failed';
        this.disposeSubscriptions(extension);
        this.release(description.key);
        const message = `Could not activate ${description.id} from ${description.entry}: ${error instanceof Error ? error.message : error}`;
        console.error(message);
        await this.main.$setActivationStatus(description.key, { state: 'failed', message }).catch(() => {});
      } finally {
        cancelSlowWarning();
        abort.signal.removeEventListener('abort', cancelSlowWarning);
      }
    });
  }

  private async deactivate(extension: Activation): Promise<void> {
    const { key, id } = extension.description;
    extension.abort.abort();
    if (extension.state === 'active' && extension.module?.deactivate) {
      extension.state = 'deactivating';
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          extension.module.deactivate(),
          new Promise<void>(resolve => {
            deadline = setTimeout(() => {
              console.warn(`[${id}] Deactivation timed out after 5 seconds.`);
              resolve();
            }, 5_000);
          }),
        ]);
      } catch (error) {
        console.error(`[${id}] Deactivation failed:`, error);
      } finally {
        clearTimeout(deadline);
      }
    }
    if (this.extensions.get(key) === extension) {
      this.finishRemoval(extension);
      await this.main.$setActivationStatus(key, { state: 'inactive' }).catch(() => {});
    }
  }

  private finishRemoval(extension: Activation): void {
    const { key } = extension.description;
    this.extensions.delete(key);
    this.removing.delete(extension);
    extension.state = 'inactive';
    extension.waitingFor.clear();
    this.disposeSubscriptions(extension);
    this.release(key);
  }

  private disposeSubscriptions(extension: Activation): void {
    try {
      dispose(extension.subscriptions.splice(0));
    } catch (error) {
      console.error(`[${extension.description.id}] Subscription disposal failed:`, error);
    }
  }

  dispose(): void {
    for (const extension of this.extensions.values()) {
      extension.abort.abort();
      if (extension.state === 'active') {
        try {
          void Promise.resolve(extension.module?.deactivate?.()).catch(() => {});
        } catch {
          // The host is closing and releases every extension below.
        }
      }
      this.finishRemoval(extension);
    }
    this.onDidChange.dispose();
  }
}
