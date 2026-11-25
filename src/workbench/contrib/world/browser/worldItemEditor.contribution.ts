import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor, type IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ErrorEditorInput } from '../../../common/editor/errorEditorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IWorldService } from '../../../services/world/common/worldService.js';
import { WorldItemEditorInput, worldItemScheme } from './worldItemEditorInput.js';
import { WorldItemEditorPane } from './worldItemEditorPane.js';
import { IWorldOpener, type WorldOpener } from './worldOpener.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(WorldItemEditorPane, WorldItemEditorPane.ID, 'Item Card'), [WorldItemEditorInput.ID],
);

class WorldItemEditorContribution extends Disposable {
  constructor(
    @IEditorResolverService resolver: IEditorResolverService,
    @IWorldService world: IWorldService,
    @IWorldOpener opener: WorldOpener,
  ) {
    super();
    this._register(resolver.registerEditor(
      '*',
      { id: WorldItemEditorInput.ID, label: 'Item Card', priority: RegisteredEditorPriority.exclusive },
      { canSupportResource: resource => resource.scheme === worldItemScheme },
      async ({ resource, options }) => ({
        editor: await opener.resolveInput(resource) ?? new ErrorEditorInput(resource, 'This item is unavailable in the current work.'),
        options,
      }),
    ));
    this._register(world.onDidDeleteNodes(({ workId, nodeIds }) => opener.closeDeleted(workId, nodeIds)));
  }
}

registerWorkbenchContribution2('workbench.world.itemEditor', WorldItemEditorContribution);
