import { isEqual } from '../../../../base/common/resources.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { BrowserTextFileService } from '../../../services/textfile/browser/textFileService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { FileEditorInput } from './editors/fileEditorInput.js';

/**
 * At startup, once the editors of the last page are back: the file editors that have a draft read
 * it now, so their tabs show them dirty before they are shown; drafts whose editor did not come
 * back, and that no other tab keeps, are deleted.
 */
export class FileBackupRestorer {
  static readonly ID = 'workbench.contrib.fileBackupRestorer';

  constructor(
    @IEditorGroupsService groups: IEditorGroupsService,
    @ITextFileService textFileService: ITextFileService,
  ) {
    if (!(textFileService instanceof BrowserTextFileService)) {
      return;
    }
    const inputs = groups.groups.flatMap(group => group.editors)
      .filter((editor): editor is FileEditorInput => editor instanceof FileEditorInput);
    void textFileService.backups.discardUnused(resource => inputs.some(input => isEqual(input.resource, resource)))
      .then(({ kept }) => {
        for (const input of inputs) {
          // A tab restored as dirty learns from its model whether its draft is still there.
          if (!input.isDisposed() && (input.isDirty() || kept.some(resource => isEqual(resource, input.resource)))) {
            void input.resolve().catch(() => {});
          }
        }
      })
      .catch(error => console.warn('Could not restore the drafts of the open files.', error));
  }
}
