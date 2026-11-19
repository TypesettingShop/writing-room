import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';

export interface ExtHostApiServices {
  readonly rpc: RPCProtocol;
  isLive(key: string): boolean;
  getViews(key: string): readonly string[];
  resolveCommandArgument(key: string, value: unknown): unknown;
}

export interface ExtensionApiFragments {
  readonly namespaces?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly types?: Readonly<Record<string, unknown>>;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface ExtHostApiContribution extends Partial<IDisposable> {
  create?(extension: HostExtensionDescription): ExtensionApiFragments;
  convertCommandArgument?(key: string, value: unknown): unknown;
  flush?(key: string): Promise<void>;
  release?(key: string): void;
}

export type ExtHostApiContributionFactory = (services: ExtHostApiServices) => ExtHostApiContribution;

export class ExtHostApiRegistry {
  private readonly factories = new Map<string, ExtHostApiContributionFactory>();

  register(area: string, factory: ExtHostApiContributionFactory): IDisposable {
    if (this.factories.has(area)) {
      throw new Error(`API area '${area}' already exists.`);
    }
    this.factories.set(area, factory);
    return { dispose: () => {
      if (this.factories.get(area) === factory) {
        this.factories.delete(area);
      }
    } };
  }

  create(services: ExtHostApiServices): ReadonlyMap<string, ExtHostApiContribution> {
    const contributions = new Map<string, ExtHostApiContribution>();
    try {
      for (const [area, factory] of this.factories) {
        contributions.set(area, factory(services));
      }
      return contributions;
    } catch (error) {
      for (const contribution of contributions.values()) {
        try {
          contribution.dispose?.();
        } catch (disposeError) {
          console.error(disposeError);
        }
      }
      throw error;
    }
  }
}

export const extHostApiRegistry = new ExtHostApiRegistry();

const promiseMethods = new WeakSet<Function>();

/** Promise methods reject when their extension is inactive. Other methods throw. */
export function promiseApiMethod<T extends (...args: any[]) => PromiseLike<unknown>>(method: T): T {
  promiseMethods.add(method);
  return method;
}

export function guardApiMethod(value: unknown, checkLive: () => void): unknown {
  if (typeof value !== 'function') {
    return value;
  }
  return function (this: unknown, ...args: unknown[]): unknown {
    try {
      checkLive();
    } catch (error) {
      if (promiseMethods.has(value)) {
        return Promise.reject(error);
      }
      throw error;
    }
    return Reflect.apply(value, this, args);
  };
}
