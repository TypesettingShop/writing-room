import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { isEditorCommandsContext } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';

export const CLOSE_EDITOR_COMMAND_ID = 'workbench.action.closeActiveEditor';
export const CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID = 'workbench.action.closeOtherEditors';
export const CLOSE_EDITORS_IN_GROUP_COMMAND_ID = 'workbench.action.closeEditorsInGroup';

export const SPLIT_EDITOR = 'workbench.action.splitEditor';
export const SPLIT_EDITOR_UP = 'workbench.action.splitEditorUp';
export const SPLIT_EDITOR_DOWN = 'workbench.action.splitEditorDown';
export const SPLIT_EDITOR_LEFT = 'workbench.action.splitEditorLeft';
export const SPLIT_EDITOR_RIGHT = 'workbench.action.splitEditorRight';

export interface IResolvedEditorCommandsContext {
  readonly group: IEditorGroup;
  readonly editor: EditorInput | undefined;
}

/**
 * The group and editor a command works on. A command run from a tab or a group's title gets an
 * `IEditorCommandsContext` naming them; one run from a key, a menu bar or the palette gets nothing
 * and works on the active group and its active editor.
 */
export function resolveCommandsContext(accessor: ServicesAccessor, arg: unknown): IResolvedEditorCommandsContext {
  const groups = accessor.get(IEditorGroupsService);
  if (isEditorCommandsContext(arg)) {
    const group = groups.getGroup(arg.groupId) ?? groups.activeGroup;
    const editor = arg.editorIndex === undefined ? group.activeEditor : group.getEditorByIndex(arg.editorIndex);
    return { group, editor: editor ?? undefined };
  }
  const group = groups.activeGroup;
  return { group, editor: group.activeEditor ?? undefined };
}

registerAction2(class CloseEditorAction extends Action2 {
  constructor() {
    super({
      id: CLOSE_EDITOR_COMMAND_ID,
      title: 'Close Editor',
      category: 'View',
      f1: true,
      // Ctrl+W belongs to the browser in an ordinary tab; the binding is declared as VS Code does.
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyCode.KeyW,
        win: { primary: KeyMod.CtrlCmd | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyCode.KeyW] },
      },
    });
  }

  override run(accessor: ServicesAccessor, context?: unknown): void {
    const { group, editor } = resolveCommandsContext(accessor, context);
    if (editor) {
      // A background tab closes without being activated first.
      group.closeEditor(editor);
    }
  }
});

registerAction2(class CloseOtherEditorsInGroupAction extends Action2 {
  constructor() {
    super({
      id: CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID,
      title: 'Close Other Editors in Group',
      category: 'View',
      f1: true,
      keybinding: { weight: KeybindingWeight.WorkbenchContrib, mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyT } },
    });
  }

  override run(accessor: ServicesAccessor, context?: unknown): void {
    const { group, editor } = resolveCommandsContext(accessor, context);
    if (editor) {
      // The kept editor is the only one left, so the group shows it once the others are gone.
      group.closeEditors({ except: editor });
    }
  }
});

registerAction2(class CloseEditorsInGroupAction extends Action2 {
  constructor() {
    super({
      id: CLOSE_EDITORS_IN_GROUP_COMMAND_ID,
      title: 'Close All Editors in Group',
      category: 'View',
      f1: true,
      keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyW) },
    });
  }

  override run(accessor: ServicesAccessor, context?: unknown): void {
    resolveCommandsContext(accessor, context).group.closeAllEditors();
  }
});

// A tab's context menu, run with the tab's group and index.
MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, {
  command: { id: CLOSE_EDITOR_COMMAND_ID, title: 'Close' }, group: '1_close', order: 10,
});
MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, {
  command: { id: CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID, title: 'Close Others' }, group: '1_close', order: 20,
});
MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, {
  command: { id: CLOSE_EDITORS_IN_GROUP_COMMAND_ID, title: 'Close All' }, group: '1_close', order: 50,
});
