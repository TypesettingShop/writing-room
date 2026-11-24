import { Action2, MenuId, MenuRegistry, registerAction2, type IAction2Options } from '../../../../platform/actions/common/actions.js';
import { characterTypes } from '../../../../platform/characters/common/characters.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { moveAdjacent } from '../../../browser/navigator/navigatorDrag.js';
import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { WorkOpenContext } from '../../../services/work/common/work.js';
import './characterEditor.contribution.js';
import { ICharacterOpener } from './characterOpener.js';
import { characterTypeIcon } from './characterIcons.js';
import {
  CHARACTERS_HAS_SELECTED_CHARACTER, CHARACTERS_SELECTION_KIND, CHARACTERS_SELECTION_TYPE, CharactersNavigator,
} from './charactersNavigator.js';
import { ICharactersViewState, type CharactersViewState } from './charactersViewState.js';

export const CHARACTERS_CONTAINER_ID = 'workbench.view.characters';
export const CHARACTERS_NAVIGATOR_VIEW_ID = 'workbench.view.characters.navigator';

const workOpen = WorkOpenContext.isEqualTo(true);
const container = viewContainersRegistry.registerViewContainer({
  id: CHARACTERS_CONTAINER_ID, title: 'Characters', icon: '$(characters-group)', when: workOpen,
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

const selected = ContextKeyExpr.has(CHARACTERS_SELECTION_KIND);
const context = (order: number, when = selected) => ({ id: MenuId.CharactersNavigatorContext, group: 'navigation', order, when });

registerCharactersAction('moveUp', 'Move Up', { f1: true, menu: context(60) }, state => moveAdjacent(state, -1));
registerCharactersAction('moveDown', 'Move Down', { f1: true, menu: context(70) }, state => moveAdjacent(state, 1));

const inNavigator = ContextKeyExpr.equals('view', CHARACTERS_NAVIGATOR_VIEW_ID);
const toolbar = (order: number) => ({ id: MenuId.ViewTitle, group: 'navigation', order, when: inNavigator });
const hasFolder = ContextKeyExpr.equals(CHARACTERS_SELECTION_KIND, 'folder');
const hasCharacter = ContextKeyExpr.has(CHARACTERS_HAS_SELECTED_CHARACTER);

for (const [kind, title, command, icon, order] of [
  ['character', 'New Character', 'newCharacter', 'character-add', 10],
  ['folder', 'New Folder', 'newFolder', 'characters-group-add', 20],
] as const) {
  registerCharactersAction(command, title, { f1: true, icon: { id: icon }, menu: toolbar(order) }, async (state, accessor) => {
    if (await accessor.get(IViewsService).openView(CHARACTERS_NAVIGATOR_VIEW_ID)) {
      await state.ensureLoaded();
      await state.create(kind);
    }
  });
}

registerCharactersAction('refresh', 'Refresh', { f1: true, icon: { id: 'refresh' }, menu: toolbar(40) }, state => state.refresh());
registerCharactersAction('collapseAll', 'Collapse All', {
  f1: true, icon: { id: 'collapse-all' }, menu: toolbar(50),
}, async state => {
  await state.ensureLoaded();
  state.collapseAll();
});

registerCharactersAction('open', 'Open', { f1: true, menu: context(4, ContextKeyExpr.equals(CHARACTERS_SELECTION_KIND, 'character')) }, async (state, accessor) => {
  const opener = accessor.get(ICharacterOpener);
  await state.ensureLoaded();
  const node = state.singleSelection();
  if (node?.kind === 'character') {
    await opener.openCharacters([node.id]);
  }
});
registerCharactersAction('enterFolder', 'Enter Folder', { f1: true, menu: context(5, hasFolder) }, async state => {
  await state.ensureLoaded();
  const folder = state.singleSelection();
  if (folder?.kind === 'folder') {
    state.enter(folder.id);
  }
});
registerCharactersAction('openAllInFolder', 'Open All in Folder', { f1: true, menu: context(6, hasFolder) }, async (state, accessor) => {
  const opener = accessor.get(ICharacterOpener);
  await state.ensureLoaded();
  const folder = state.singleSelection();
  if (folder?.kind === 'folder') {
    await opener.openCharacters([folder.id]);
  }
});
registerCharactersAction('rename', 'Rename...', { f1: true, menu: context(30) }, async (state, accessor) => {
  const views = accessor.get(IViewsService);
  await state.ensureLoaded();
  const node = state.singleSelection();
  if (node && await views.openView(CHARACTERS_NAVIGATOR_VIEW_ID)) {
    state.startRename(node.id);
  }
});
registerCharactersAction('delete', 'Delete', { f1: true, menu: context(50) }, async state => {
  await state.ensureLoaded();
  await state.deleteSelected();
});

MenuRegistry.appendMenuItem(MenuId.CharactersNavigatorContext, {
  submenu: MenuId.CharactersSetType, title: 'Set Type', group: 'navigation', order: 40, when: hasCharacter, select: true,
});
for (const [order, type] of characterTypes.entries()) {
  const icon = characterTypeIcon(type);
  registerCharactersAction('setType' + icon.label, icon.label, {
    f1: true,
    icon,
    menu: { id: MenuId.CharactersSetType, group: 'navigation', order },
    toggled: ContextKeyExpr.equals(CHARACTERS_SELECTION_TYPE, type),
  }, async state => {
    await state.ensureLoaded();
    await state.setType(type);
  });
}
