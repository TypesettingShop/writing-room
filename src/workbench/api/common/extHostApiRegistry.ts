import { toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';

export interface ExtHostApiServices {
  readonly rpc: RPCProtocol;
  /** Obtains another area's service from the current host. */
  getService<T>(area: string): T;
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
  readonly service?: object;
  /** Initialization required before an extension can call this area's synchronous API. */
  readonly ready?: Promise<void>;
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
    return toDisposable(() => {
      if (this.factories.get(area) === factory) {
        this.factories.delete(area);
      }
    });
  }

  create(services: Omit<ExtHostApiServices, 'getService'>): ReadonlyMap<string, ExtHostApiContribution> {
    const factories = new Map(this.factories);
    const contributions = new Map<string, ExtHostApiContribution>();
    const constructing = new Set<string>();
    const areaServices: ExtHostApiServices = {
      ...services,
      getService<T>(area: string): T {
        const contribution = resolve(area);
        if (!contribution.service) {
          throw new Error("API area '" + area + "' does not expose a host service.");
        }
        return contribution.service as T;
      },
    };
    function resolve(area: string): ExtHostApiContribution {
      const existing = contributions.get(area);
      if (existing) {
        return existing;
      }
      const factory = factories.get(area);
      if (!factory) {
        throw new Error("Unknown API area '" + area + "'.");
      }
      if (constructing.has(area)) {
        throw new Error('Cyclic extension host service dependency: ' + [...constructing, area].join(' -> '));
      }
      constructing.add(area);
      try {
        const contribution = factory(areaServices);
        contributions.set(area, contribution);
        return contribution;
      } finally {
        constructing.delete(area);
      }
    }

    try {
      // Dependencies may initialize first. API assembly and release use registration order.
      return new Map([...factories.keys()].map(area => [area, resolve(area)]));
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

export function guardApiMethod<T>(value: T, checkLive: () => void): T {
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
  } as T;
}
