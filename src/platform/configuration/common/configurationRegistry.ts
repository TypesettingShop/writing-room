import { Emitter } from '../../../base/common/event.js';
import { equals, isPlainObject } from './configurationValues.js';

export type ConfigurationPropertyType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
export type ConfigurationScopeName =
  | 'application' | 'machine' | 'window' | 'resource' | 'language-overridable' | 'machine-overridable';

/** One setting as a manifest or the workbench declares it: a JSON schema with a few configuration fields. */
export interface IConfigurationPropertySchema {
  readonly type?: ConfigurationPropertyType | readonly ConfigurationPropertyType[];
  readonly default?: unknown;
  readonly description?: string;
  readonly markdownDescription?: string;
  readonly enum?: readonly unknown[];
  readonly enumDescriptions?: readonly string[];
  readonly markdownEnumDescriptions?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly patternErrorMessage?: string;
  readonly items?: unknown;
  readonly properties?: unknown;
  readonly additionalProperties?: unknown;
  readonly scope?: ConfigurationScopeName;
  readonly deprecationMessage?: string;
  readonly markdownDeprecationMessage?: string;
  readonly order?: number;
}

export interface IConfigurationNode {
  readonly id: string;
  readonly title?: string;
  readonly order?: number;
  /** The extension that contributed the node; messages about it name the extension instead of the id. */
  readonly extensionId?: string;
  readonly properties: Readonly<Record<string, IConfigurationPropertySchema>>;
}

/** Default values that replace registered ones: a key, or a language section such as `[markdown]`. */
export interface IConfigurationDefaults {
  readonly overrides: Readonly<Record<string, unknown>>;
  /** The extension that contributed the defaults. */
  readonly source?: string;
}

/** A property or default the registry refused; the rest of its node or defaults were applied. */
export interface IConfigurationProblem {
  readonly source: string;
  readonly key: string;
  readonly message: string;
}

export interface IConfigurationRegistryUpdate {
  readonly add?: readonly IConfigurationNode[];
  readonly remove?: readonly IConfigurationNode[];
  readonly addDefaults?: readonly IConfigurationDefaults[];
  readonly removeDefaults?: readonly IConfigurationDefaults[];
}

const OVERRIDE_IDENTIFIER_PATTERN = /\[([^\]]+)\]/g;
export const OVERRIDE_PROPERTY_REGEX = /^(\[[^\]]+\])+$/;
const forbiddenParts = new Set(['__proto__', 'prototype', 'constructor']);
const knownTypes: readonly unknown[] = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];

/** The language ids of a section key such as `[markdown][plaintext]`, or none for an ordinary key. */
export function overrideIdentifiersFromKey(key: string): string[] {
  if (!OVERRIDE_PROPERTY_REGEX.test(key)) {
    return [];
  }
  const identifiers = [...key.matchAll(OVERRIDE_IDENTIFIER_PATTERN)].map(match => match[1].trim()).filter(Boolean);
  return [...new Set(identifiers)];
}

export function keyFromOverrideIdentifiers(identifiers: readonly string[]): string {
  return identifiers.map(identifier => '[' + identifier + ']').join('');
}

function types(schema: IConfigurationPropertySchema): readonly ConfigurationPropertyType[] | undefined {
  return schema.type === undefined ? undefined : typeof schema.type === 'string' ? [schema.type] : schema.type;
}

/** The value a property without a `default` has, as in VS Code: from its first type. */
export function getDefaultValue(type: IConfigurationPropertySchema['type']): unknown {
  switch (typeof type === 'string' ? type : type?.[0]) {
    case 'boolean': return false;
    case 'integer':
    case 'number': return 0;
    case 'string': return '';
    case 'array': return [];
    case 'object': return {};
    default: return null;
  }
}

function matchesType(type: ConfigurationPropertyType, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    case 'null': return value === null;
    default: return false;
  }
}

/**
 * A shallow check: the type, the enum and the numeric range. Whatever the schema says about items,
 * properties or patterns is left to the diagnostics of the settings.json editor.
 */
export function validateConfigurationValue(schema: IConfigurationPropertySchema, value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  const allowed = types(schema);
  if (allowed && !allowed.some(type => matchesType(type, value))) {
    return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => equals(candidate, value))) {
    return false;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  }
  return true;
}

interface IRegisteredProperty {
  readonly schema: IConfigurationPropertySchema;
  readonly node: IConfigurationNode;
}

function nodeSource(node: IConfigurationNode): string {
  return node.extensionId ?? node.id;
}

/**
 * The settings the workbench and extensions declare, and the defaults extensions put over them.
 * Every update fires `onDidUpdateConfiguration` once; readers recompute their values from it.
 */
export class ConfigurationRegistry {
  private readonly properties = new Map<string, IRegisteredProperty>();
  private readonly defaults: IConfigurationDefaults[] = [];
  private effective = new Map<string, IConfigurationPropertySchema>();
  private languageDefaults = new Map<string, ReadonlyMap<string, unknown>>();
  private readonly changed = new Emitter<void>();
  readonly onDidUpdateConfiguration = this.changed.event;

  /** Registers every property of `node`, or throws without registering any when one is refused. */
  registerConfiguration(node: IConfigurationNode): void {
    this.updateConfigurations({ add: [node] });
  }

  /** Registers the valid properties of `nodes`; `report` hears about each refused one. */
  registerConfigurations(nodes: readonly IConfigurationNode[], report?: (problem: IConfigurationProblem) => void): void {
    this.updateConfigurations({ add: nodes }, report);
  }

  deregisterConfigurations(nodes: readonly IConfigurationNode[]): void {
    this.updateConfigurations({ remove: nodes });
  }

  registerDefaultConfigurations(defaults: readonly IConfigurationDefaults[], report?: (problem: IConfigurationProblem) => void): void {
    this.updateConfigurations({ addDefaults: defaults }, report);
  }

  deregisterDefaultConfigurations(defaults: readonly IConfigurationDefaults[]): void {
    this.updateConfigurations({ removeDefaults: defaults });
  }

  /**
   * Removes, then adds, in one step that readers see as one change. Without `report` a refused property
   * throws before anything changes; with it, the property is left out and the rest goes ahead.
   */
  updateConfigurations(update: IConfigurationRegistryUpdate, report?: (problem: IConfigurationProblem) => void): void {
    const removedNodes = new Set(update.remove ?? []);
    const properties = new Map([...this.properties].filter(([, { node }]) => !removedNodes.has(node)));
    // Every proper prefix of a registered key ("a" and "a.b" for "a.b.c"), to the first property under it.
    const prefixes = new Map<string, IRegisteredProperty>();
    const addPrefixes = (key: string, property: IRegisteredProperty) => {
      for (let end = key.indexOf('.'); end >= 0; end = key.indexOf('.', end + 1)) {
        const prefix = key.slice(0, end);
        if (!prefixes.has(prefix)) {
          prefixes.set(prefix, property);
        }
      }
    };
    for (const [key, property] of properties) {
      addPrefixes(key, property);
    }
    const problems: IConfigurationProblem[] = [];
    for (const node of update.add ?? []) {
      for (const [key, schema] of Object.entries(node.properties ?? {})) {
        const message = this.checkProperty(properties, prefixes, key, schema);
        if (message) {
          problems.push({ source: nodeSource(node), key, message });
        } else {
          const property = { schema, node };
          properties.set(key, property);
          addPrefixes(key, property);
        }
      }
    }
    if (problems.length && !report) {
      const [{ key, source, message }] = problems;
      throw new Error(`Invalid or conflicting configuration property '${key}' in '${source}': ${message}`);
    }
    const removedDefaults = new Set(update.removeDefaults ?? []);
    const defaults = [...this.defaults.filter(entry => !removedDefaults.has(entry)), ...update.addDefaults ?? []];

    this.properties.clear();
    for (const [key, property] of properties) {
      this.properties.set(key, property);
    }
    this.defaults.splice(0, this.defaults.length, ...defaults);
    problems.push(...this.computeDefaults(new Set(update.addDefaults ?? [])));
    for (const problem of problems) {
      report?.(problem);
    }
    if (removedNodes.size || update.add?.length || removedDefaults.size || update.addDefaults?.length) {
      this.changed.fire();
    }
  }

  /** Every registered property, its `default` being the effective one after default overrides. */
  getConfigurationProperties(): ReadonlyMap<string, IConfigurationPropertySchema> {
    return this.effective;
  }

  /** Who registered `key`: the extension, or the id of the workbench's node. */
  getPropertySource(key: string): string | undefined {
    const property = this.properties.get(key);
    return property && nodeSource(property.node);
  }

  /** Language id to the defaults extensions set for it, each valid for its registered property. */
  getLanguageDefaults(): ReadonlyMap<string, ReadonlyMap<string, unknown>> {
    return this.languageDefaults;
  }

  private checkProperty(
    properties: ReadonlyMap<string, IRegisteredProperty>, prefixes: ReadonlyMap<string, IRegisteredProperty>,
    key: string, schema: IConfigurationPropertySchema,
  ): string | undefined {
    if (!isPlainObject(schema)) {
      return 'Expected a property schema object.';
    }
    if (!key.trim() || OVERRIDE_PROPERTY_REGEX.test(key) || key.split('.').some(part => !part || forbiddenParts.has(part))) {
      return 'The property name is not a valid setting key.';
    }
    const type: unknown = schema.type;
    if (type !== undefined && !(typeof type === 'string' ? knownTypes.includes(type)
      : Array.isArray(type) && type.length > 0 && type.every(entry => knownTypes.includes(entry)))) {
      return 'The property type is not one of ' + knownTypes.join(', ') + '.';
    }
    // The key itself, a key under it, or a key it lies under.
    let existing = properties.get(key) ?? prefixes.get(key);
    for (let end = key.indexOf('.'); !existing && end >= 0; end = key.indexOf('.', end + 1)) {
      existing = properties.get(key.slice(0, end));
    }
    if (existing) {
      return `Cannot register '${key}'. This property is already registered by '${nodeSource(existing.node)}'.`;
    }
    // As in VS Code, the declared default is not checked against the schema: `type: "string", default: null` stands.
    return undefined;
  }

  private computeDefaults(added: ReadonlySet<IConfigurationDefaults>): IConfigurationProblem[] {
    const problems: IConfigurationProblem[] = [];
    const base = new Map<string, unknown>();
    // As in VS Code, a section naming one language beats a section naming several (`[markdown][plaintext]`).
    const shared = new Map<string, Map<string, unknown>>();
    const own = new Map<string, Map<string, unknown>>();
    for (const entry of this.defaults) {
      const source = entry.source ?? 'defaults';
      const refuse = (key: string, message: string) => {
        if (added.has(entry)) {
          problems.push({ source, key, message });
        }
      };
      for (const [key, value] of Object.entries(entry.overrides ?? {})) {
        const identifiers = overrideIdentifiersFromKey(key);
        if (!identifiers.length) {
          const property = this.properties.get(key);
          if (property && !validateConfigurationValue(property.schema, value)) {
            refuse(key, `The default value of '${key}' does not match its schema.`);
          } else {
            base.set(key, value);
          }
          continue;
        }
        if (!isPlainObject(value)) {
          refuse(key, `Expected an object of settings for '${key}'.`);
          continue;
        }
        for (const [name, overridden] of Object.entries(value)) {
          const property = this.properties.get(name);
          if (property && !validateConfigurationValue(property.schema, overridden)) {
            refuse(key + '.' + name, `The default value of '${name}' for ${key} does not match its schema.`);
            continue;
          }
          const target = identifiers.length === 1 ? own : shared;
          for (const identifier of identifiers) {
            const values = target.get(identifier) ?? new Map<string, unknown>();
            target.set(identifier, values);
            values.set(name, overridden);
          }
        }
      }
    }
    const languages = shared;
    for (const [identifier, values] of own) {
      languages.set(identifier, new Map([...languages.get(identifier) ?? [], ...values]));
    }

    const effective = new Map<string, IConfigurationPropertySchema>();
    for (const [key, { schema }] of this.properties) {
      const overridden = base.get(key);
      const value = overridden !== undefined && validateConfigurationValue(schema, overridden) ? overridden
        : schema.default !== undefined ? schema.default : getDefaultValue(schema.type);
      effective.set(key, Object.freeze({ ...schema, default: value }));
    }
    const languageDefaults = new Map<string, ReadonlyMap<string, unknown>>();
    for (const [language, values] of languages) {
      const valid = new Map([...values].filter(([key, value]) => {
        const property = this.properties.get(key);
        return property && validateConfigurationValue(property.schema, value);
      }));
      if (valid.size) {
        languageDefaults.set(language, valid);
      }
    }
    this.effective = effective;
    this.languageDefaults = languageDefaults;
    return problems;
  }
}

export const configurationRegistry = new ConfigurationRegistry();
