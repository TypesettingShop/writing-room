import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ConfirmResult } from '../../../common/editor/editorInput.js';

export const IFileDialogService = createDecorator<IFileDialogService>('fileDialogService');

/** Files whose extension is one of `extensions` (without the dot); `*` takes every file. */
export interface FileFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

export interface IOpenDialogOptions {
  readonly title?: string;
  /** Where the dialog starts: a folder, or a file whose folder it opens. */
  readonly defaultUri?: URI;
  /** The name of the choice that picks the folder the dialog shows. */
  readonly openLabel?: string;
  readonly canSelectFiles?: boolean;
  readonly canSelectFolders?: boolean;
  /** Accepted, but one item is picked at a time; the result is still a list. */
  readonly canSelectMany?: boolean;
  readonly filters?: readonly FileFilter[];
}

export interface ISaveDialogOptions {
  readonly title?: string;
  /** Where the dialog starts: a folder, or a file whose name it suggests in its folder. */
  readonly defaultUri?: URI;
  /** The name of the choice that saves under the suggested name. */
  readonly saveLabel?: string;
  readonly filters?: readonly FileFilter[];
}

/**
 * Picks paths in the workspace folders, as VS Code's `IFileDialogService` does. The browser has no
 * dialog of its own that reaches the workspace storage, so these dialogs are quick inputs (VS Code's
 * "simple file dialog"). Every path they give back is inside a workspace folder.
 */
export interface IFileDialogService extends BrandedService {
  /** Where a new file goes by default: the active file's folder, else the first workspace folder. */
  defaultFilePath(): URI | undefined;
  /** "Do you want to save the changes you made to …?" for one or more editors. */
  showSaveConfirm(fileNamesOrResources: readonly (string | URI)[]): Promise<ConfirmResult>;
  /** Asks where to save, starting from `defaultUri` (a suggested file). */
  pickFileToSave(defaultUri: URI): Promise<URI | undefined>;
  showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined>;
  showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined>;
}
