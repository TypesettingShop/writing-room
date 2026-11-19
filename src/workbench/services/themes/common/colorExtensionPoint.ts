import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { colorRegistry, isColorIdentifier, isHexColor } from '../../../../platform/theme/common/colorRegistry.js';
import type { ColorContribution, ColorValue } from '../../../../platform/theme/common/colorRegistry.js';
import { ExtensionsRegistry } from '../../extensions/common/extensionsRegistry.js';
import type { ExtensionMessageCollector } from '../../extensions/common/extensionsRegistry.js';

/** The colors extensions registered, by id, with what they registered: re-applying the same set changes nothing. */
const contributed = new Map<string, string>();
let generation = 0;

function signature(color: ColorContribution): string {
  return JSON.stringify([color.extensionId, color.description, color.defaults]);
}

/** Makes the registry's contributed colors `next`, with one change event when anything differs. */
function sync(next: readonly ColorContribution[]): void {
  const wanted = new Map(next.map(color => [color.id, color]));
  const remove: string[] = [];
  for (const [id, registered] of contributed) {
    const color = wanted.get(id);
    if (!color || signature(color) !== registered) {
      remove.push(id);
    }
  }
  const add = next.filter(color => contributed.get(color.id) !== signature(color));
  if (!remove.length && !add.length) {
    return;
  }
  colorRegistry.changeColors(remove, add);
  for (const id of remove) {
    contributed.delete(id);
  }
  for (const color of add) {
    contributed.set(color.id, signature(color));
  }
}

/**
 * Registers `colors` in place of what the last call registered. Releasing the result removes them a
 * microtask later, unless another call came first: the extension service releases and applies every
 * contribution again on each theme change, and that must not remove and re-add the same colors.
 */
function applyContributedColors(colors: readonly ColorContribution[]): IDisposable {
  const mine = ++generation;
  sync(colors);
  return toDisposable(() => queueMicrotask(() => {
    if (generation === mine) {
      sync([]);
    }
  }));
}

/** A default as VS Code reads it: a hex color, or the id of another color. */
function readDefault(value: unknown, path: string, collector: ExtensionMessageCollector): ColorValue | undefined {
  if (typeof value === 'string' && (isHexColor(value) || isColorIdentifier(value))) {
    return value;
  }
  collector.error(path, `Expected a hex color (#RGB, #RGBA, #RRGGBB or #RRGGBBAA) or a color id, not '${String(value)}'. The color is ignored.`);
  return undefined;
}

function readColor(entry: unknown, path: string, extensionId: string, collector: ExtensionMessageCollector): ColorContribution | undefined {
  if (!isRecord(entry)) {
    collector.error(path, 'Expected a color object with `id`, `description` and `defaults`.');
    return undefined;
  }
  if (typeof entry.id !== 'string' || !entry.id) {
    collector.error(path + '.id', '\'configuration.colors.id\' must be defined and can not be empty');
    return undefined;
  }
  if (!isColorIdentifier(entry.id)) {
    collector.error(path + '.id', '\'configuration.colors.id\' must only contain letters, digits and dots and can not start with a dot');
    return undefined;
  }
  if (typeof entry.description !== 'string' || !entry.description) {
    collector.error(path + '.description', '\'configuration.colors.description\' must be defined and can not be empty');
    return undefined;
  }
  const defaults = entry.defaults;
  if (!isRecord(defaults) || defaults.light === undefined || defaults.dark === undefined) {
    collector.error(path + '.defaults', '\'configuration.colors.defaults\' must be defined and must contain \'light\' and \'dark\'');
    return undefined;
  }
  const dark = readDefault(defaults.dark, path + '.defaults.dark', collector);
  const light = readDefault(defaults.light, path + '.defaults.light', collector);
  const hcDark = defaults.highContrast === undefined ? dark : readDefault(defaults.highContrast, path + '.defaults.highContrast', collector);
  const hcLight = defaults.highContrastLight === undefined ? light
    : readDefault(defaults.highContrastLight, path + '.defaults.highContrastLight', collector);
  if (dark === undefined || light === undefined || hcDark === undefined || hcLight === undefined) {
    return undefined;
  }
  return { id: entry.id, description: entry.description, defaults: { dark, light, hcDark, hcLight }, extensionId };
}

ExtensionsRegistry.registerExtensionPoint<unknown[]>({
  name: 'colors',
  validate: (value): value is unknown[] => Array.isArray(value),
  accept(users, registrations) {
    const colors: ColorContribution[] = [];
    const seen = new Set<string>();
    for (const { description, value, collector } of users) {
      const extensionId = description.identifier.value;
      value.forEach((entry, index) => {
        const path = `contributes.colors[${index}]`;
        const color = readColor(entry, path, extensionId, collector);
        if (!color) {
          return;
        }
        // A color the workbench or an earlier extension registered stays theirs.
        const existing = colorRegistry.getColor(color.id);
        if (seen.has(color.id) || (existing && !contributed.has(color.id))) {
          collector.error(path + '.id', `The color '${color.id}' is already registered. The color is ignored.`);
          return;
        }
        seen.add(color.id);
        colors.push(color);
      });
    }
    registrations.add(applyContributedColors(colors));
  },
});
