import { SyncDescriptor } from './descriptors.js';
import type { ServiceIdentifier } from './instantiation.js';

const descriptors = new Map<ServiceIdentifier<unknown>, SyncDescriptor<unknown>>();

export function registerSingleton<T>(
  id: ServiceIdentifier<T>,
  implementation: (new (...args: any[]) => T) | SyncDescriptor<T>,
): void {
  const descriptor = implementation instanceof SyncDescriptor
    ? implementation
    : new SyncDescriptor(implementation);
  descriptors.set(id, descriptor);
}

export function getSingletonServiceDescriptors():
  [ServiceIdentifier<unknown>, SyncDescriptor<unknown>][] {
  return [...descriptors];
}
