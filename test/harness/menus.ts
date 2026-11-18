import '@vscode/codicons/dist/codicon.css';
import '../../src/workbench/platformServices.contribution.js';
import { Event } from '../../src/base/common/event.js';
import { MenuWorkbenchToolBar } from '../../src/platform/actions/browser/toolbar.js';
import { IMenuService, MenuId, MenuRegistry } from '../../src/platform/actions/common/actions.js';
import { CommandsRegistry } from '../../src/platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../src/platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../src/platform/contextview/browser/contextMenuService.js';
import { InstantiationService } from '../../src/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../src/platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../src/platform/keybinding/common/keybinding.js';
import { CustomMenubarControl } from '../../src/workbench/browser/parts/titlebar/menubarControl.js';

const services = new ServiceCollection();
services.set(IKeybindingService, {
  _serviceBrand: undefined, onDidUpdateKeybindings: Event.None,
  lookupKeybinding: id => id === 'test.new' ? { getLabel: () => 'Ctrl+F8', getAriaLabel: () => 'Control+F8' } : undefined,
});
const instantiation = new InstantiationService(services);
const output = document.querySelector('output')!;
let runs = 0;
function command(id: string, title: string) {
  CommandsRegistry.registerCommand(id, () => { output.value = String(++runs); });
  return { id, title };
}
const make = command('test.new', 'New Draft');
const disabled = { ...command('test.disabled', 'Unavailable'), precondition: ContextKeyExpr.false() };
const edit = command('test.edit', 'Edit Draft');
const appearance = command('test.appearance', 'Show Grid');
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, { command: make, order: 1 });
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, { command: disabled });
MenuRegistry.appendMenuItem(MenuId.MenubarEditMenu, { command: edit, when: ContextKeyExpr.has('editVisible') });
MenuRegistry.appendMenuItem(MenuId.MenubarAppearanceMenu, { command: { ...appearance, toggled: ContextKeyExpr.true() } });
MenuRegistry.appendMenuItem(MenuId.EditorTitle, { command: { ...make, icon: { id: 'add' } }, group: 'navigation' });
MenuRegistry.appendMenuItem(MenuId.EditorTitle, { command: edit, group: 'other' });
MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, { command: make });

const { context, menu, contextMenu } = instantiation.invokeFunction(accessor => ({
  context: accessor.get(IContextKeyService),
  menu: accessor.get(IMenuService),
  contextMenu: accessor.get(IContextMenuService),
}));
const visible = context.createKey<boolean>('editVisible', false);
document.querySelector('#toggle')!.addEventListener('click', () => visible.set(!visible.get()));
document.querySelector('#add')!.addEventListener('click', () => {
  MenuRegistry.appendMenuItem(MenuId.MenubarHelpMenu, { command: command('test.help', 'Help Item') });
}, { once: true });
document.querySelector('#context')!.addEventListener('contextmenu', event => {
  event.preventDefault();
  contextMenu.showContextMenu({
    getAnchor: () => ({ x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY }),
    getActions: () => menu.getMenuActions(MenuId.EditorTitleContext, context),
  });
});

instantiation.createInstance(CustomMenubarControl).installMenubar(document.querySelector<HTMLElement>('#bar')!);
instantiation.createInstance(MenuWorkbenchToolBar, document.querySelector<HTMLElement>('#toolbar')!, MenuId.EditorTitle, context);
