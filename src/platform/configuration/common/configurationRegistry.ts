import { Emitter } from '../../../base/common/event.js';
import type { ConfigurationValue } from './configuration.js';

export interface IConfigurationPropertySchema {
  readonly type: 'boolean' | 'number' | 'integer' | 'string';
  readonly default: ConfigurationValue;
  readonly description: string;
  readonly enum?: readonly ConfigurationValue[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface IConfigurationNode {
  readonly id: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, IConfigurationPropertySchema>>;
}

export function validateConfigurationValue(schema: IConfigurationPropertySchema, value: unknown): value is ConfigurationValue {
  const type = schema.type === 'integer' ? 'number' : schema.type;
  if (typeof value !== type || (schema.enum && !schema.enum.includes(value as ConfigurationValue))) {
    return false;
  }
  return typeof value !== 'number' || (Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value))
    && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity));
}

export class ConfigurationRegistry {
  private readonly properties = new Map<string, IConfigurationPropertySchema>();
  private readonly changed = new Emitter<void>();
  readonly onDidUpdateConfiguration = this.changed.event;

  registerConfiguration(node: IConfigurationNode): void {
    const entries = Object.entries(node.properties);
    const keys = new Set(this.properties.keys());
    for (const [key, schema] of entries) {
      if (key.split('.').some(part => !part || part === '__proto__' || part === 'prototype' || part === 'constructor')
        || [...keys].some(candidate => candidate === key || candidate.startsWith(key + '.') || key.startsWith(candidate + '.'))
        || !validateConfigurationValue(schema, schema.default)) {
        throw new Error(`Invalid or conflicting configuration property '${key}' in '${node.id}'.`);
      }
      keys.add(key);
    }
    for (const [key, schema] of entries) {
      this.properties.set(key, schema);
    }
    if (entries.length) {
      this.changed.fire();
    }
  }

  getConfigurationProperties(): ReadonlyMap<string, IConfigurationPropertySchema> {
    return this.properties;
  }
}

export const configurationRegistry = new ConfigurationRegistry();
