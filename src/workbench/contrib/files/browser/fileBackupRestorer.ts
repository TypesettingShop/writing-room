import { isEqual } from '../../../../base/common/resources.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { BrowserTextFileService } from '../../../services/textfile/browser/textFileService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { FileEditorInput } from './editors/fileEditorInput.js';

/**
 * At startup, once the editors of the last page are back: a draft stays while some editor of the page
 * has its file as `resource`, whatever its kind, and the others that no other tab keeps are deleted.
 * Each editor of a kept draft is asked to `resolve`: the text editor, and a custom editor over the
 * file's text (`CustomTextEditorProvider`), read the draft now, so their tabs show them dirty before
 * they are shown. An editor over a document of its own (`CustomEditorProvider`) reads nothing; the
 * draft only stays for when the file's text is opened again.
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
