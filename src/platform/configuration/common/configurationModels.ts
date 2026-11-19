import { overrideIdentifiersFromKey, validateConfigurationValue } from './configurationRegistry.js';
import type { IConfigurationPropertySchema } from './configurationRegistry.js';
import { deepClone, equals, isPlainObject } from './configurationValues.js';

export interface IConfigurationOverrides {
  /** A language id: values set for `[<language>]` win over the others. */
  readonly overrideIdentifier?: string;
}

/** What each layer says about one registered key. Layers without a value leave their field out. */
export interface IConfigurationKeyData {
  readonly default: unknown;
  readonly user?: unknown;
  /** Language id and value, sorted by language id. */
  readonly defaultOverrides?: readonly (readonly [string, unknown])[];
  readonly userOverrides?: readonly (readonly [string, unknown])[];
}

/** Every registered key with its layers: what crosses to the extension host, whole or as changed keys. */
export type IConfigurationData = readonly (readonly [string, IConfigurationKeyData])[];

/** A key's value in each layer, as VS Code's `IConfigurationService.inspect` reports it. */
export interface IConfigurationValue<T> {
  readonly value?: T;
  /** The default, for the language when one was asked for and it has its own. */
  readonly defaultValue?: T;
  /** The user's value, for the language when one was asked for and it has its own. */
  readonly userValue?: T;
  readonly default?: { readonly value?: T; readonly override?: T };
  readonly user?: { readonly value?: T; readonly override?: T };
  /** The languages that have their own default or user value for the key. */
  readonly overrideIdentifiers?: readonly string[];
}

export interface IConfigurationChangeEvent {
  /** Every key whose value changed in any layer or language. */
  readonly affectedKeys: ReadonlySet<string>;
  /**
   * Whether `section` (a key, or a prefix of keys) changed. With a language, only when its value for that
   * language changed.
   */
  affectsConfiguration(section: string, overrides?: IConfigurationOverrides): boolean;
}

function find(entries: IConfigurationKeyData['userOverrides'], language: string): unknown {
  return entries?.find(([identifier]) => identifier === language)?.[1];
}

function resolve(data: IConfigurationKeyData, language: string | undefined): unknown {
  // A language's own value beats a value for every language; within each, the user's beats the default.
  if (language) {
    for (const value of [find(data.userOverrides, language), find(data.defaultOverrides, language)]) {
      if (value !== undefined) {
        return value;
      }
    }
  }
  return data.user !== undefined ? data.user : data.default;
}

function sortedEntries(values: ReadonlyMap<string, unknown> | undefined): (readonly [string, unknown])[] | undefined {
  return values?.size ? [...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : undefined;
}

function navigate(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/** An immutable snapshot of every registered setting: defaults, user values and their languages. */
export class Configuration {
  private readonly data: ReadonlyMap<string, IConfigurationKeyData>;

  constructor(data: IConfigurationData = []) {
    this.data = new Map(data);
  }

  /**
   * The values of `properties` from `user`, the parsed settings.json: a user value that does not match
   * its schema is left out, so the default shows through. Keys nobody registered stay out of the snapshot.
   */
  static build(
    properties: ReadonlyMap<string, IConfigurationPropertySchema>,
    languageDefaults: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
    user: Readonly<Record<string, unknown>>,
  ): Configuration {
    const userLanguages = new Map<string, Map<string, unknown>>();
    for (const [section, contents] of Object.entries(user)) {
      const identifiers = overrideIdentifiersFromKey(section);
      if (!identifiers.length || !isPlainObject(contents)) {
        continue;
      }
      for (const [key, value] of Object.entries(contents)) {
        const schema = properties.get(key);
        if (schema && validateConfigurationValue(schema, value)) {
          const languages = userLanguages.get(key) ?? new Map<string, unknown>();
          userLanguages.set(key, languages);
          for (const identifier of identifiers) {
            languages.set(identifier, value);
          }
        }
      }
    }
    const defaultLanguages = new Map<string, Map<string, unknown>>();
    for (const [language, values] of languageDefaults) {
      for (const [key, value] of values) {
        const languages = defaultLanguages.get(key) ?? new Map<string, unknown>();
        defaultLanguages.set(key, languages);
        languages.set(language, value);
      }
    }
    const data: [string, IConfigurationKeyData][] = [];
    for (const [key, schema] of properties) {
      const value = Object.hasOwn(user, key) ? user[key] : undefined;
      const entry: { -readonly [K in keyof IConfigurationKeyData]: IConfigurationKeyData[K] } = { default: schema.default };
      if (validateConfigurationValue(schema, value)) {
        entry.user = value;
      }
      const defaults = sortedEntries(defaultLanguages.get(key));
      if (defaults) {
        entry.defaultOverrides = defaults;
      }
      const users = sortedEntries(userLanguages.get(key));
      if (users) {
        entry.userOverrides = users;
      }
      data.push([key, entry]);
    }
    return new Configuration(data);
  }

  /** The snapshot's data, or only `keys` of it with `null` for a key that is no longer registered. */
  toData(): IConfigurationData;
  toData(keys: Iterable<string>): readonly (readonly [string, IConfigurationKeyData | null])[];
  toData(keys?: Iterable<string>): readonly (readonly [string, IConfigurationKeyData | null])[] {
    return keys ? [...keys].map(key => [key, this.data.get(key) ?? null] as const) : [...this.data];
  }

  /** This snapshot with `changes` applied: `null` removes a key. */
  with(changes: readonly (readonly [string, IConfigurationKeyData | null])[]): Configuration {
    const data = new Map(this.data);
    for (const [key, value] of changes) {
      if (value) {
        data.set(key, value);
      } else {
        data.delete(key);
      }
    }
    return new Configuration([...data]);
  }

  keys(): string[] {
    return [...this.data.keys()];
  }

  /** The keys whose data differs between this snapshot and `other`. */
  compare(other: Configuration): string[] {
    const keys = new Set([...this.data.keys(), ...other.data.keys()]);
    return [...keys].filter(key => !equals(this.data.get(key), other.data.get(key)));
  }

  /**
   * The value of a key, of a section as an object of its keys, or of a path inside an object value.
   * The caller gets its own copy.
   */
  getValue<T = unknown>(section?: string, overrides?: IConfigurationOverrides): T | undefined {
    const language = overrides?.overrideIdentifier;
    return deepClone(this.read(section, data => resolve(data, language))) as T | undefined;
  }

  inspect<T = unknown>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> {
    const language = overrides?.overrideIdentifier;
    const read = (pick: (data: IConfigurationKeyData) => unknown) => deepClone(this.read(key, pick)) as T | undefined;
    const defaultValue = read(data => data.default);
    const defaultOverride = language ? read(data => find(data.defaultOverrides, language)) : undefined;
    const userValue = read(data => data.user);
    const userOverride = language ? read(data => find(data.userOverrides, language)) : undefined;
    const identifiers = new Set<string>();
    const entry = this.entryFor(key);
    for (const [identifier] of [...entry?.defaultOverrides ?? [], ...entry?.userOverrides ?? []]) {
      identifiers.add(identifier);
    }
    return {
      value: this.getValue<T>(key, overrides),
      defaultValue: defaultOverride !== undefined ? defaultOverride : defaultValue,
      userValue: userOverride !== undefined ? userOverride : userValue,
      default: defaultValue !== undefined || defaultOverride !== undefined ? { value: defaultValue, override: defaultOverride } : undefined,
      user: userValue !== undefined || userOverride !== undefined ? { value: userValue, override: userOverride } : undefined,
      overrideIdentifiers: identifiers.size ? [...identifiers].sort() : undefined,
    };
  }

  /** The data of the registered key that `key` is, or lies inside. */
  private entryFor(key: string): IConfigurationKeyData | undefined {
    const parts = key.split('.');
    for (let length = parts.length; length > 0; length--) {
      const entry = this.data.get(parts.slice(0, length).join('.'));
      if (entry) {
        return entry;
      }
    }
    return undefined;
  }

  private read(section: string | undefined, pick: (data: IConfigurationKeyData) => unknown): unknown {
    if (section) {
      const parts = section.split('.');
      for (let length = parts.length; length > 0; length--) {
        const entry = this.data.get(parts.slice(0, length).join('.'));
        if (entry) {
          return navigate(pick(entry), parts.slice(length));
        }
      }
    }
    // A section: the keys under it, nested by their dots.
    const result: Record<string, unknown> = {};
    const prefix = section ? section + '.' : '';
    let found = false;
    for (const [key, entry] of this.data) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const value = pick(entry);
      if (value === undefined) {
        continue;
      }
      const parts = key.slice(prefix.length).split('.');
      let target = result;
      for (const part of parts.slice(0, -1)) {
        if (!isPlainObject(target[part])) {
          target[part] = {};
        }
        target = target[part] as Record<string, unknown>;
      }
      target[parts[parts.length - 1]] = value;
      found = true;
    }
    return found || !section ? result : undefined;
  }
}

export class ConfigurationChangeEvent implements IConfigurationChangeEvent {
  readonly affectedKeys: ReadonlySet<string>;

  constructor(keys: Iterable<string>, private readonly previous: Configuration, private readonly current: Configuration) {
    this.affectedKeys = new Set(keys);
  }

  affectsConfiguration(section: string, overrides?: IConfigurationOverrides): boolean {
    if (!section) {
      return this.affectedKeys.size > 0;
    }
    if (![...this.affectedKeys].some(key => key === section || key.startsWith(section + '.'))) {
      return false;
    }
    return !overrides?.overrideIdentifier
      || !equals(this.previous.getValue(section, overrides), this.current.getValue(section, overrides));
  }
}

/** The change from `previous` to `next`, or nothing when no key changed. */
export function configurationChange(previous: Configuration, next: Configuration): ConfigurationChangeEvent | undefined {
  const keys = previous.compare(next);
  return keys.length ? new ConfigurationChangeEvent(keys, previous, next) : undefined;
}
