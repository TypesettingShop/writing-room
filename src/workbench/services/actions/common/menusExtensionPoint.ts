import { ThemeIcon } from '../../../../base/common/themables.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { ICommandContribution, IMenuContribution } from '../../../../platform/extensions/common/extensions.js';
import { contributionEntries, contributionIcon, contributionRecord, contributionWhen } from '../../extensions/common/contributionValidation.js';
import type { IExtensionPointUser } from '../../extensions/common/extensionsRegistry.js';

const apiMenus = new Map([
  ['commandPalette', MenuId.CommandPalette],
  ['editor/title', MenuId.EditorTitle],
  ['editor/title/context', MenuId.EditorTitleContext],
  ['view/title', MenuId.ViewTitle],
  ['view/item/context', MenuId.ViewItemContext],
]);

export function registerCommands(
  users: readonly IExtensionPointUser<unknown>[], registrations: DisposableStore,
  contributed: Map<string, string>, events: Map<string, Set<string>>,
): void {
  contributed.clear();
  for (const user of users) {
    const base = 'contributes.commands';
    for (const [index, value] of contributionEntries(user.value, base, user).entries()) {
      const path = base + '.' + index;
      const entry = contributionRecord<ICommandContribution>(value, path, user, ['command', 'title'], ['category', 'icon', 'enablement']);
      if (!entry) {
        continue;
      }
      const icon = entry.icon === undefined ? undefined : contributionIcon(entry.icon, path + '.icon', user);
      const precondition = contributionWhen(entry.enablement, path + '.enablement', user);
      if (precondition === false || (entry.icon !== undefined && !icon)) {
        continue;
      }
      if (MenuRegistry.getCommand(entry.command)) {
        user.collector.info(path + '.command', `Replacing metadata for '${entry.command}'.`);
      }
      const owner = user.description.identifier.value;
      contributed.set(entry.command, owner);
      events.get(owner)?.add('onCommand:' + entry.command);
      registrations.add(MenuRegistry.addCommand({
        id: entry.command, title: entry.title, category: entry.category,
        icon: typeof icon === 'string' ? ThemeIcon.fromString(icon) : icon, precondition,
      }));
    }
  }
}

export function registerMenus(
  users: readonly IExtensionPointUser<Readonly<Record<string, unknown>>>[], registrations: DisposableStore,
  contributed: ReadonlyMap<string, string>,
): void {
  for (const user of users) {
    for (const [key, values] of Object.entries(user.value)) {
      const base = 'contributes.menus.' + key;
      const menu = apiMenus.get(key);
      if (!menu) {
        user.collector.warn(base, 'Unsupported menu.');
        continue;
      }
      for (const [index, value] of contributionEntries(values, base, user).entries()) {
        const path = base + '.' + index;
        const entry = contributionRecord<IMenuContribution>(value, path, user, ['command'], ['group', 'when']);
        if (!entry) {
          continue;
        }
        const command = contributed.has(entry.command) ? MenuRegistry.getCommand(entry.command) : undefined;
        if (!command) {
          user.collector.error(path + '.command', `Command '${entry.command}' is not declared in contributes.commands.`);
          continue;
        }
        const when = contributionWhen(entry.when, path + '.when', user);
        if (when === false) {
          continue;
        }
        const ordered = entry.group && /^(.*)@(-?\d+(?:\.\d+)?)$/.exec(entry.group);
        registrations.add(MenuRegistry.appendMenuItem(menu, {
          command, when, group: ordered ? ordered[1] : entry.group, order: ordered ? Number(ordered[2]) : undefined,
        }));
      }
    }
  }
}
