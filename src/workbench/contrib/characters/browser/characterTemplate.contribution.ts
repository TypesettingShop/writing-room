import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor, type IEditorPaneRegistry } from '../../../browser/editor.js';
import type { IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkService, WorkOpenContext } from '../../../services/work/common/work.js';
import {
  CharacterTemplateEditorInput, CharacterTemplateEditorSerializer, ICharacterTemplateInputService,
} from './characterTemplateEditorInput.js';
import { CharacterTemplateEditorPane } from './characterTemplateEditorPane.js';
import { CHARACTERS_NAVIGATOR_VIEW_ID } from './characters.contribution.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(CharacterTemplateEditorPane, CharacterTemplateEditorPane.ID, 'Field Template'),
  [CharacterTemplateEditorInput.ID],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!
  .registerEditorSerializer(CharacterTemplateEditorInput.ID, CharacterTemplateEditorSerializer);

registerAction2(class EditFieldTemplate extends Action2 {
  constructor() {
    super({
      id: 'characters.editFieldTemplate',
      title: 'Edit Field Template',
      category: 'Characters',
      f1: true,
      precondition: WorkOpenContext.isEqualTo(true),
      icon: { id: 'settings-gear' },
      menu: {
        id: MenuId.ViewTitle, group: 'navigation', order: 30,
        when: ContextKeyExpr.equals('view', CHARACTERS_NAVIGATOR_VIEW_ID),
      },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const work = accessor.get(IWorkService).current;
    if (!work) {
      return;
    }
    const input = accessor.get(ICharacterTemplateInputService).getOrCreate(work.id);
    const { activeGroup, groups } = accessor.get(IEditorGroupsService);
    const group = activeGroup.contains(input) ? activeGroup : groups.find(candidate => candidate.contains(input));
    await accessor.get(IEditorService).openEditor(input, undefined, group);
  }
});
