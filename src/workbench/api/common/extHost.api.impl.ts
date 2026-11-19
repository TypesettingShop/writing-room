import type * as vscode from 'vscode';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { guardApiMethod } from './extHostApiRegistry.js';
import type { ExtHostApiContribution } from './extHostApiRegistry.js';

interface Property {
  readonly area: string;
  readonly value: unknown;
}

function add(properties: Map<string, Property>, name: string, area: string, value: unknown): void {
  const existing = properties.get(name);
  if (existing) {
    throw new Error(`Duplicate extension API property '${name}' from '${existing.area}' and '${area}'.`);
  }
  properties.set(name, { area, value });
}

function asObject(properties: ReadonlyMap<string, Property>): Record<string, unknown> {
  return Object.fromEntries([...properties].map(([name, { value }]) => [name, value]));
}

export function createExtensionApi(
  contributions: ReadonlyMap<string, ExtHostApiContribution>,
  extension: HostExtensionDescription,
  isLive: () => boolean,
  baseContext: vscode.ExtensionContext,
): { api: typeof vscode; context: vscode.ExtensionContext } {
  const top = new Map<string, Property>();
  const namespaces = new Map<string, Map<string, Property>>();
  const context = new Map<string, Property>();
  const checkLive = () => {
    if (!isLive()) {
      throw new Error(`Extension '${extension.key}' is no longer active.`);
    }
  };
  for (const [name, value] of Object.entries(baseContext)) {
    add(context, name, 'extension context', value);
  }
  for (const [area, contribution] of contributions) {
    const fragments = contribution.create?.(extension);
    for (const [name, type] of Object.entries(fragments?.types ?? {})) {
      add(top, name, area, type);
    }
    for (const [namespace, properties] of Object.entries(fragments?.namespaces ?? {})) {
      let values = namespaces.get(namespace);
      if (!values) {
        values = new Map();
        namespaces.set(namespace, values);
        add(top, namespace, area, values);
      }
      for (const [name, value] of Object.entries(properties)) {
        const existing = values.get(name);
        if (existing) {
          throw new Error(`Duplicate extension API property '${namespace}.${name}' from '${existing.area}' and '${area}'.`);
        }
        add(values, name, area, guardApiMethod(value, checkLive));
      }
    }
    for (const [name, value] of Object.entries(fragments?.context ?? {})) {
      add(context, name, area, guardApiMethod(value, checkLive));
    }
  }
  const api = asObject(top);
  for (const [name, values] of namespaces) {
    Object.defineProperty(api, name, { value: Object.freeze(asObject(values)), enumerable: true });
  }
  return { api: Object.freeze(api) as typeof vscode, context: asObject(context) as unknown as vscode.ExtensionContext };
}
