import { Action2, MenuId, MenuRegistry, registerAction2, type IAction2Options } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { moveAdjacent } from '../../../browser/navigator/navigatorDrag.js';
import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { WorkOpenContext } from '../../../services/work/common/work.js';
import { WORLD_SELECTION_KIND, WorldCanCreateItem, WorldNavigator } from './worldNavigator.js';
import { openWorldItem } from './worldOpener.js';
import { IWorldViewState, type WorldViewState } from './worldViewState.js';

export const WORLD_CONTAINER_ID = 'workbench.view.world';
export const WORLD_NAVIGATOR_VIEW_ID = 'workbench.view.world.navigator';

const workOpen = WorkOpenContext.isEqualTo(true);
const container = viewContainersRegistry.registerViewContainer({
  id: WORLD_CONTAINER_ID, title: 'World', icon: '$(world)', when: workOpen,
}, ViewContainerLocation.Sidebar);
viewsRegistry.registerViews([{
  id: WORLD_NAVIGATOR_VIEW_ID,
  name: 'Navigator',
  when: workOpen,
  renderBody: (parent, instantiation) => instantiation?.createInstance(WorldNavigator, parent),
}], container);

export function registerWorldAction(
  id: string,
  title: string,
  options: Pick<IAction2Options, 'icon' | 'menu' | 'f1' | 'toggled'>,
  execute: (state: WorldViewState, accessor: ServicesAccessor) => unknown,
): void {
  registerAction2(class extends Action2 {
    constructor() {
      super({ id: 'world.' + id, title, category: 'World', precondition: workOpen, ...options });
    }

    override run(accessor: ServicesAccessor): unknown {
      const state = accessor.get(IWorldViewState);
      return state.workId ? execute(state, accessor) : undefined;
    }
  });
}

const inNavigator = ContextKeyExpr.equals('view', WORLD_NAVIGATOR_VIEW_ID);
const toolbar = (order: number) => ({ id: MenuId.ViewTitle, group: 'navigation', order, when: inNavigator });
registerWorldAction('refresh', 'Refresh', { f1: true, icon: { id: 'refresh' }, menu: toolbar(40) }, state => state.refresh());
registerWorldAction('collapseAll', 'Collapse All', {
  f1: true, icon: { id: 'collapse-all' }, menu: toolbar(50),
}, async state => {
  await state.ensureLoaded();
  state.collapseAll();
});

const itemIcon = { id: 'world-item-add' };
registerWorldAction('newCategory', 'New Category', {
  f1: true, icon: { id: 'world-category-add' }, menu: toolbar(10),
}, async (state, accessor) => {
  if (await accessor.get(IViewsService).openView(WORLD_NAVIGATOR_VIEW_ID)) {
    await state.ensureLoaded();
    await state.create('category');
  }
});
registerWorldAction('newItem', 'New Item', { f1: true, icon: itemIcon }, async (state, accessor) => {
  const views = accessor.get(IViewsService);
  const notifications = accessor.get(INotificationService);
  if (await views.openView(WORLD_NAVIGATOR_VIEW_ID)) {
    await state.ensureLoaded();
    if (state.creationParent('item') === undefined) {
      notifications.info('Select a category first.');
    } else {
      await state.create('item');
    }
  }
});
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
  ...toolbar(20),
  command: { id: 'world.newItem', title: 'New Item', icon: itemIcon, precondition: WorldCanCreateItem.isEqualTo(true) },
});

const selected = ContextKeyExpr.has(WORLD_SELECTION_KIND);
const itemSelected = ContextKeyExpr.equals(WORLD_SELECTION_KIND, 'item');
const categorySelected = ContextKeyExpr.equals(WORLD_SELECTION_KIND, 'category');
const context = (order: number, when = selected) => ({ id: MenuId.WorldNavigatorContext, group: 'navigation', order, when });

registerWorldAction('open', 'Open', { f1: true, menu: context(4, itemSelected) }, (state, accessor) => {
  const node = state.singleSelection();
  if (node?.kind === 'item') {
    return openWorldItem(accessor, node.id);
  }
});
registerWorldAction('enterCategory', 'Enter Category', { f1: true, menu: context(5, categorySelected) }, state => {
  const node = state.singleSelection();
  if (node?.kind === 'category') {
    state.enter(node.id);
  }
});
registerWorldAction('rename', 'Rename...', { f1: true, menu: context(30) }, async (state, accessor) => {
  const views = accessor.get(IViewsService);
  const node = state.singleSelection();
  if (node && await views.openView(WORLD_NAVIGATOR_VIEW_ID)) {
    state.startRename(node.id);
  }
});
registerWorldAction('delete', 'Delete', {
  f1: true, menu: context(50, ContextKeyExpr.or(itemSelected, categorySelected)),
}, state => state.deleteSelected());
registerWorldAction('moveUp', 'Move Up', { f1: true, menu: context(60) }, state => moveAdjacent(state, -1));
registerWorldAction('moveDown', 'Move Down', { f1: true, menu: context(70) }, state => moveAdjacent(state, 1));
