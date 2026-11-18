import type * as vscode from 'vscode';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { URI } from '../../../base/common/uri.js';
import { dispose } from '../../../base/common/lifecycle.js';
import type { MainThreadExtensionServiceShape } from './extHost.protocol.js';

export interface IExtensionModule {
  activate?(context: vscode.ExtensionContext): unknown;
  deactivate?(): unknown;
}

export type ExtensionLoader = (
  extension: HostExtensionDescription, api: typeof vscode, signal: AbortSignal,
) => Promise<IExtensionModule>;

class Activation {
  readonly abort = new AbortController();
  readonly subscriptions: vscode.ExtensionContext['subscriptions'] = [];
  readonly context: vscode.ExtensionContext;
  module?: IExtensionModule;
  operation?: Promise<void>;
  state: 'inactive' | 'activating' | 'active' | 'failed' = 'inactive';

  constructor(public description: HostExtensionDescription) {
    this.context = {
      subscriptions: this.subscriptions,
      extensionUri: URI.parse(description.location),
      extension: { id: description.id, packageJSON: structuredClone(description.manifest) },
    };
  }
}

export class ExtensionsActivator {
  private readonly extensions = new Map<string, Activation>();

  constructor(
    private readonly main: MainThreadExtensionServiceShape,
    private readonly load: ExtensionLoader,
    private readonly createApi: (id: string, isLive: () => boolean) => typeof vscode,
    private readonly flush: (key: string) => Promise<void>,
    private readonly release: (key: string) => void,
  ) {}

  isLive(key: string): boolean {
    const extension = this.extensions.get(key);
    return extension?.state === 'activating' || extension?.state === 'active';
  }

  getViews(key: string): readonly string[] {
    return this.extensions.get(key)?.description.views ?? [];
  }

  deltaExtensions(added: readonly HostExtensionDescription[], removed: readonly string[]): void {
    for (const key of removed) {
      const extension = this.extensions.get(key);
      if (extension) {
        this.extensions.delete(key);
        this.deactivate(extension);
      }
    }
    for (const description of added) {
      const existing = this.extensions.get(description.key);
      if (existing) {
        existing.description = description;
      } else {
        this.extensions.set(description.key, new Activation(description));
      }
    }
  }

  async activateByEvent(event: string, origin?: string): Promise<void> {
    await Promise.all([...this.extensions.values()].filter(extension =>
      extension.description.key !== origin
      && !(origin && extension.state === 'activating')
      && extension.description.activationEvents.includes(event),
    ).map(extension => this.activate(extension)));
  }

  private activate(extension: Activation): Promise<void> {
    return extension.operation ??= Promise.resolve().then(async () => {
      const { description, abort } = extension;
      if (abort.signal.aborted) {
        return;
      }
      extension.state = 'activating';
      void this.main.$setActivationStatus(description.key, { state: 'activating' }).catch(() => {});
      try {
        const api = this.createApi(description.key, () => this.isLive(description.key));
        extension.module = await this.load(description, api, abort.signal);
        abort.signal.throwIfAborted();
        await extension.module.activate?.(extension.context);
        abort.signal.throwIfAborted();
        await this.flush(description.key);
        abort.signal.throwIfAborted();
        extension.state = 'active';
        await this.main.$setActivationStatus(description.key, { state: 'active' });
      } catch (error) {
        if (abort.signal.aborted) {
          this.disposeSubscriptions(extension);
          return;
        }
        extension.state = 'failed';
        this.release(description.key);
        this.disposeSubscriptions(extension);
        const message = `Could not activate ${description.id} from ${description.entry}: ${error instanceof Error ? error.message : error}`;
        console.error(message);
        await this.main.$setActivationStatus(description.key, { state: 'failed', message }).catch(() => {});
      }
    });
  }

  private deactivate(extension: Activation): void {
    extension.abort.abort();
    this.release(extension.description.key);
    if (extension.state === 'active') {
      try {
        void Promise.resolve(extension.module?.deactivate?.()).catch(error => {
          console.error(`[${extension.description.id}] Deactivation failed:`, error);
        });
      } catch (error) {
        console.error(`[${extension.description.id}] Deactivation failed:`, error);
      }
    }
    this.disposeSubscriptions(extension);
  }

  private disposeSubscriptions(extension: Activation): void {
    try {
      dispose(extension.subscriptions.splice(0));
    } catch (error) {
      console.error(`[${extension.description.id}] Subscription disposal failed:`, error);
    }
  }

  dispose(): void {
    this.deltaExtensions([], [...this.extensions.keys()]);
  }
}
