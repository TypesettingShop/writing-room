import { SyncDescriptor } from './descriptors.js';
import { getSingletonServiceDescriptors } from './extensions.js';
import { getServiceDependencies, IInstantiationService } from './instantiation.js';
import type { LeadingArguments, ServiceIdentifier, ServicesAccessor } from './instantiation.js';
import { ServiceCollection } from './serviceCollection.js';

export class InstantiationService implements IInstantiationService {
  declare readonly _serviceBrand: undefined;
  private readonly creating: ServiceIdentifier<unknown>[] = [];

  constructor(private readonly services = new ServiceCollection()) {
    for (const [id, descriptor] of getSingletonServiceDescriptors()) {
      if (!services.has(id)) {
        services.set(id, descriptor);
      }
    }
    services.set(IInstantiationService, this);
  }

  invokeFunction<Args extends unknown[], Result>(
    fn: (accessor: ServicesAccessor, ...args: Args) => Result,
    ...args: Args
  ): Result {
    let active = true;
    const accessor: ServicesAccessor = {
      get: id => {
        if (!active) {
          throw new Error('ServicesAccessor is valid only during invokeFunction.');
        }
        return this.getOrCreate(id);
      },
    };
    try {
      return fn(accessor, ...args);
    } finally {
      active = false;
    }
  }

  createInstance<Args extends unknown[], Result>(
    ctor: new (...args: Args) => Result,
    ...args: LeadingArguments<Args>
  ): Result;
  createInstance<T>(descriptor: SyncDescriptor<T>, ...args: unknown[]): T;
  createInstance<T>(target: (new (...args: any[]) => T) | SyncDescriptor<T>, ...args: unknown[]): T {
    return target instanceof SyncDescriptor
      ? this.construct(target.ctor, [...target.staticArguments, ...args])
      : this.construct(target, args);
  }

  private construct<T>(ctor: new (...args: any[]) => T, args: unknown[]): T {
    const dependencies = [...getServiceDependencies(ctor)].sort((a, b) => a.index - b.index);
    if (dependencies.length === 0) {
      return new ctor(...args);
    }

    const firstService = dependencies[0].index;
    if (args.length > firstService ||
        dependencies.some(({ index }, position) => index !== firstService + position)) {
      throw new Error(`${ctor.name} must take all static arguments before its injected services.`);
    }

    // Missing optional static arguments must retain their positions.
    const parameters = [...args];
    while (parameters.length < firstService) {
      parameters.push(undefined);
    }
    parameters.push(...dependencies.map(({ id }) => this.getOrCreate(id)));
    return new ctor(...parameters);
  }

  private getOrCreate<T>(id: ServiceIdentifier<T>): T {
    const value = this.services.get(id);
    if (value === undefined) {
      throw new Error(`Unknown service: ${id}`);
    }
    if (!(value instanceof SyncDescriptor)) {
      return value;
    }

    const cycleStart = this.creating.indexOf(id);
    if (cycleStart >= 0) {
      const cycle = [...this.creating.slice(cycleStart), id].join(' -> ');
      throw new Error(`Cyclic service dependency: ${cycle}`);
    }
    this.creating.push(id);
    try {
      const instance = this.construct(value.ctor, value.staticArguments.slice());
      this.services.set(id, instance);
      return instance;
    } finally {
      this.creating.pop();
    }
  }
}
