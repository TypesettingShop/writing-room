import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ICommandService } from '../../commands/common/commands.js';
import type { ContextKeyExpression } from '../../contextkey/common/contextkey.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { IKeybindingService } from '../../keybinding/common/keybinding.js';
import {
  commandTitle, IMenuService, isIMenuItem, MenuItemAction, MenuRegistry, SubmenuItemAction,
} from './actions.js';
import type { IMenu, IMenuContext, IMenuItem, ISubmenuItem, MenuActionGroup, MenuId } from './actions.js';

function compareItems(a: IMenuItem | ISubmenuItem, b: IMenuItem | ISubmenuItem): number {
  const first = a.group ?? '';
  const second = b.group ?? '';
  if (first !== second) {
    if (first === 'navigation' || second === '') {
      return -1;
    }
    if (second === 'navigation' || first === '') {
      return 1;
    }
    return first.localeCompare(second);
  }
  return (a.order ?? 0) - (b.order ?? 0)
    || commandTitle(isIMenuItem(a) ? a.command.title : a.title)
      .localeCompare(commandTitle(isIMenuItem(b) ? b.command.title : b.title));
}

class MenuInfo {
  readonly keys = new Set<string>();
  readonly menus = new Map<MenuId, (IMenuItem | ISubmenuItem)[]>();

  constructor(id: MenuId) { this.collect(id); }

  private collect(id: MenuId): void {
    if (this.menus.has(id)) {
      return;
    }
    const items = MenuRegistry.getMenuItems(id).sort(compareItems);
    this.menus.set(id, items);
    for (const item of items) {
      this.collectKeys(item.when);
      if (isIMenuItem(item)) {
        this.collectKeys(item.command.precondition);
        this.collectKeys(item.command.toggled);
      } else {
        this.collect(item.submenu);
      }
    }
  }

  private collectKeys(expression: ContextKeyExpression | undefined): void {
    for (const key of expression?.keys() ?? []) {
      this.keys.add(key);
    }
  }

  getActions(id: MenuId, context: IMenuContext, keys: IKeybindingService, commands: ICommandService):
  MenuActionGroup[] {
    const visited = new Set<MenuId>();
    function actionsFor(menu: MenuId, menus: MenuInfo['menus']): MenuActionGroup[] {
      if (visited.has(menu)) {
        return [];
      }
      visited.add(menu);
      const groups = new Map<string, MenuActionGroup[1]>();
      for (const item of menus.get(menu) ?? []) {
        if (!context.contextMatchesRules(item.when)) {
          continue;
        }
        let action: MenuItemAction | SubmenuItemAction;
        if (isIMenuItem(item)) {
          action = new MenuItemAction(item.command, context, keys, commands);
        } else {
          const children = actionsFor(item.submenu, menus);
          if (children.length === 0) {
            continue;
          }
          action = new SubmenuItemAction(item, children);
        }
        const group = item.group ?? '';
        const actions = groups.get(group) ?? [];
        actions.push(action);
        groups.set(group, actions);
      }
      visited.delete(menu);
      return [...groups];
    }
    return actionsFor(id, this.menus);
  }
}

class MenuImpl extends Disposable implements IMenu {
  private info: MenuInfo;
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly id: MenuId,
    private readonly context: IMenuContext,
    private readonly keys: IKeybindingService,
    private readonly commands: ICommandService,
  ) {
    super();
    this.info = new MenuInfo(id);
    this._register(MenuRegistry.onDidChangeMenu(event => {
      if ([...this.info.menus.keys()].some(menu => event.has(menu))) {
        this.info = new MenuInfo(id);
        this.changed.fire();
      }
    }));
    this._register(context.onDidChangeContext(event => {
      if (event.affectsSome(this.info.keys)) {
        this.changed.fire();
      }
    }));
    this._register(keys.onDidUpdateKeybindings(() => this.changed.fire()));
  }

  getActions(): MenuActionGroup[] {
    // Registry change events are batched, but a direct read sees registrations synchronously.
    this.info = new MenuInfo(this.id);
    return this.info.getActions(this.id, this.context, this.keys, this.commands);
  }
}

export class MenuService implements IMenuService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ICommandService private readonly commands: ICommandService,
    @IKeybindingService private readonly keys: IKeybindingService,
  ) {}

  createMenu(id: MenuId, contextKeyService: IMenuContext): IMenu {
    return new MenuImpl(id, contextKeyService, this.keys, this.commands);
  }

  getMenuActions(id: MenuId, contextKeyService: IMenuContext): MenuActionGroup[] {
    return new MenuInfo(id).getActions(id, contextKeyService, this.keys, this.commands);
  }
}

registerSingleton(IMenuService, MenuService);
