import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { GroupDirection, GroupLocation, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { UntitledTextEditorInput } from '../../../services/untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import {
  CLOSE_EDITOR_COMMAND_ID, resolveCommandsContext, SPLIT_EDITOR, SPLIT_EDITOR_DOWN, SPLIT_EDITOR_LEFT, SPLIT_EDITOR_RIGHT, SPLIT_EDITOR_UP,
} from './editorCommands.js';

export const NEW_UNTITLED_FILE_COMMAND_ID = 'workbench.action.files.newUntitledFile';
export const CLOSE_ALL_EDITORS_COMMAND_ID = 'workbench.action.closeAllEditors';
export const JOIN_ALL_GROUPS_COMMAND_ID = 'workbench.action.joinAllGroups';
export const FOCUS_NEXT_GROUP_COMMAND_ID = 'workbench.action.focusNextGroup';
export const MOVE_EDITOR_TO_NEXT_GROUP_COMMAND_ID = 'workbench.action.moveEditorToNextGroup';

/**
 * Adds a group beside the context's group in `direction` and opens the context's editor there too,
 * the same input from the same view state, as VS Code's split does. An empty group splits into
 * another empty group.
 */
function splitEditor(accessor: ServicesAccessor, direction: GroupDirection, context: unknown): void {
  const groups = accessor.get(IEditorGroupsService);
  const { group, editor } = resolveCommandsContext(accessor, context);
  const newGroup = groups.addGroup(group, direction);
  if (editor) {
    group.copyEditor(editor, newGroup);
  } else {
    groups.activateGroup(newGroup);
    newGroup.focus();
  }
}

for (const [id, title, menuTitle, direction, order, keybinding] of [
  [SPLIT_EDITOR, 'Split Editor', undefined, GroupDirection.RIGHT, undefined, KeyMod.CtrlCmd | KeyCode.Backslash],
  [SPLIT_EDITOR_UP, 'Split Editor Up', 'Split Up', GroupDirection.UP, 1, undefined],
  [SPLIT_EDITOR_DOWN, 'Split Editor Down', 'Split Down', GroupDirection.DOWN, 2, undefined],
  [SPLIT_EDITOR_LEFT, 'Split Editor Left', 'Split Left', GroupDirection.LEFT, 3, undefined],
  [SPLIT_EDITOR_RIGHT, 'Split Editor Right', 'Split Right', GroupDirection.RIGHT, 4, undefined],
] as const) {
  registerAction2(class extends Action2 {
    constructor() {
      super({
        id, title, category: 'View', f1: true,
        keybinding: keybinding === undefined ? undefined : { weight: KeybindingWeight.WorkbenchContrib, primary: keybinding },
      });
    }

    override run(accessor: ServicesAccessor, context?: unknown): void {
      splitEditor(accessor, direction, context);
    }
  });
  if (menuTitle !== undefined) {
    MenuRegistry.appendMenuItem(MenuId.MenubarLayoutMenu, { command: { id, title: menuTitle }, group: '1_split', order });
    MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, { command: { id, title: menuTitle }, group: '5_split', order });
  }
}

// Each group's title: split the group's editor to the right.
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
  command: { id: SPLIT_EDITOR, title: 'Split Editor Right', icon: { id: 'split-horizontal' } }, group: 'navigation', order: 100000,
});

registerAction2(class JoinAllGroupsAction extends Action2 {
  constructor() {
    super({ id: JOIN_ALL_GROUPS_COMMAND_ID, title: 'Join All Editor Groups', category: 'View', f1: true });
  }

  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService);
    groups.mergeAllGroups(groups.activeGroup);
  }
});
MenuRegistry.appendMenuItem(MenuId.MenubarLayoutMenu, {
  command: { id: JOIN_ALL_GROUPS_COMMAND_ID, title: 'Join All Editor Groups' }, group: '3_join', order: 1,
});

registerAction2(class FocusNextGroupAction extends Action2 {
  constructor() {
    super({ id: FOCUS_NEXT_GROUP_COMMAND_ID, title: 'Focus Next Editor Group', category: 'View', f1: true });
  }

  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService);
    const next = groups.findGroup({ location: GroupLocation.NEXT }, groups.activeGroup, true);
    if (next) {
      groups.activateGroup(next);
      next.focus();
    }
  }
});

registerAction2(class MoveEditorToNextGroupAction extends Action2 {
  constructor() {
    super({ id: MOVE_EDITOR_TO_NEXT_GROUP_COMMAND_ID, title: 'Move Editor into Next Group', category: 'View', f1: true });
  }

  override run(accessor: ServicesAccessor, context?: unknown): void {
    const groups = accessor.get(IEditorGroupsService);
    const { group, editor } = resolveCommandsContext(accessor, context);
    if (!editor) {
      return;
    }
    // The last group moves its editor into a new group to its right, as in VS Code.
    const target = groups.findGroup({ location: GroupLocation.NEXT }, group) ?? groups.addGroup(group, GroupDirection.RIGHT);
    group.moveEditor(editor, target);
  }
});

registerAction2(class CloseAllEditorsAction extends Action2 {
  constructor() {
    super({
      id: CLOSE_ALL_EDITORS_COMMAND_ID, title: 'Close All Editors', category: 'View', f1: true,
      keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyW) },
    });
  }

  override run(accessor: ServicesAccessor): void {
    // Closing a group's last editor removes the group, so walk a copy of the list.
    for (const group of [...accessor.get(IEditorGroupsService).groups]) {
      group.closeAllEditors();
    }
  }
});

registerAction2(class NewUntitledFileAction extends Action2 {
  constructor() {
    super({
      id: NEW_UNTITLED_FILE_COMMAND_ID, title: 'New Untitled Text File', category: 'File', f1: true,
      // VS Code's web binding: Ctrl+N belongs to the browser.
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyN,
        win: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyN) },
      },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const editorService = accessor.get(IEditorService);
    const model = accessor.get(IUntitledTextEditorService).create();
    await editorService.openEditor(new UntitledTextEditorInput(model));
  }
});
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
  command: { id: NEW_UNTITLED_FILE_COMMAND_ID, title: 'New Text File' }, group: '1_new', order: 1,
});
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
  command: { id: CLOSE_EDITOR_COMMAND_ID, title: 'Close Editor' }, group: '6_close', order: 2,
});
