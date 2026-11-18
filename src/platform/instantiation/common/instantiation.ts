import type { SyncDescriptor } from './descriptors.js';

export interface ServiceIdentifier<T> {
  readonly type: T;
  (target: object, propertyKey: string | symbol | undefined, parameterIndex: number): void;
  toString(): string;
}

interface ServiceDependency {
  readonly id: ServiceIdentifier<unknown>;
  readonly index: number;
}

const ids = new Map<string, ServiceIdentifier<unknown>>();
const dependencies = new WeakMap<object, ServiceDependency[]>();

export function createDecorator<T>(name: string): ServiceIdentifier<T> {
  const cached = ids.get(name);
  if (cached) {
    return cached as ServiceIdentifier<T>;
  }

  const id = Object.assign(
    (target: object, propertyKey: string | symbol | undefined, index: number) => {
      if (propertyKey !== undefined || typeof target !== 'function' || !Number.isInteger(index)) {
        throw new Error(`Service identifier ${name} can only decorate a constructor parameter.`);
      }

      let parameters = dependencies.get(target);
      if (!parameters) {
        parameters = [];
        dependencies.set(target, parameters);
      }
      parameters.push({ id, index });
      // Decorators run last parameter first; keep the list in parameter order for construction.
      parameters.sort((a, b) => a.index - b.index);
    },
    { toString: () => name },
  ) as ServiceIdentifier<T>;

  ids.set(name, id);
  return id;
}

export function getServiceDependencies(ctor: object): readonly ServiceDependency[] {
  for (let target: object | null = ctor; target; target = Object.getPrototypeOf(target)) {
    const parameters = dependencies.get(target);
    if (parameters) {
      return parameters;
    }
  }
  return [];
}

export interface ServicesAccessor {
  get<T>(id: ServiceIdentifier<T>): T;
}

export interface BrandedService {
  readonly _serviceBrand: undefined;
}

export type LeadingArguments<Args extends unknown[]> =
  Args extends [...infer Head, BrandedService] ? LeadingArguments<Head> : Args;

export const IInstantiationService = createDecorator<IInstantiationService>('instantiationService');

export interface IInstantiationService extends BrandedService {
  invokeFunction<Args extends unknown[], Result>(
    fn: (accessor: ServicesAccessor, ...args: Args) => Result,
    ...args: Args
  ): Result;

  createInstance<Args extends unknown[], Result>(
    ctor: new (...args: Args) => Result,
    ...args: LeadingArguments<Args>
  ): Result;

  createInstance<T>(descriptor: SyncDescriptor<T>, ...args: unknown[]): T;
}
