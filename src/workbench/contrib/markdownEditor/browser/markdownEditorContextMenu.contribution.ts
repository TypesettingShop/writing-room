import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { MarkdownEditorFocusContext } from '../common/markdownEditor.js';
import { MARKDOWN_SELECT_ALL_COMMAND, markdownClipboardCommands } from './markdownEditorContextMenu.js';
import { MarkdownEditorPane } from './markdownEditorPane.js';

for (const { id, label, operation } of markdownClipboardCommands) {
  registerAction2(class extends Action2 {
    constructor() {
      super({ id, title: label });
    }

    override run(accessor: ServicesAccessor): Promise<void> | undefined {
      const pane = accessor.get(IEditorGroupsService).activeGroup.activeEditorPane;
      const notifications = accessor.get(INotificationService);
      if (pane instanceof MarkdownEditorPane) {
        return pane.runClipboardCommand(operation, message => notifications.warn(message));
      }
    }
  });
}

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: MARKDOWN_SELECT_ALL_COMMAND, title: 'Select All',
      keybinding: {
        primary: KeyMod.CtrlCmd | KeyCode.KeyA,
        weight: KeybindingWeight.WorkbenchContrib,
        when: MarkdownEditorFocusContext.isEqualTo(true),
      },
    });
  }

  override run(accessor: ServicesAccessor): void {
    const pane = accessor.get(IEditorGroupsService).activeGroup.activeEditorPane;
    if (pane instanceof MarkdownEditorPane) pane.selectAll();
  }
});
