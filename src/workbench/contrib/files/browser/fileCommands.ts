import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommands.js';

export const SAVE_FILE_COMMAND_ID = 'workbench.action.files.save';

/**
 * Saves the active editor, or the one a tab's context names, through its input's `save`. What a
 * save means, and what a failed one tells the user, is the input's business. The file editing
 * member adds its commands to this file.
 */
registerAction2(class SaveFileAction extends Action2 {
  constructor() {
    super({
      id: SAVE_FILE_COMMAND_ID, title: 'Save', f1: true,
      keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyS, weight: KeybindingWeight.WorkbenchContrib },
    });
  }

  override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
    const resolved = resolveCommandsContext(accessor, context);
    if (resolved?.editor && !resolved.editor.isReadonly()) {
      await resolved.editor.save(resolved.group.id, { reason: 'explicit' });
    }
  }
});
