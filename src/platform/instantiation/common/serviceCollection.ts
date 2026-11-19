import type { SyncDescriptor } from './descriptors.js';
import type { ServiceIdentifier } from './instantiation.js';

export class ServiceCollection {
  private readonly services: Map<ServiceIdentifier<unknown>, unknown>;

  constructor(...entries: [ServiceIdentifier<unknown>, unknown][]) {
    this.services = new Map(entries);
  }

  set<T>(id: ServiceIdentifier<T>, value: T | SyncDescriptor<T>): T | SyncDescriptor<T> | undefined {
    const previous = this.get(id);
    this.services.set(id, value);
    return previous;
  }

  has(id: ServiceIdentifier<unknown>): boolean {
    return this.services.has(id);
  }

  get<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> | undefined {
    return this.services.get(id) as T | SyncDescriptor<T> | undefined;
  }
}
