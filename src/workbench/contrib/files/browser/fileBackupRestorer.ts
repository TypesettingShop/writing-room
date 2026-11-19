import { isEqual } from '../../../../base/common/resources.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { BrowserTextFileService } from '../../../services/textfile/browser/textFileService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { FileEditorInput } from './editors/fileEditorInput.js';

/**
 * At startup, once the editors of the last page are back: the editors that show a file with a draft
 * read it now, so their tabs show them dirty before they are shown; drafts that no editor of the page
 * shows, and that no other tab keeps, are deleted.
 *
 * An editor shows a file when its `resource` is that file, whatever its kind: a custom editor over the
 * file's text (`CustomTextEditorProvider`) writes the same drafts as the text editor, and its draft is
 * the user's text all the same.
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
    const editors = groups.groups.flatMap(group => group.editors);
    void textFileService.backups.discardUnused(resource => editors.some(editor => isEqual(editor.resource, resource)))
      .then(({ kept }) => {
        for (const editor of editors) {
          // An editor of a kept draft reads it through its model; a file tab restored as dirty learns
          // from its model whether its draft is still there.
          if (!editor.isDisposed() && (kept.some(resource => isEqual(resource, editor.resource))
            || (editor instanceof FileEditorInput && editor.isDirty()))) {
            void editor.resolve().catch(() => {});
          }
        }
      })
      .catch(error => console.warn('Could not restore the drafts of the open files.', error));
  }
}
