import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor, type IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import type { IEditorFactoryRegistry } from '../../../common/editor.js';
import { ErrorEditorInput } from '../../../common/editor/errorEditorInput.js';
import { ICharactersService } from '../../../services/characters/common/charactersService.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { CharacterEditorInput, characterScheme } from './characterEditorInput.js';
import { CharacterEditorPane } from './characterEditorPane.js';
import { CharacterEditorInputSerializer } from './characterEditorSerializer.js';
import { ICharacterOpener, type CharacterOpener } from './characterOpener.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(CharacterEditorPane, CharacterEditorPane.ID, 'Character Card'), [CharacterEditorInput.ID],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!
  .registerEditorSerializer(CharacterEditorInput.ID, CharacterEditorInputSerializer);

class CharacterEditorContribution extends Disposable {
  constructor(
    @IEditorResolverService resolver: IEditorResolverService,
    @ICharactersService characters: ICharactersService,
    @ICharacterOpener opener: CharacterOpener,
  ) {
    super();
    this._register(resolver.registerEditor(
      '*',
      { id: CharacterEditorInput.ID, label: 'Character Card', priority: RegisteredEditorPriority.exclusive },
      { canSupportResource: resource => resource.scheme === characterScheme },
      async ({ resource, options }) => ({
        editor: await opener.resolveInput(resource) ?? new ErrorEditorInput(resource, 'This character is unavailable in the current work.'),
        options,
      }),
    ));
    this._register(characters.onDidDeleteCharacters(({ workId, nodeIds }) => opener.closeDeleted(workId, nodeIds)));
  }
}

registerWorkbenchContribution2('workbench.characters.editor', CharacterEditorContribution);
