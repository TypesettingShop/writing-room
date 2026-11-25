import { Action2, MenuId, registerAction2, type IAction2Options } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import { WorkOpenContext } from '../../../services/work/common/work.js';
import { WorldNavigator } from './worldNavigator.js';
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
