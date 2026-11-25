import { Disposable } from '../../../../base/common/lifecycle.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor, type IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import type { IEditorFactoryRegistry } from '../../../common/editor.js';
import { ErrorEditorInput } from '../../../common/editor/errorEditorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IWorldService } from '../../../services/world/common/worldService.js';
import { registerWorldAction } from './world.contribution.js';
import { WorldCategoryEditorInput, worldCategoryScheme } from './worldCategoryEditorInput.js';
import { WorldCategoryEditorPane } from './worldCategoryEditorPane.js';
import { WorldCategoryEditorSerializer } from './worldCategoryEditorSerializer.js';
import { IWorldCategoryEditors, type WorldCategoryEditors } from './worldCategoryEditors.js';
import { WORLD_SELECTION_KIND } from './worldNavigator.js';
import { IWorldViewState, type WorldViewState } from './worldViewState.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(WorldCategoryEditorPane, WorldCategoryEditorPane.ID, 'Category Fields'), [WorldCategoryEditorInput.ID],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!
  .registerEditorSerializer(WorldCategoryEditorInput.ID, WorldCategoryEditorSerializer);

registerWorldAction('editCategoryFields', 'Edit Category Fields', {
  f1: true,
  menu: {
    id: MenuId.WorldNavigatorContext, group: 'navigation', order: 12,
    when: ContextKeyExpr.equals(WORLD_SELECTION_KIND, 'category'),
  },
}, async (state, accessor) => {
  const editors = accessor.get(IWorldCategoryEditors);
  await state.ensureLoaded();
  const selected = state.singleSelection();
  const id = selected?.kind === 'category' ? selected.id : selected?.kind === 'item' ? selected.parentId : undefined;
  if (id) {
    await editors.open(id);
  }
});

class WorldCategoryContribution extends Disposable {
  constructor(
    @IEditorResolverService resolver: IEditorResolverService,
    @IWorldService world: IWorldService,
    @IWorldViewState state: WorldViewState,
    @IWorldCategoryEditors editors: WorldCategoryEditors,
  ) {
    super();
    this._register(resolver.registerEditor(
      '*',
      { id: WorldCategoryEditorInput.ID, label: 'Category Fields', priority: RegisteredEditorPriority.exclusive },
      { canSupportResource: resource => resource.scheme === worldCategoryScheme },
      async ({ resource, options }) => {
        await state.ensureLoaded();
        return {
          editor: editors.getInput(resource) ?? new ErrorEditorInput(resource, 'This category is unavailable in the current work.'),
          options,
        };
      },
    ));
    this._register(world.onDidDeleteNodes(({ workId, nodeIds }) => editors.closeDeleted(workId, nodeIds)));
  }
}

registerWorkbenchContribution2('workbench.world.categoryFields', WorldCategoryContribution);
