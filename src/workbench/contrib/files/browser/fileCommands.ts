import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommands.js';
import type { IEditorIdentifier } from '../../../common/editor.js';
import { IFileDialogService } from '../../../services/dialogs/common/dialogs.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';

export const SAVE_FILE_COMMAND_ID = 'workbench.action.files.save';
export const SAVE_FILE_AS_COMMAND_ID = 'workbench.action.files.saveAs';
export const SAVE_ALL_COMMAND_ID = 'saveAll';
export const REVERT_FILE_COMMAND_ID = 'workbench.action.files.revert';
export const NEW_FILE_COMMAND_ID = 'workbench.action.files.newFile';

/** The name a new file gets in the dialog when no name is given, as in VS Code. */
const DEFAULT_NEW_FILE_NAME = 'Untitled.txt';

/**
 * Saves the active editor, or the one a tab's context names, through the editor service: its input
 * saves, and when the save gives another editor (untitled text saved to a file) that one takes its
 * place. What a failed save tells the user is the input's business.
 */
registerAction2(class SaveFileAction extends Action2 {
  constructor() {
    super({
      id: SAVE_FILE_COMMAND_ID, title: 'Save', category: 'File', f1: true,
      keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyS, weight: KeybindingWeight.WorkbenchContrib },
    });
  }

  override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
    const resolved = resolveCommandsContext(accessor, context);
    if (resolved?.editor && !resolved.editor.isReadonly()) {
      await accessor.get(IEditorService).save({ groupId: resolved.group.id, editor: resolved.editor }, { reason: 'explicit' });
    }
  }
});

registerAction2(class SaveFileAsAction extends Action2 {
  constructor() {
    super({
      id: SAVE_FILE_AS_COMMAND_ID, title: 'Save As...', category: 'File', f1: true,
      keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS, weight: KeybindingWeight.WorkbenchContrib },
    });
  }

  override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
    const resolved = resolveCommandsContext(accessor, context);
    // Only text has somewhere else to go; the settings editor, say, saves in place.
    if (resolved?.editor?.resource && accessor.get(ITextFileService).canHandleResource(resolved.editor.resource)) {
      await accessor.get(IEditorService).save({ groupId: resolved.group.id, editor: resolved.editor }, { reason: 'explicit', saveAs: true });
    }
  }
});

/**
 * Saves every dirty editor that can be saved — not read-only ones — each once, files first, then
 * untitled text one at a time, each asking for its path. A cancelled path stops there, as in VS Code.
 * Files whose tab is gone but whose text is still dirty are saved too.
 */
registerAction2(class SaveAllAction extends Action2 {
  constructor() {
    super({
      id: SAVE_ALL_COMMAND_ID, title: 'Save All', category: 'File', f1: true,
      // VS Code: none on Linux; Ctrl+K S on Windows; Cmd+Alt+S on macOS.
      keybinding: {
        mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyS },
        win: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyS) },
        weight: KeybindingWeight.WorkbenchContrib,
      },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const editorService = accessor.get(IEditorService);
    const textFiles = accessor.get(ITextFileService);
    const files: IEditorIdentifier[] = [];
    const untitled: IEditorIdentifier[] = [];
    for (const group of accessor.get(IEditorGroupsService).groups) {
      for (const editor of group.editors) {
        if (!editor.isDirty() || editor.isReadonly() || [...files, ...untitled].some(other => other.editor.matches(editor))) {
          continue;
        }
        (editor.resource?.scheme === Schemas.untitled ? untitled : files).push({ groupId: group.id, editor });
      }
    }
    for (const editor of files) {
      await editorService.save(editor, { reason: 'explicit' });
    }
    const open = new Set(files.map(({ editor }) => editor.resource?.toString()));
    for (const model of textFiles.files.models) {
      if (model.isDirty() && !model.isReadonly() && !open.has(model.resource.toString())) {
        await model.save({ reason: 'explicit' });
      }
    }
    for (const editor of untitled) {
      if (!await editorService.save(editor, { reason: 'explicit' })) {
        return;
      }
    }
  }
});

/** Drops the unsaved changes of the active file editor, reading the file again. Untitled text has nothing to go back to. */
registerAction2(class RevertFileAction extends Action2 {
  constructor() {
    super({
      id: REVERT_FILE_COMMAND_ID, title: 'Revert File', category: 'File', f1: true,
      precondition: ContextKeyExpr.and(ContextKeyExpr.has('activeEditor'), ContextKeyExpr.notEquals('resourceScheme', Schemas.untitled)),
    });
  }

  override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
    const resolved = resolveCommandsContext(accessor, context);
    const editor = resolved?.editor;
    if (resolved && editor?.resource && editor.resource.scheme !== Schemas.untitled && !editor.isReadonly()) {
      await editor.revert(resolved.group.id);
    }
  }
});

/**
 * Asks for a path in the workspace with the save dialog, creates an empty file there (the dialog has
 * asked before replacing one) and opens it, as VS Code's `workbench.action.files.newFile` does.
 */
registerAction2(class NewFileAction extends Action2 {
  constructor() {
    super({
      id: NEW_FILE_COMMAND_ID, title: 'New File...', category: 'File', f1: true,
      // The binding of VS Code's File > New File...: Ctrl+Alt+Super+N, Cmd+Alt+Ctrl+N on macOS.
      keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.WinCtrl | KeyCode.KeyN, weight: KeybindingWeight.WorkbenchContrib },
    });
  }

  override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
    const dialogs = accessor.get(IFileDialogService);
    const fileService = accessor.get(IFileService);
    const editorService = accessor.get(IEditorService);
    const folder = dialogs.defaultFilePath();
    if (!folder) {
      return;
    }
    const requested = typeof args === 'object' && args !== null ? (args as { fileName?: unknown }).fileName : undefined;
    const fileName = typeof requested === 'string' && requested && !/[/\\]/.test(requested) ? requested : DEFAULT_NEW_FILE_NAME;
    const target = await dialogs.showSaveDialog({ title: 'Create File', saveLabel: 'Create File', defaultUri: joinPath(folder, fileName) });
    if (!target) {
      return;
    }
    try {
      await fileService.createFile(target, undefined, { overwrite: true });
    } catch (error) {
      // Told as a failed save is: the storage may be full.
      accessor.get(ITextFileService).files.saveErrorHandler.onSaveError(error, { resource: target });
      return;
    }
    await editorService.openEditor({ resource: target });
  }
});
