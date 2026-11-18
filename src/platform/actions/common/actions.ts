import { Emitter } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { ThemeIcon } from '../../../base/common/themables.js';
import { CommandsRegistry } from '../../commands/common/commands.js';
import type { ICommandService } from '../../commands/common/commands.js';
import { ContextKeyExpr } from '../../contextkey/common/contextkey.js';
import type { ContextKeyExpression, IContextKeyService } from '../../contextkey/common/contextkey.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService, ServicesAccessor } from '../../instantiation/common/instantiation.js';
import type { IKeybindingService, ResolvedKeybinding } from '../../keybinding/common/keybinding.js';
import { KeybindingsRegistry } from '../../keybinding/common/keybindingsRegistry.js';
import type { IKeybindingRule } from '../../keybinding/common/keybindingsRegistry.js';
import type { Event } from '../../../base/common/event.js';

export type CommandTitle = string | { readonly value: string; readonly original: string };
export type CommandIcon = ThemeIcon | string | URL;

export function commandTitle(title: CommandTitle): string {
  return typeof title === 'string' ? title : title.value;
}

export interface ICommandAction {
  readonly id: string;
  readonly title: CommandTitle;
  readonly category?: CommandTitle;
  readonly icon?: CommandIcon;
  readonly precondition?: ContextKeyExpression;
  readonly toggled?: ContextKeyExpression;
}

interface IMenuEntry {
  readonly when?: ContextKeyExpression;
  readonly group?: string;
  readonly order?: number;
}

export interface IMenuItem extends IMenuEntry {
  readonly command: ICommandAction;
}

export interface ISubmenuItem extends IMenuEntry {
  readonly submenu: MenuId;
  readonly title: CommandTitle;
  readonly icon?: CommandIcon;
}

export function isIMenuItem(item: IMenuItem | ISubmenuItem): item is IMenuItem {
  return 'command' in item;
}

export class MenuId {
  private static readonly instances = new Map<string, MenuId>();

  static readonly CommandPalette = new MenuId('CommandPalette');
  static readonly MenubarMainMenu = new MenuId('MenubarMainMenu');
  static readonly MenubarFileMenu = new MenuId('MenubarFileMenu');
  static readonly MenubarEditMenu = new MenuId('MenubarEditMenu');
  static readonly MenubarViewMenu = new MenuId('MenubarViewMenu');
  static readonly MenubarAppearanceMenu = new MenuId('MenubarAppearanceMenu');
  static readonly MenubarLayoutMenu = new MenuId('MenubarLayoutMenu');
  static readonly MenubarPreferencesMenu = new MenuId('MenubarPreferencesMenu');
  static readonly MenubarHelpMenu = new MenuId('MenubarHelpMenu');
  static readonly EditorTitle = new MenuId('EditorTitle');
  static readonly EditorTitleContext = new MenuId('EditorTitleContext');
  static readonly ViewTitle = new MenuId('ViewTitle');
  static readonly ViewItemContext = new MenuId('ViewItemContext');
  static readonly ViewContainerTitle = new MenuId('ViewContainerTitle');
  static readonly ViewContainerTitleContext = new MenuId('ViewContainerTitleContext');

  static for(identifier: string): MenuId {
    return this.instances.get(identifier) ?? new MenuId(identifier);
  }

  constructor(readonly id: string) {
    if (MenuId.instances.has(id)) {
      throw new Error(`MenuId '${id}' already exists`);
    }
    MenuId.instances.set(id, this);
  }
}

export interface IMenuRegistryChangeEvent {
  has(id: MenuId): boolean;
}

class MenuRegistryImpl {
  private readonly commands = new Map<string, { command: ICommandAction }[]>();
  private readonly menus = new Map<MenuId, Set<{ item: IMenuItem | ISubmenuItem }>>();
  private readonly changed = new Emitter<IMenuRegistryChangeEvent>();
  private pending = new Set<MenuId>();
  readonly onDidChangeMenu = this.changed.event;

  addCommand(command: ICommandAction): IDisposable {
    const entries = this.commands.get(command.id) ?? [];
    const entry = { command };
    entries.push(entry);
    this.commands.set(command.id, entries);
    this.markChanged(MenuId.CommandPalette);
    return toDisposable(() => {
      entries.splice(entries.indexOf(entry), 1);
      if (entries.length === 0) {
        this.commands.delete(command.id);
      }
      this.markChanged(MenuId.CommandPalette);
    });
  }

  getCommand(id: string): ICommandAction | undefined { return this.commands.get(id)?.at(-1)?.command; }

  getCommands(): Map<string, ICommandAction> {
    return new Map([...this.commands].map(([id, entries]) => [id, entries[entries.length - 1].command]));
  }

  appendMenuItem(id: MenuId, item: IMenuItem | ISubmenuItem): IDisposable {
    const entries = this.menus.get(id) ?? new Set();
    const entry = { item };
    entries.add(entry);
    this.menus.set(id, entries);
    this.markChanged(id);
    return toDisposable(() => {
      entries.delete(entry);
      if (entries.size === 0) {
        this.menus.delete(id);
      }
      this.markChanged(id);
    });
  }

  getMenuItems(id: MenuId): (IMenuItem | ISubmenuItem)[] {
    const items = [...this.menus.get(id) ?? []].map(entry => entry.item);
    if (id === MenuId.CommandPalette) {
      const explicit = new Set(items.filter(isIMenuItem).map(item => item.command.id));
      for (const [commandId, command] of this.getCommands()) {
        if (!explicit.has(commandId)) {
          items.push({ command });
        }
      }
    }
    return items;
  }

  private markChanged(id: MenuId): void {
    if (this.pending.size === 0) {
      queueMicrotask(() => {
        const ids = this.pending;
        this.pending = new Set();
        this.changed.fire(ids);
      });
    }
    this.pending.add(id);
  }
}

export const MenuRegistry = new MenuRegistryImpl();

export type IMenuContext = Pick<IContextKeyService, 'contextMatchesRules' | 'onDidChangeContext'>;

export class MenuItemAction {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly checked: boolean | undefined;
  readonly icon: CommandIcon | undefined;
  readonly keybinding: ResolvedKeybinding | undefined;

  constructor(
    readonly item: ICommandAction,
    context: IMenuContext,
    keybindings: IKeybindingService,
    private readonly commandService: ICommandService,
  ) {
    this.id = item.id;
    this.label = commandTitle(item.title);
    this.enabled = context.contextMatchesRules(item.precondition);
    this.checked = item.toggled && context.contextMatchesRules(item.toggled);
    this.icon = item.icon;
    this.keybinding = keybindings.lookupKeybinding(item.id);
  }

  run(...args: unknown[]): Promise<unknown> { return this.commandService.executeCommand(this.id, ...args); }
}

export class SubmenuItemAction {
  readonly id: string;
  readonly label: string;
  readonly enabled = true;
  readonly icon: CommandIcon | undefined;

  constructor(readonly item: ISubmenuItem, readonly groups: MenuActionGroup[]) {
    this.id = item.submenu.id;
    this.label = commandTitle(item.title);
    this.icon = item.icon;
  }
}

export type MenuActionGroup = [group: string, actions: (MenuItemAction | SubmenuItemAction)[]];

export const IMenuService = createDecorator<IMenuService>('menuService');

export interface IMenu extends IDisposable {
  readonly onDidChange: Event<void>;
  getActions(): MenuActionGroup[];
}

export interface IMenuService extends BrandedService {
  createMenu(id: MenuId, contextKeyService: IMenuContext): IMenu;
  getMenuActions(id: MenuId, contextKeyService: IMenuContext): MenuActionGroup[];
}

export interface IAction2Options extends ICommandAction {
  readonly f1?: boolean;
  readonly menu?: (IMenuEntry & { readonly id: MenuId }) | readonly (IMenuEntry & { readonly id: MenuId })[];
  readonly keybinding?: Omit<IKeybindingRule, 'id'> | readonly Omit<IKeybindingRule, 'id'>[];
}

export abstract class Action2 {
  constructor(readonly desc: IAction2Options) {}
  abstract run(accessor: ServicesAccessor, ...args: any[]): unknown;
}

export function registerAction2(ctor: new () => Action2): IDisposable {
  const action = new ctor();
  const { id, f1, menu, keybinding, ...metadata } = action.desc;
  const command = { id, ...metadata };
  const registrations = new DisposableStore();

  registrations.add(CommandsRegistry.registerCommand(id, (accessor, ...args) => action.run(accessor, ...args)));
  if (f1) {
    registrations.add(MenuRegistry.addCommand(command));
  }
  for (const entry of menu ? [menu].flat() : []) {
    registrations.add(MenuRegistry.appendMenuItem(entry.id, { ...entry, command }));
  }
  for (const rule of keybinding ? [keybinding].flat() : []) {
    registrations.add(KeybindingsRegistry.registerKeybindingRule({
      ...rule, id, when: ContextKeyExpr.and(command.precondition, rule.when),
    }));
  }
  return registrations;
}
