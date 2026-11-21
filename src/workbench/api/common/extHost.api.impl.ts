import type * as vscode from 'vscode';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { guardApiMethod } from './extHostApiRegistry.js';
import type { ExtHostApiContribution } from './extHostApiRegistry.js';

interface Property {
  readonly area: string;
  readonly descriptor: PropertyDescriptor;
}

function add(
  properties: Map<string, Property>, name: string, area: string, descriptor: PropertyDescriptor, path = name,
): void {
  const existing = properties.get(name);
  if (existing) {
    throw new Error("Duplicate extension API property '" + path + "' from '" + existing.area + "' and '" + area + "'.");
  }
  properties.set(name, { area, descriptor });
}

function asObject(properties: ReadonlyMap<string, Property>): Record<string, unknown> {
  const descriptors = Object.fromEntries([...properties].map(([name, { descriptor }]) => [name, descriptor]));
  return Object.defineProperties({}, descriptors);
}

function guardProperty(property: PropertyDescriptor, checkLive: () => void): PropertyDescriptor {
  return 'value' in property
    ? { ...property, value: guardApiMethod(property.value, checkLive) }
    : { ...property, get: guardApiMethod(property.get, checkLive), set: guardApiMethod(property.set, checkLive) };
}

export function createExtensionApi(
  contributions: ReadonlyMap<string, ExtHostApiContribution>,
  extension: HostExtensionDescription,
  isLive: () => boolean,
  baseContext: object,
): { api: typeof vscode; context: vscode.ExtensionContext } {
  const top = new Map<string, Property>();
  const namespaces = new Map<string, Map<string, Property>>();
  const context = new Map<string, Property>();
  const checkLive = () => {
    if (!isLive()) {
      throw new Error("Extension '" + extension.id + "' is no longer active.");
    }
  };
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(baseContext))) {
    add(context, name, 'extension context', descriptor);
  }
  for (const [area, contribution] of contributions) {
    const fragments = contribution.create?.(extension);
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(fragments?.types ?? {}))) {
      add(top, name, area, descriptor);
    }
    for (const [namespace, properties] of Object.entries(fragments?.namespaces ?? {})) {
      let values = namespaces.get(namespace);
      if (!values) {
        values = new Map();
        namespaces.set(namespace, values);
        add(top, namespace, area, { enumerable: true });
      }
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(properties))) {
        add(values, name, area, guardProperty(descriptor, checkLive), namespace + '.' + name);
      }
    }
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(fragments?.context ?? {}))) {
      add(context, name, area, guardProperty(descriptor, checkLive));
    }
  }
  for (const [name, values] of namespaces) {
    top.get(name)!.descriptor.value = Object.freeze(asObject(values));
  }
  return {
    api: Object.freeze(asObject(top)) as typeof vscode,
    context: asObject(context) as unknown as vscode.ExtensionContext,
  };
}
