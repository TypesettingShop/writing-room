import { Emitter } from '../../../../base/common/event.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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

export interface ExtensionPointContext {
  readonly instantiation?: IInstantiationService;
  readonly isLightTheme?: boolean;
  readonly viewHandler: {
    acceptContainers(users: readonly IExtensionPointUser<Readonly<Record<string, unknown>>>[]): void;
    acceptViews(
      users: readonly IExtensionPointUser<Readonly<Record<string, unknown>>>[],
      addActivationEvent: (extension: string, event: string) => void,
    ): void;
  };
  addActivationEvent(extension: string, event: string): void;
  setCommandOwner(command: string, extension: string): void;
  getCommandOwner(command: string): string | undefined;
}

interface ExtensionPoint<T> {
  readonly name: string;
  readonly after?: readonly string[];
  validate(value: unknown): value is T;
  accept(users: readonly IExtensionPointUser<T>[], registrations: DisposableStore, context: ExtensionPointContext): void;
}

const registered = new Map<string, ExtensionPoint<unknown>>();
const changed = new Emitter<void>();

function orderedPoints(): ExtensionPoint<unknown>[] {
  const result: ExtensionPoint<unknown>[] = [];
  const visiting = new Set<string>();
  const seen = new Map<string, boolean>();
  function visit(name: string): boolean {
    const previous = seen.get(name);
    if (previous !== undefined) {
      return previous;
    }
    if (visiting.has(name)) {
      throw new Error(`Extension point dependency cycle at '${name}'.`);
    }
    const point = registered.get(name);
    if (!point) {
      return false;
    }
    visiting.add(name);
    const ready = (point.after ?? []).map(visit).every(Boolean);
    visiting.delete(name);
    seen.set(name, ready);
    if (ready) {
      result.push(point);
    }
    return ready;
  }
  for (const name of registered.keys()) {
    visit(name);
  }
  return result;
}

export const ExtensionsRegistry = {
  onDidChange: changed.event,

  registerExtensionPoint<T>(point: ExtensionPoint<T>): IDisposable {
    if (registered.has(point.name)) {
      throw new Error(`Extension point '${point.name}' already exists.`);
    }
    registered.set(point.name, point as ExtensionPoint<unknown>);
    try {
      orderedPoints();
    } catch (error) {
      registered.delete(point.name);
      throw error;
    }
    changed.fire();
    return { dispose: () => {
      if (registered.get(point.name) === point) {
        registered.delete(point.name);
        changed.fire();
      }
    } };
  },

  has(name: string): boolean {
    return registered.has(name);
  },

  getExtensionPoints(): readonly ExtensionPoint<unknown>[] {
    return orderedPoints();
  },
};
