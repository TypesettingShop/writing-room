import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import {
  FileOperationError, FileOperationResult, FileSystemProviderErrorCode, toFileSystemProviderErrorCode,
} from '../../../../../platform/files/common/files.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { NotificationsToasts } from '../../../../browser/parts/notifications/notificationsToasts.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import type {
  ITextFileEditorModel, ITextFileSaveErrorHandler, TextFileConflictResolution,
} from '../../../../services/textfile/common/textfiles.js';

/** Whether `error` says the browser storage has no room left. */
export function isStorageFullError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === 'QuotaExceededError'
      || toFileSystemProviderErrorCode(current) === FileSystemProviderErrorCode.FileExceedsStorageQuota
      || (current instanceof FileOperationError && current.fileOperationResult === FileOperationResult.FILE_EXCEEDS_STORAGE_QUOTA)) {
      return true;
    }
  }
  return false;
}

/** The notification of a failed save. */
export function describeSaveError(error: unknown, model: ITextFileEditorModel): string {
  const name = basename(model.resource);
  if (isStorageFullError(error)) {
    return `Failed to save '${name}': The browser storage is full. Free up space and try again.`;
  }
  const detail = error instanceof Error && error.message ? error.message : String(error);
  return `Failed to save '${name}': ${detail}`;
}

/**
 * What the user is asked when a save cannot go on: a conflict with a newer file is a quick pick
 * (Overwrite, Revert, Cancel), as confirmations are here; a failure is an error notification.
 */
export class TextFileSaveErrorHandler extends Disposable implements ITextFileSaveErrorHandler {
  static readonly ID = 'workbench.contrib.textFileSaveErrorHandler';

  private readonly toasts: NotificationsToasts;

  constructor(
    @IQuickInputService private readonly quickInput: IQuickInputService,
    @ILayoutService layout: ILayoutService,
    @ITextFileService textFileService: ITextFileService,
  ) {
    super();
    this.toasts = this._register(new NotificationsToasts(layout.mainContainer));
    const files = textFileService.files;
    const previous = files.saveErrorHandler;
    files.saveErrorHandler = this;
    this._register({ dispose: () => {
      if (files.saveErrorHandler === this) {
        files.saveErrorHandler = previous;
      }
    } });
  }

  async resolveConflict(model: ITextFileEditorModel): Promise<TextFileConflictResolution> {
    const name = basename(model.resource);
    const choice = await this.quickInput.pick([
      { id: 'overwrite', label: 'Overwrite', detail: 'Save your changes over the newer file.' },
      { id: 'revert', label: 'Revert', detail: 'Discard your changes and load the newer file.' },
      { id: 'cancel', label: 'Cancel', detail: 'Keep your changes unsaved.' },
    ], { title: `Failed to save '${name}': The content of the file is newer. Do you want to overwrite the file with your changes?` });
    return choice?.id === 'overwrite' || choice?.id === 'revert' ? choice.id : 'cancel';
  }

  onSaveError(error: unknown, model: ITextFileEditorModel): void {
    console.warn(`Failed to save ${model.resource}.`, error);
    this.toasts.show('error', describeSaveError(error, model), [], () => {});
  }
}
