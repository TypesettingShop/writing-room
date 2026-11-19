import { toDisposable } from '../../../base/common/lifecycle.js';
import type { DisposableStore } from '../../../base/common/lifecycle.js';
import { configurationRegistry, OVERRIDE_PROPERTY_REGEX } from '../../../platform/configuration/common/configurationRegistry.js';
import type {
  IConfigurationDefaults, IConfigurationNode, IConfigurationProblem, IConfigurationPropertySchema,
} from '../../../platform/configuration/common/configurationRegistry.js';
import { isRecord } from '../../../platform/extensions/common/extensionValidator.js';
import { ExtensionsRegistry } from '../../services/extensions/common/extensionsRegistry.js';
import type { ExtensionMessageCollector, IExtensionPointUser } from '../../services/extensions/common/extensionsRegistry.js';

/**
 * What a point put into the registry, and which `accept` put it there. The host disposes every point's
 * registrations and calls `accept` again whenever the extensions change. Registering from scratch each time
 * would send a property through "removed" and "added", and a reader would see its value go to `undefined`
 * and come back. So `accept` swaps the old registration for the new one in one registry update, which a
 * reader sees as no change when the manifests are the same, and a dispose only releases the registration
 * when no `accept` followed it in the same turn.
 */
class Contribution<T> {
  private generation = 0;
  current: readonly T[] = [];

  /** Replaces the current registration; `release` removes it. The returned disposable releases it later. */
  replace(next: readonly T[], swap: (previous: readonly T[], next: readonly T[]) => void, release: (previous: readonly T[]) => void) {
    const mine = ++this.generation;
    swap(this.current, next);
    this.current = next;
    return toDisposable(() => queueMicrotask(() => {
      if (this.generation === mine) {
        const previous = this.current;
        this.current = [];
        release(previous);
      }
    }));
  }
}

const languageKeyMessage = (key: string) =>
  `Cannot register '${key}'. This property matches the property pattern '\\[.*\\]$' for describing language specific editor settings. Use 'configurationDefaults' contribution.`;

function problemReporter(users: readonly IExtensionPointUser<unknown>[], path: (problem: IConfigurationProblem) => string) {
  const collectors = new Map<string, ExtensionMessageCollector>(users.map(user => [user.description.identifier.value, user.collector]));
  return (problem: IConfigurationProblem) => {
    collectors.get(problem.source)?.warn(path(problem), `'${problem.source}': ${problem.message}`);
  };
}

const configuration = new Contribution<IConfigurationNode>();

ExtensionsRegistry.registerExtensionPoint<unknown>({
  name: 'configuration',
  validate: (value): value is unknown => isRecord(value) || Array.isArray(value),
  accept(users, registrations) {
    const nodes: IConfigurationNode[] = [];
    for (const user of users) {
      const id = user.description.identifier.value;
      const base = 'contributes.configuration';
      const entries = Array.isArray(user.value) ? user.value : [user.value];
      entries.forEach((entry, index) => {
        const path = Array.isArray(user.value) ? `${base}[${index}]` : base;
        if (!isRecord(entry)) {
          user.collector.error(path, 'Expected a configuration object.');
          return;
        }
        const { title, order, properties } = entry;
        if (title !== undefined && typeof title !== 'string') {
          user.collector.error(path + '.title', "Expected 'title' to be a string.");
          return;
        }
        if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
          user.collector.error(path + '.order', "Expected 'order' to be a number.");
          return;
        }
        if (properties !== undefined && !isRecord(properties)) {
          user.collector.error(path + '.properties', "Expected 'properties' to be an object.");
          return;
        }
        const accepted: Record<string, IConfigurationPropertySchema> = {};
        for (const [key, schema] of Object.entries(properties ?? {})) {
          if (OVERRIDE_PROPERTY_REGEX.test(key)) {
            user.collector.warn(`${path}.properties.${key}`, `'${id}': ${languageKeyMessage(key)}`);
          } else {
            accepted[key] = schema as IConfigurationPropertySchema;
          }
        }
        if (Object.keys(accepted).length) {
          nodes.push({ id, extensionId: id, title, order, properties: accepted });
        }
      });
    }
    const report = problemReporter(users, problem => `contributes.configuration.properties.${problem.key}`);
    registrations.add(configuration.replace(nodes,
      (previous, next) => configurationRegistry.updateConfigurations({ remove: previous, add: next }, report),
      previous => configurationRegistry.updateConfigurations({ remove: previous })));
  },
});

const configurationDefaults = new Contribution<IConfigurationDefaults>();

ExtensionsRegistry.registerExtensionPoint<Record<string, unknown>>({
  name: 'configurationDefaults',
  after: ['configuration'],
  validate: (value): value is Record<string, unknown> => isRecord(value),
  accept(users: readonly IExtensionPointUser<Record<string, unknown>>[], registrations: DisposableStore) {
    const defaults: IConfigurationDefaults[] = users.map(user => ({ overrides: user.value, source: user.description.identifier.value }));
    const report = problemReporter(users, problem => `contributes.configurationDefaults.${problem.key}`);
    registrations.add(configurationDefaults.replace(defaults,
      (previous, next) => configurationRegistry.updateConfigurations({ removeDefaults: previous, addDefaults: next }, report),
      previous => configurationRegistry.updateConfigurations({ removeDefaults: previous })));
  },
});
