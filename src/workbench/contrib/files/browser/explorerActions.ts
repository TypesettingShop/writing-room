import { basename, dirname, isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, MenuCommandContext, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { validateFileName } from '../../../services/dialogs/common/dialogPaths.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import type { IEditorReplacement } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorResolverService } from '../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import type { ExplorerItem } from '../common/explorerModel.js';
import { describeFileError as describeError, IExplorerService } from './explorerService.js';
import {
  BrowserFileUpload, chooseFilesToUpload, DOWNLOAD_COMMAND_ID, DOWNLOAD_LABEL, fileEntry, FileDownload, UPLOAD_COMMAND_ID,
  UPLOAD_LABEL,
} from './fileImportExport.js';
import { ExplorerFolderContext, ExplorerRootContext } from './views/explorerView.js';

export const EXPLORER_VIEWLET_ID = 'workbench.view.explorer';
export const EXPLORER_VIEW_ID = 'workbench.explorer.fileView';

export const NEW_FILE_COMMAND_ID = 'explorer.newFile';
export const NEW_FOLDER_COMMAND_ID = 'explorer.newFolder';
export const RENAME_FILE_COMMAND_ID = 'renameFile';
export const DELETE_FILE_COMMAND_ID = 'deleteFile';
export const REFRESH_EXPLORER_COMMAND_ID = 'workbench.files.action.refreshFilesExplorer';
export const COLLAPSE_EXPLORER_COMMAND_ID = 'workbench.files.action.collapseExplorerFolders';
export const REVEAL_IN_EXPLORER_COMMAND_ID = 'revealInExplorer';

/**
 * Why `name` cannot be a new entry of `folder` (or the new name of `current`, one of its entries):
 * the rules of every file name here, and no other entry of the same name in the folder.
 */
export function validateExplorerName(name: string, folder: ExplorerItem, current?: ExplorerItem): string | undefined {
  const invalid = validateFileName(name);
  if (invalid) {
    return invalid;
  }
  const existing = folder.getChild(name);
  if (existing && existing !== current) {
    return `A file or folder ${name} already exists at this location. Please choose a different name.`;
  }
  return undefined;
}

/**
 * The resource a command is for: the URI it is given (the context menu gives its item's, an
 * extension or another command may give one, after a menu context), else the Explorer's selection.
 */
function commandResource(args: readonly unknown[]): URI | undefined {
  const [first, second] = args;
  const target = first instanceof MenuCommandContext ? second : first;
  if (URI.isUri(target)) {
    return target;
  }
  if (target && typeof target === 'object' && 'resource' in target && URI.isUri(target.resource)) {
    return target.resource;
  }
  return undefined;
}

interface IExplorerServices {
  readonly explorer: IExplorerService;
  readonly views: IViewsService;
}

function explorerServices(accessor: ServicesAccessor): IExplorerServices {
  return { explorer: accessor.get(IExplorerService), views: accessor.get(IViewsService) };
}

/** Opens the Explorer view, wherever its container is, and gives the item of `resource` once it is read. */
async function revealItem({ explorer, views }: IExplorerServices, resource: URI | undefined): Promise<ExplorerItem | undefined> {
  await views.openView(EXPLORER_VIEW_ID);
  const target = resource ?? explorer.selection?.resource ?? explorer.root.resource;
  if (target.toString() === explorer.root.resource.toString()) {
    await explorer.setExpanded(explorer.root, true);
    return explorer.root;
  }
  return await explorer.select(target) ? explorer.find(target) : undefined;
}

/** Shows the inline input for a new file or folder in the folder of `resource` (or of the selection). */
async function startNewEntry(accessor: ServicesAccessor, isDirectory: boolean, args: readonly unknown[]): Promise<void> {
  const services = explorerServices(accessor);
  const fileService = accessor.get(IFileService);
  const editorService = accessor.get(IEditorService);
  const { explorer } = services;
  const target = await revealItem(services, commandResource(args));
  const folder = !target ? explorer.root : target.isDirectory ? target : target.parent ?? explorer.root;
  await explorer.setExpanded(folder, true);
  explorer.setEditable({
    kind: isDirectory ? 'newFolder' : 'newFile',
    item: folder,
    validate: value => validateExplorerName(value, folder),
    onFinish: (value, committed) => {
      if (committed) {
        void create(value).catch(console.error);
      }
    },
  });

  async function create(name: string): Promise<void> {
    const resource = joinPath(folder.resource, name);
    try {
      await (isDirectory ? fileService.createFolder(resource) : fileService.createFile(resource));
    } catch (error) {
      console.warn(`Failed to create ${resource}.`, error);
      explorer.showError(`Unable to create '${name}': ${describeError(error)}`);
      explorer.focusView();
      return;
    }
    await explorer.resolveFolder(folder);
    await explorer.select(resource, { focus: isDirectory });
    if (!isDirectory) {
      await editorService.openEditor({ resource });
    }
  }
}

/** What renaming and deleting use, taken while the command's accessor is valid. */
interface IOperationServices {
  readonly explorer: IExplorerService;
  readonly fileService: IFileService;
  readonly textFiles: ITextFileService;
  readonly quickInput: IQuickInputService;
  readonly groups: IEditorGroupsService;
  readonly resolver: IEditorResolverService;
}

function operationServices(accessor: ServicesAccessor): IOperationServices {
  return {
    explorer: accessor.get(IExplorerService),
    fileService: accessor.get(IFileService),
    textFiles: accessor.get(ITextFileService),
    quickInput: accessor.get(IQuickInputService),
    groups: accessor.get(IEditorGroupsService),
    resolver: accessor.get(IEditorResolverService),
  };
}

/**
 * Renames `item` to `name` in its folder. Dirty text below it is saved first, if the user agrees;
 * editors that showed the old paths show the new ones, in the same group and place.
 */
async function rename(services: IOperationServices, item: ExplorerItem, name: string): Promise<void> {
  const { explorer, fileService, textFiles, quickInput, groups, resolver } = services;
  const source = item.resource;
  const target = joinPath(dirname(source), name);
  const parent = item.parent;

  const dirty = textFiles.files.models.filter(model => isEqualOrParent(model.resource, source) && model.isDirty());
  if (dirty.length) {
    const title = dirty.length === 1
      ? `'${basename(dirty[0].resource)}' has unsaved changes. Save them before renaming '${item.name}'?`
      : `${dirty.length} files have unsaved changes. Save them before renaming '${item.name}'?`;
    const choice = await quickInput.pick([
      { id: 'save', label: 'Save and Rename', detail: 'Save the changes, then rename.' },
      { id: 'cancel', label: 'Cancel', detail: 'Keep the name and the unsaved changes.' },
    ], { title });
    if (choice?.id !== 'save') {
      explorer.focusView();
      return;
    }
    for (const model of dirty) {
      // A failed save has told the user why; the name stays.
      if (model.isDirty() && !await model.save({ reason: 'explicit' })) {
        explorer.focusView();
        return;
      }
    }
  }

  const reopen = groups.groups.map(group => ({
    group,
    editors: group.editors.flatMap(editor => {
      const relative = editor.resource && isEqualOrParent(editor.resource, source) ? relativePath(source, editor.resource) : undefined;
      return relative === undefined ? [] : [{ editor, resource: relative ? joinPath(target, relative) : target }];
    }),
  })).filter(({ editors }) => editors.length);

  try {
    await fileService.move(source, target);
  } catch (error) {
    console.warn(`Failed to rename ${source}.`, error);
    explorer.showError(`Unable to rename '${item.name}': ${describeError(error)}`);
    explorer.focusView();
    return;
  }
  explorer.moveExpanded(source, target);

  for (const { group, editors } of reopen) {
    const replacements: IEditorReplacement[] = [];
    for (const { editor, resource } of editors) {
      // Text typed between the save and the move stays in its editor, which now shows a deleted file.
      if (!editor.isDisposed() && !editor.isDirty() && group.contains(editor)) {
        replacements.push({ editor, replacement: (await resolver.resolveEditor({ resource }, group)).editor });
      }
    }
    if (groups.getGroup(group.id) === group && replacements.length) {
      await group.replaceEditors(replacements);
    }
    // A replacement made for a group or editor that went meanwhile is held by nothing.
    for (const { replacement } of replacements) {
      if (!replacement.isDisposed() && !groups.groups.some(other => other.contains(replacement))) {
        replacement.dispose();
      }
    }
  }
  if (parent) {
    await explorer.resolveFolder(parent);
  }
  await explorer.select(target, { focus: true });
}

/**
 * Deletes `item`, a folder with everything in it, once the user confirms. Editors that show it or
 * anything below it close first, asking about unsaved changes; a cancel there keeps everything.
 */
async function deleteItem(services: IOperationServices, item: ExplorerItem): Promise<void> {
  const { explorer, fileService, textFiles, quickInput, groups } = services;
  const resource = item.resource;

  const choice = await quickInput.pick([
    { id: 'delete', label: 'Delete', detail: 'This action is irreversible!' },
    { id: 'cancel', label: 'Cancel' },
  ], {
    title: item.isDirectory
      ? `Are you sure you want to permanently delete '${item.name}' and its contents?`
      : `Are you sure you want to permanently delete '${item.name}'?`,
  });
  if (choice?.id !== 'delete') {
    explorer.focusView();
    return;
  }

  for (const group of [...groups.groups]) {
    const editors = group.editors.filter(editor => editor.resource && isEqualOrParent(editor.resource, resource));
    if (editors.length && !await group.closeEditors(editors)) {
      explorer.focusView();
      return;
    }
  }
  // Text whose editors are all gone but that was not saved or reverted yet goes with its file.
  for (const model of textFiles.files.models) {
    if (isEqualOrParent(model.resource, resource) && model.isDirty()) {
      await model.revert({ soft: true });
    }
  }

  // The item after it takes the selection, or the one before, or its folder.
  const siblings = item.parent?.visibleChildren ?? [];
  const index = siblings.indexOf(item);
  const next = siblings[index + 1] ?? siblings[index - 1] ?? item.parent;
  try {
    await fileService.del(resource, { recursive: true });
  } catch (error) {
    console.warn(`Failed to delete ${resource}.`, error);
    explorer.showError(`Unable to delete '${item.name}': ${describeError(error)}`);
    explorer.focusView();
    return;
  }
  if (item.parent) {
    await explorer.resolveFolder(item.parent);
  }
  if (next && !next.isRoot && next.isAttached) {
    await explorer.select(next.resource, { focus: true });
  } else {
    explorer.setSelection(undefined);
    explorer.focusView();
  }
}

const inExplorerView = ContextKeyExpr.equals('view', EXPLORER_VIEW_ID);

registerAction2(class NewFileAction extends Action2 {
  constructor() {
    super({
      id: NEW_FILE_COMMAND_ID, title: 'New File...', icon: { id: 'new-file' },
      menu: [
        { id: MenuId.ViewTitle, group: 'navigation', order: 10, when: inExplorerView },
        { id: MenuId.ExplorerContext, group: 'navigation', order: 10 },
      ],
    });
  }

  override run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    return startNewEntry(accessor, false, args);
  }
});

registerAction2(class NewFolderAction extends Action2 {
  constructor() {
    super({
      id: NEW_FOLDER_COMMAND_ID, title: 'New Folder...', icon: { id: 'new-folder' },
      menu: [
        { id: MenuId.ViewTitle, group: 'navigation', order: 20, when: inExplorerView },
        { id: MenuId.ExplorerContext, group: 'navigation', order: 20 },
      ],
    });
  }

  override run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    return startNewEntry(accessor, true, args);
  }
});

registerAction2(class RefreshExplorerAction extends Action2 {
  constructor() {
    super({
      id: REFRESH_EXPLORER_COMMAND_ID, title: 'Refresh Explorer', category: 'File', f1: true, icon: { id: 'refresh' },
      menu: { id: MenuId.ViewTitle, group: 'navigation', order: 30, when: inExplorerView },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const { explorer, views } = explorerServices(accessor);
    await views.openView(EXPLORER_VIEW_ID);
    await explorer.refresh();
  }
});

registerAction2(class CollapseExplorerAction extends Action2 {
  constructor() {
    super({
      id: COLLAPSE_EXPLORER_COMMAND_ID, title: 'Collapse Folders in Explorer', category: 'File', f1: true, icon: { id: 'collapse-all' },
      menu: { id: MenuId.ViewTitle, group: 'navigation', order: 40, when: inExplorerView },
    });
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IExplorerService).collapseAll();
  }
});

const notRoot = ContextKeyExpr.not(ExplorerRootContext.key);

registerAction2(class RenameFileAction extends Action2 {
  constructor() {
    super({
      id: RENAME_FILE_COMMAND_ID, title: 'Rename...',
      menu: { id: MenuId.ExplorerContext, group: '7_modification', order: 10, when: notRoot },
    });
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const services = explorerServices(accessor);
    const { explorer } = services;
    const operations = operationServices(accessor);
    const item = await revealItem(services, commandResource(args));
    if (!item || item.isRoot || !item.parent) {
      return;
    }
    const folder = item.parent;
    explorer.setEditable({
      kind: 'rename',
      item,
      validate: value => validateExplorerName(value, folder, item),
      onFinish: (value, committed) => {
        if (committed && value !== item.name) {
          void rename(operations, item, value).catch(console.error);
        } else if (committed) {
          explorer.focusView();
        }
      },
    });
  }
});

registerAction2(class DeleteFileAction extends Action2 {
  constructor() {
    super({
      id: DELETE_FILE_COMMAND_ID, title: 'Delete',
      menu: { id: MenuId.ExplorerContext, group: '7_modification', order: 20, when: notRoot },
    });
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const services = explorerServices(accessor);
    const operations = operationServices(accessor);
    const item = await revealItem(services, commandResource(args));
    if (item && !item.isRoot) {
      await deleteItem(operations, item);
    }
  }
});

registerAction2(class RevealInExplorerAction extends Action2 {
  constructor() {
    super({ id: REVEAL_IN_EXPLORER_COMMAND_ID, title: 'Reveal in Explorer View' });
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const services = explorerServices(accessor);
    const resource = commandResource(args) ?? accessor.get(IEditorService).activeEditor?.resource;
    if (!resource || !isEqualOrParent(resource, services.explorer.root.resource)) {
      return;
    }
    await services.views.openView(EXPLORER_VIEW_ID);
    await services.explorer.select(resource, { focus: true });
  }
});

/** VS Code's Show Explorer: opens the Explorer view, wherever its container is, and focuses the tree. */
registerAction2(class ShowExplorerAction extends Action2 {
  constructor() {
    super({
      id: EXPLORER_VIEWLET_ID, title: 'Show Explorer', category: 'View', f1: true,
      keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE, weight: KeybindingWeight.WorkbenchContrib },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const { explorer, views } = explorerServices(accessor);
    await views.openView(EXPLORER_VIEW_ID);
    explorer.focusView();
  }
});

/**
 * VS Code's Upload...: files chosen on the computer go into the folder of the URI it is given (a
 * file's folder for a file), or of the Explorer's selection, or the workspace folder.
 */
registerAction2(class UploadAction extends Action2 {
  constructor() {
    super({
      id: UPLOAD_COMMAND_ID, title: UPLOAD_LABEL,
      menu: [
        { id: MenuId.ViewTitle, group: '5b_importexport', order: 10, when: inExplorerView },
        { id: MenuId.ExplorerContext, group: '5b_importexport', order: 20, when: ContextKeyExpr.has(ExplorerFolderContext.key) },
      ],
    });
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const services = explorerServices(accessor);
    const instantiation = accessor.get(IInstantiationService);
    const document = accessor.get(ILayoutService).mainContainer.ownerDocument;
    const resource = commandResource(args);
    const item = await revealItem(services, resource);
    if (resource && !item) {
      return;
    }
    const folder = !item ? services.explorer.root : item.isDirectory ? item : item.parent ?? services.explorer.root;
    const files = await chooseFilesToUpload(document);
    if (files?.length) {
      await instantiation.createInstance(BrowserFileUpload).upload(folder.resource, files.map(fileEntry));
    }
  }
});

/** VS Code's Download for one file of the workspace folder: the URI it is given, or the Explorer's selection. */
registerAction2(class DownloadAction extends Action2 {
  constructor() {
    super({
      id: DOWNLOAD_COMMAND_ID, title: DOWNLOAD_LABEL,
      menu: { id: MenuId.ExplorerContext, group: '5b_importexport', order: 10, when: ExplorerFolderContext.toNegated() },
    });
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const explorer = accessor.get(IExplorerService);
    const fileService = accessor.get(IFileService);
    const instantiation = accessor.get(IInstantiationService);
    const document = accessor.get(ILayoutService).mainContainer.ownerDocument;
    const resource = commandResource(args) ?? explorer.selection?.resource;
    // Only a file of the workspace folder, which the user sees in the Explorer.
    if (!resource || !isEqualOrParent(resource, explorer.root.resource)) {
      return;
    }
    // A missing file fails in the download, with its reason.
    const stat = await fileService.stat(resource).catch(() => undefined);
    if (stat?.isDirectory) {
      explorer.showError(`Unable to download '${basename(resource)}': only files can be downloaded, not folders.`);
      return;
    }
    await instantiation.createInstance(FileDownload).download(document, resource);
  }
});
