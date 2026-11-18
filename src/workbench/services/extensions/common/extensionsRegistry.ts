import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../platform/extensions/common/extensions.js';

export class ExtensionMessageCollector {
  constructor(
    private readonly extensionId: string,
    private readonly report: (message: IExtensionMessage) => void,
  ) {}

  info(path: string, message: string): void { this.report({ extensionId: this.extensionId, severity: 'info', path, message }); }
  warn(path: string, message: string): void { this.report({ extensionId: this.extensionId, severity: 'warn', path, message }); }
  error(path: string, message: string, invalidResource?: boolean): void {
    this.report({ extensionId: this.extensionId, severity: 'error', path, message, invalidResource });
  }
}

export interface IExtensionPointUser<T> {
  readonly description: IExtensionDescription;
  readonly value: T;
  readonly collector: ExtensionMessageCollector;
  readonly resolveIcon?: (url: URL) => URL;
}

export class ExtensionPoint<T> {
  private handler?: (users: readonly IExtensionPointUser<T>[], registrations: DisposableStore) => void;

  setHandler(handler: NonNullable<ExtensionPoint<T>['handler']>): void {
    this.handler = handler;
  }

  acceptUsers(users: readonly IExtensionPointUser<T>[]): IDisposable {
    const registrations = new DisposableStore();
    try {
      this.handler?.(users, registrations);
      return registrations;
    } catch (error) {
      registrations.dispose();
      throw error;
    }
  }
}

export class ExtensionsRegistry {
  private readonly names = new Set<string>();

  registerExtensionPoint<T>(name: string): ExtensionPoint<T> {
    if (this.names.has(name)) {
      throw new Error(`Extension point '${name}' already exists.`);
    }
    this.names.add(name);
    return new ExtensionPoint<T>();
  }
}
