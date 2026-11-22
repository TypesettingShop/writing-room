import { Emitter } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { ThemeIcon } from '../../../base/common/themables.js';
import { CommandsRegistry } from '../../commands/common/commands.js';
import type { ICommandHandler, ICommandService } from '../../commands/common/commands.js';
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
  readonly labelClass?: string;
  readonly precondition?: ContextKeyExpression;
  readonly toggled?: ContextKeyExpression;
  readonly forwardMenuContext?: MenuId;
}

interface IMenuEntry {
  readonly when?: ContextKeyExpression;
  readonly group?: string;
  readonly order?: number;
}

export interface IMenuItem extends IMenuEntry {
  readonly command: ICommandAction;
  readonly args?: readonly unknown[];
  readonly numberInput?: IMenuNumberInput;
}

export interface IMenuNumberInput {
  readonly valueKey: string;
  readonly min: number;
  readonly max: number;
}

/** A label a select submenu shows when no listed choice is checked but `when` holds. */
export interface IMenuSelectFallback {
  readonly label: string;
  readonly when: ContextKeyExpression | undefined;
}

export interface ISubmenuItem extends IMenuEntry {
  readonly submenu: MenuId;
  readonly forwardMenuContext?: MenuId;
  readonly title: CommandTitle;
  readonly icon?: CommandIcon;
  readonly select?: boolean;
  readonly selectFallback?: readonly IMenuSelectFallback[];
  /** Context key containing the display label when no listed choice is checked. */
  readonly selectLabelKey?: string;
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
  static readonly EditorContext = new MenuId('EditorContext');
  static readonly MarkdownEditorToolbar = new MenuId('MarkdownEditorToolbar');
  static readonly MarkdownEditorSelection = new MenuId('MarkdownEditorSelection');
  static readonly ExplorerContext = new MenuId('ExplorerContext');
  static readonly ManuscriptNavigatorContext = new MenuId('ManuscriptNavigatorContext');
  static readonly WebviewContext = new MenuId('WebviewContext');
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

export type IMenuContext = Pick<IContextKeyService, 'contextMatchesRules' | 'onDidChangeContext'>
  & Partial<Pick<IContextKeyService, 'getContextKeyValue'>>;

export class MenuCommandContext {
  constructor(readonly menu: MenuId, readonly scope: IMenuContext) {}
}

/** Command handlers that can receive a menu invocation before their positional arguments. */
export const menuContextHandlers = new WeakSet<ICommandHandler>();

export class MenuItemAction {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly checked: boolean | undefined;
  readonly icon: CommandIcon | undefined;
  readonly labelClass: string | undefined;
  readonly keybinding: ResolvedKeybinding | undefined;
  private menuContext: MenuId | undefined;

  constructor(
    readonly item: ICommandAction,
    private readonly context: IMenuContext,
    keybindings: IKeybindingService,
    private readonly commandService: ICommandService,
    private readonly menuArgs: readonly unknown[] = [],
    readonly numberInput?: IMenuNumberInput,
  ) {
    this.id = item.id;
    this.label = commandTitle(item.title);
    this.enabled = context.contextMatchesRules(item.precondition);
    this.checked = item.toggled && context.contextMatchesRules(item.toggled);
    this.icon = item.icon;
    this.labelClass = item.labelClass;
    this.keybinding = menuArgs.length ? undefined : keybindings.lookupKeybinding(item.id);
    this.menuContext = item.forwardMenuContext;
  }

  setMenuContext(menu: MenuId): void {
    this.menuContext = menu;
  }

  run(...args: unknown[]): Promise<unknown> {
    if (this.menuContext) {
      const command = CommandsRegistry.getCommand(this.id);
      if (!command || menuContextHandlers.has(command.handler)) {
        return this.commandService.executeCommand(
          this.id, new MenuCommandContext(this.menuContext, this.context), ...this.menuArgs, ...args,
        );
      }
    }
    return this.commandService.executeCommand(this.id, ...this.menuArgs, ...args);
  }
}

export class SubmenuItemAction {
  readonly id: string;
  readonly label: string;
  readonly enabled = true;
  readonly icon: CommandIcon | undefined;

  get radioItems(): boolean | undefined {
    return this.item.select;
  }

  constructor(readonly item: ISubmenuItem, readonly groups: MenuActionGroup[]) {
    this.id = item.submenu.id;
    this.label = commandTitle(item.title);
    this.icon = item.icon;
    if (item.forwardMenuContext) {
      this.setMenuContext(item.forwardMenuContext);
    }
  }

  setMenuContext(menu: MenuId): void {
    for (const [, actions] of this.groups) {
      for (const action of actions) {
        action.setMenuContext(menu);
      }
    }
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
    // As in VS Code, the palette lists the command only while its precondition holds.
    registrations.add(MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command, when: command.precondition }));
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
