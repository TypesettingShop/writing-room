import { ThemeIcon } from '../../../../base/common/themables.js';
import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import type { CommandIcon, ISubmenuItem } from '../../../../platform/actions/common/actions.js';
import { isRecord, nonemptyString } from '../../../../platform/extensions/common/extensionValidator.js';
import { contributionEntries, contributionIcon, contributionRecord, contributionWhen } from '../../extensions/common/contributionValidation.js';
import { resolveExtensionPath } from '../../extensions/common/extensionResources.js';
import { ExtensionsRegistry } from '../../extensions/common/extensionsRegistry.js';
import type { ExtensionPointContext, IExtensionPointUser } from '../../extensions/common/extensionsRegistry.js';

interface ICommandContribution {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
  readonly icon?: unknown;
  readonly enablement?: string;
}

interface ISubmenuContribution {
  readonly id: string;
  readonly label: string;
  readonly icon?: unknown;
}

interface IMenuContribution {
  readonly command?: string;
  readonly submenu?: string;
  readonly alt?: string;
  readonly when?: string;
  readonly group?: string;
}

const apiMenus = new Map([
  ['commandPalette', MenuId.CommandPalette],
  ['editor/title', MenuId.EditorTitle],
  ['editor/title/context', MenuId.EditorTitleContext],
  ['editor/context', MenuId.EditorContext],
  ['explorer/context', MenuId.ExplorerContext],
  ['webview/context', MenuId.WebviewContext],
  ['view/title', MenuId.ViewTitle],
  ['view/item/context', MenuId.ViewItemContext],
]);

const resourceMenus = new Set([MenuId.EditorTitle, MenuId.EditorTitleContext, MenuId.EditorContext, MenuId.ExplorerContext]);
const submenusByContext = new WeakMap<ExtensionPointContext, ReadonlyMap<string, ISubmenuItem>>();

function readIcon(
  input: unknown, path: string, user: IExtensionPointUser<unknown>, isLightTheme: boolean,
): CommandIcon | undefined {
  if (typeof input === 'string') {
    const icon = contributionIcon(input, path, user);
    return typeof icon === 'string' ? ThemeIcon.fromString(icon) : icon;
  }
  if (input === undefined) {
    return undefined;
  }
  const locations = new Map<string, URL>();
  for (const theme of ['light', 'dark'] as const) {
    const value = isRecord(input) && input[theme];
    const resource = typeof value === 'string' ? resolveExtensionPath(user.description.location, value) : undefined;
    if (resource) {
      locations.set(theme, resource);
    } else {
      user.collector.error(path + '.' + theme, 'Expected a path inside the extension directory.', true);
    }
  }
  if (locations.size !== 2) {
    return undefined;
  }
  const resource = locations.get(isLightTheme ? 'light' : 'dark')!;
  return user.resolveIcon?.(resource) ?? resource;
}

function registerCommands(
  users: readonly IExtensionPointUser<unknown>[], registrations: DisposableStore, context: ExtensionPointContext,
): void {
  for (const user of users) {
    const base = 'contributes.commands';
    for (const [index, value] of contributionEntries(user.value, base, user).entries()) {
      const path = base + '.' + index;
      const entry = contributionRecord<ICommandContribution>(value, path, user, ['command', 'title'], ['category', 'enablement']);
      if (!entry) {
        continue;
      }
      const precondition = contributionWhen(entry.enablement, path + '.enablement', user);
      if (precondition === false) {
        continue;
      }
      const icon = readIcon(entry.icon, path + '.icon', user, context.isLightTheme ?? false);
      if (MenuRegistry.getCommand(entry.command)) {
        user.collector.info(path + '.command', 'Replacing metadata for ' + entry.command + '.');
      }
      const owner = user.description.identifier.value;
      context.setCommandOwner(entry.command, owner);
      context.addActivationEvent(owner, 'onCommand:' + entry.command);
      registrations.add(MenuRegistry.addCommand({
        id: entry.command, title: entry.title, category: entry.category, icon, precondition,
      }));
    }
  }
}

function registerSubmenus(
  users: readonly IExtensionPointUser<unknown>[], _registrations: DisposableStore, context: ExtensionPointContext,
): void {
  const submenus = new Map<string, ISubmenuItem>();
  for (const user of users) {
    const base = 'contributes.submenus';
    for (const [index, value] of contributionEntries(user.value, base, user).entries()) {
      const path = base + '.' + index;
      const entry = contributionRecord<ISubmenuContribution>(value, path, user, ['id', 'label']);
      if (!entry) {
        continue;
      }
      if (submenus.has(entry.id) || apiMenus.has(entry.id)) {
        user.collector.error(path + '.id', "Submenu '" + entry.id + "' already exists.");
        continue;
      }
      submenus.set(entry.id, {
        submenu: MenuId.for('extension.submenu.' + entry.id), title: entry.label,
        icon: readIcon(entry.icon, path + '.icon', user, context.isLightTheme ?? false),
      });
    }
  }
  submenusByContext.set(context, submenus);
}

function registerMenus(
  users: readonly IExtensionPointUser<Readonly<Record<string, unknown>>>[],
  registrations: DisposableStore, context: ExtensionPointContext,
): void {
  const submenus = submenusByContext.get(context);
  for (const user of users) {
    for (const [key, values] of Object.entries(user.value)) {
      const base = 'contributes.menus.' + key;
      const menu = apiMenus.get(key) ?? submenus?.get(key)?.submenu;
      if (!menu) {
        user.collector.warn(base, 'Unsupported menu.');
        continue;
      }
      for (const [index, value] of contributionEntries(values, base, user).entries()) {
        const path = base + '.' + index;
        const entry = contributionRecord<IMenuContribution>(value, path, user, [], ['command', 'submenu', 'alt', 'group', 'when']);
        if (!entry) {
          continue;
        }
        const commandId = nonemptyString(entry.command) ? entry.command : undefined;
        const submenuId = nonemptyString(entry.submenu) ? entry.submenu : undefined;
        if (Boolean(commandId) === Boolean(submenuId)) {
          user.collector.error(path, 'Expected a command or submenu.');
          continue;
        }
        const when = contributionWhen(entry.when, path + '.when', user);
        if (when === false) {
          continue;
        }
        const ordered = entry.group && /^(.*)@(-?\d+(?:\.\d+)?)$/.exec(entry.group);
        const placement = { when, group: ordered ? ordered[1] : entry.group, order: ordered ? Number(ordered[2]) : undefined };
        const forwardMenuContext = resourceMenus.has(menu) ? menu : undefined;
        if (commandId) {
          const command = context.getCommandOwner(commandId) ? MenuRegistry.getCommand(commandId) : undefined;
          if (!command) {
            user.collector.error(path + '.command', "Command '" + entry.command + "' is not declared in contributes.commands.");
            continue;
          }
          const metadata = forwardMenuContext ? { ...command, forwardMenuContext } : command;
          registrations.add(MenuRegistry.appendMenuItem(menu, { ...placement, command: metadata }));
        } else {
          const submenu = submenuId && submenus?.get(submenuId);
          if (!submenu || submenu.submenu === menu) {
            user.collector.error(path + '.submenu', "Invalid submenu '" + entry.submenu + "'.");
            continue;
          }
          registrations.add(MenuRegistry.appendMenuItem(menu, { ...placement, ...submenu, forwardMenuContext }));
        }
      }
    }
  }
}

ExtensionsRegistry.registerExtensionPoint({
  name: 'commands',
  validate: (_value): _value is unknown => true,
  accept: registerCommands,
});

ExtensionsRegistry.registerExtensionPoint({
  name: 'submenus',
  validate: (_value): _value is unknown => true,
  accept: registerSubmenus,
});

ExtensionsRegistry.registerExtensionPoint({
  name: 'menus',
  after: ['commands', 'submenus'],
  validate: isRecord,
  accept: registerMenus,
});
