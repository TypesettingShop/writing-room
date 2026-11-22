import { Action2, MenuId, registerAction2, type IAction2Options } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { WorkOpenContext } from '../../../services/work/common/work.js';
import './manuscriptLabels.js';
import { IManuscriptOpener } from './manuscriptOpener.js';
import { IManuscriptViewState, type ManuscriptViewState } from './manuscriptViewState.js';
import { NavigatorView } from './navigatorView.js';

export const MANUSCRIPT_CONTAINER_ID = 'workbench.view.manuscript';
export const NAVIGATOR_VIEW_ID = 'workbench.view.manuscript.navigator';
export const MANUSCRIPT_SELECTION_KIND = 'manuscriptSelectionKind';

const workOpen = WorkOpenContext.isEqualTo(true);
const container = viewContainersRegistry.registerViewContainer({
  id: MANUSCRIPT_CONTAINER_ID, title: 'Manuscript', icon: '$(book)', defaultActive: true,
}, ViewContainerLocation.Sidebar);
viewsRegistry.registerViews([{
  id: NAVIGATOR_VIEW_ID,
  name: 'Navigator',
  when: workOpen,
  renderBody: (parent, instantiation) => instantiation?.createInstance(NavigatorView, parent),
}], container);

const folder = ContextKeyExpr.or(
  ContextKeyExpr.equals(MANUSCRIPT_SELECTION_KIND, 'part'),
  ContextKeyExpr.equals(MANUSCRIPT_SELECTION_KIND, 'chapter'),
);
const selected = ContextKeyExpr.has(MANUSCRIPT_SELECTION_KIND);
const inNavigator = ContextKeyExpr.equals('view', NAVIGATOR_VIEW_ID);
const toolbar = (order: number) => ({ id: MenuId.ViewTitle, group: 'navigation', order, when: inNavigator });
const context = (order: number, when = selected) => ({ id: MenuId.ManuscriptNavigatorContext, group: 'navigation', order, when });

export function registerManuscriptAction(
  id: string,
  title: string,
  options: Pick<IAction2Options, 'icon' | 'menu' | 'f1'>,
  execute: (state: ManuscriptViewState, accessor: ServicesAccessor) => unknown,
): void {
  registerAction2(class extends Action2 {
    constructor() {
      super({ id: 'manuscript.' + id, title, category: 'Manuscript', precondition: workOpen, ...options });
    }

    override run(accessor: ServicesAccessor): unknown {
      const state = accessor.get(IManuscriptViewState);
      if (state.workId) {
        return execute(state, accessor);
      }
      return undefined;
    }
  });
}

for (const [kind, title, icon, order] of [
  ['part', 'New Part', 'new-folder', 10],
  ['chapter', 'New Chapter', 'folder', 20],
  ['document', 'New Document', 'new-file', 30],
] as const) {
  const menu = [toolbar(order)];
  if (kind === 'chapter') {
    menu.push(context(order, ContextKeyExpr.equals(MANUSCRIPT_SELECTION_KIND, 'part')));
  } else if (kind === 'document') {
    menu.push(context(order, folder));
  }
  registerManuscriptAction('new' + title.replace('New ', ''), title, { f1: true, icon: { id: icon }, menu }, async (state, accessor) => {
    const view = await accessor.get(IViewsService).openView(NAVIGATOR_VIEW_ID);
    if (view) {
      await state.ensureLoaded();
      await state.create(kind);
    }
  });
}

registerManuscriptAction('refresh', 'Refresh', { f1: true, icon: { id: 'refresh' }, menu: toolbar(40) }, state => state.refresh());
registerManuscriptAction('collapseAll', 'Collapse All', { f1: true, icon: { id: 'collapse-all' }, menu: toolbar(50) }, state => state.collapseAll());
registerManuscriptAction('enterFolder', 'Enter Folder', { menu: context(5, folder) }, state => {
  const selection = state.singleSelection();
  if (selection) {
    state.enter(selection.id);
  }
});
registerManuscriptAction('rename', 'Rename...', { menu: context(40) }, state => {
  const selection = state.singleSelection();
  if (selection) {
    state.startRename(selection.id);
  }
});
registerManuscriptAction('delete', 'Delete', { menu: context(50) }, state => state.deleteSelected());

registerManuscriptAction('openAllDocuments', 'Open All Documents', { menu: context(6, folder) }, (state, accessor) => {
  const selection = state.singleSelection();
  if (selection && selection.kind !== 'document') {
    return accessor.get(IManuscriptOpener).openDocuments([selection.id]);
  }
  return undefined;
});
