import type { ConfigurationValue, IConfigurationChangeEvent } from './configuration.js';
import { validateConfigurationValue } from './configurationRegistry.js';
import type { IConfigurationPropertySchema } from './configurationRegistry.js';

type Section = { [part: string]: ConfigurationValue | Section };

export function buildConfiguration(
  properties: ReadonlyMap<string, IConfigurationPropertySchema>,
  user: Readonly<Record<string, unknown>>,
): Map<string, ConfigurationValue> {
  const values = new Map<string, ConfigurationValue>();
  for (const [key, schema] of properties) {
    const value = Object.hasOwn(user, key) ? user[key] : undefined;
    values.set(key, validateConfigurationValue(schema, value) ? value : schema.default);
  }
  return values;
}

export function readConfiguration(values: ReadonlyMap<string, ConfigurationValue>, key?: string): ConfigurationValue | Section | undefined {
  if (key !== undefined && values.has(key)) {
    return values.get(key);
  }
  const result: Section = {};
  const prefix = key ? key + '.' : '';
  for (const [name, value] of values) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const parts = name.slice(prefix.length).split('.');
    let section = result;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(section, part)) {
        section[part] = {};
      }
      section = section[part] as Section;
    }
    section[parts[parts.length - 1]] = value;
  }
  return prefix && !Object.keys(result).length ? undefined : result;
}

export function configurationChange(
  previous: ReadonlyMap<string, ConfigurationValue>, next: ReadonlyMap<string, ConfigurationValue>,
): IConfigurationChangeEvent | undefined {
  const changed = [...new Set([...previous.keys(), ...next.keys()])].filter(key => !Object.is(previous.get(key), next.get(key)));
  return changed.length ? {
    affectsConfiguration: key => !key || changed.some(name => name === key || name.startsWith(key + '.')),
  } : undefined;
}
