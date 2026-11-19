import { basename, dirname, isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ConfirmResult } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { IFileDialogService } from '../common/dialogs.js';
import type { IOpenDialogOptions, ISaveDialogOptions } from '../common/dialogs.js';
import { SimpleFileDialog } from './simpleFileDialog.js';

/**
 * The workbench's file dialogs, all quick inputs: the save confirmation is a quick pick, as every
 * confirmation here is, and the path dialogs are the `SimpleFileDialog`.
 */
export class FileDialogService implements IFileDialogService {
  declare readonly _serviceBrand: undefined;

  private readonly dialog: SimpleFileDialog;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IQuickInputService private readonly quickInput: IQuickInputService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
  ) {
    this.dialog = instantiationService.createInstance(SimpleFileDialog);
  }

  defaultFilePath(): URI | undefined {
    const folders = this.workspace.getWorkspace().folders;
    // The editor service is asked when needed: it is made with the editor part, after this service.
    const active = this.instantiationService.invokeFunction(accessor => {
      try {
        return accessor.get(IEditorService).activeEditor?.resource;
      } catch {
        return undefined;
      }
    });
    if (active && folders.some(folder => isEqualOrParent(active, folder.uri))) {
      return dirname(active);
    }
    return folders[0]?.uri;
  }

  async showSaveConfirm(fileNamesOrResources: readonly (string | URI)[]): Promise<ConfirmResult> {
    if (fileNamesOrResources.length === 0) {
      return ConfirmResult.DONT_SAVE;
    }
    const names = fileNamesOrResources.map(name => URI.isUri(name) ? basename(name) : name);
    const title = names.length === 1
      ? `Do you want to save the changes you made to ${names[0]}?`
      : `Do you want to save the changes to the following ${names.length} files?`;
    const choice = await this.quickInput.pick([
      { id: 'save', label: 'Save', description: names.length > 1 ? names.join(', ') : undefined },
      { id: 'dontSave', label: "Don't Save", detail: "Your changes will be lost if you don't save them." },
      { id: 'cancel', label: 'Cancel' },
    ], { title });
    // Escape, or another quick input taking the place of this one, cancels.
    return choice?.id === 'save' ? ConfirmResult.SAVE : choice?.id === 'dontSave' ? ConfirmResult.DONT_SAVE : ConfirmResult.CANCEL;
  }

  pickFileToSave(defaultUri: URI): Promise<URI | undefined> {
    return this.showSaveDialog({ defaultUri });
  }

  showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
    return this.dialog.showSaveDialog(options);
  }

  showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
    return this.dialog.showOpenDialog(options);
  }
}

registerSingleton(IFileDialogService, FileDialogService);
