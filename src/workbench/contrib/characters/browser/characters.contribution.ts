import { Action2, registerAction2, type IAction2Options } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import { WorkOpenContext } from '../../../services/work/common/work.js';
import { CharactersNavigator } from './charactersNavigator.js';
import { ICharactersViewState, type CharactersViewState } from './charactersViewState.js';

export const CHARACTERS_CONTAINER_ID = 'workbench.view.characters';
export const CHARACTERS_NAVIGATOR_VIEW_ID = 'workbench.view.characters.navigator';

const workOpen = WorkOpenContext.isEqualTo(true);
const container = viewContainersRegistry.registerViewContainer({
  id: CHARACTERS_CONTAINER_ID, title: 'Characters', icon: '$(person)', when: workOpen,
}, ViewContainerLocation.Sidebar);
viewsRegistry.registerViews([{
  id: CHARACTERS_NAVIGATOR_VIEW_ID,
  name: 'Navigator',
  when: workOpen,
  renderBody: (parent, instantiation) => instantiation?.createInstance(CharactersNavigator, parent),
}], container);

export function registerCharactersAction(
  id: string,
  title: string,
  options: Pick<IAction2Options, 'icon' | 'menu' | 'f1' | 'toggled'>,
  execute: (state: CharactersViewState, accessor: ServicesAccessor) => unknown,
): void {
  registerAction2(class extends Action2 {
    constructor() {
      super({ id: 'characters.' + id, title, category: 'Characters', precondition: workOpen, ...options });
    }

    override run(accessor: ServicesAccessor): unknown {
      const state = accessor.get(ICharactersViewState);
      return state.workId ? execute(state, accessor) : undefined;
    }
  });
}
