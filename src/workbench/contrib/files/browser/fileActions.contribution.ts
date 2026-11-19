import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Schemas } from '../../../../base/common/network.js';
import {
  NEW_FILE_COMMAND_ID, REVERT_FILE_COMMAND_ID, SAVE_ALL_COMMAND_ID, SAVE_FILE_AS_COMMAND_ID, SAVE_FILE_COMMAND_ID,
} from './fileCommands.js';

// The File menu, in VS Code's groups and order: New Text File (the editor part's) and New File...,
// then the saves, then Revert File before Close Editor.
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
  command: { id: NEW_FILE_COMMAND_ID, title: 'New File...' }, group: '1_new', order: 2,
});
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
  command: { id: SAVE_FILE_COMMAND_ID, title: 'Save' }, group: '4_save', order: 1,
});
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
  command: { id: SAVE_FILE_AS_COMMAND_ID, title: 'Save As...' }, group: '4_save', order: 2,
});
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
  command: { id: SAVE_ALL_COMMAND_ID, title: 'Save All' }, group: '4_save', order: 3,
});
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
  command: {
    id: REVERT_FILE_COMMAND_ID, title: 'Revert File',
    precondition: ContextKeyExpr.and(ContextKeyExpr.has('activeEditor'), ContextKeyExpr.notEquals('resourceScheme', Schemas.untitled)),
  },
  group: '6_close', order: 1,
});
