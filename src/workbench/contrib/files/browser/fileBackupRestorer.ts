import { isEqual } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { BrowserTextFileService } from '../../../services/textfile/browser/textFileService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { FileEditorInput } from './editors/fileEditorInput.js';

/**
 * At startup, restore the drafts of dirty file models. A matching editor is asked to resolve
 * whatever its kind, so text editors and custom text editors can show their dirty marks.
 * A custom editor over a document of its own leaves the draft available for a later text open.
 * A draft without an editor gets a background text tab.
 */
export class FileBackupRestorer {
  static readonly ID = 'workbench.contrib.fileBackupRestorer';

  constructor(
    @IEditorGroupsService groups: IEditorGroupsService,
    @ITextFileService textFileService: ITextFileService,
    @IInstantiationService instantiationService: IInstantiationService,
  ) {
    if (!(textFileService instanceof BrowserTextFileService)) {
      return;
    }
    const backups = textFileService.backups;
    const hasEditor = (resource: URI) => groups.groups.some(group => group.editors.some(editor => isEqual(editor.resource, resource)));
    void backups.listRestorable().then(async resources => {
      // Take the editor list after the storage read. The user may have opened a file since startup.
      const editors = new Set(groups.groups.flatMap(group => group.editors).filter(editor => !editor.isDisposed()));
      for (const editor of editors) {
        // A file tab restored with a dirty mark also needs to learn whether its draft is still there.
        if (resources.some(resource => isEqual(resource, editor.resource)) || (editor instanceof FileEditorInput && editor.isDirty())) {
          void editor.resolve().catch(() => {});
        }
      }
      for (const resource of resources) {
        try {
          // A tab closed with Save or Don't Save while the list was read has no draft left to reopen.
          if (hasEditor(resource) || !await backups.hasRestorable(resource) || hasEditor(resource)) {
            continue;
          }
          const group = groups.activeGroup;
          const editor = instantiationService.createInstance(FileEditorInput, resource, { restoredDirty: true });
          try {
            void group.openEditor(editor, { index: group.editors.length, inactive: true, preserveFocus: true }).catch(console.warn);
          } catch (error) {
            editor.dispose();
            throw error;
          }
          void editor.resolve().catch(() => {});
        } catch (error) {
          console.warn(`Could not restore the draft of ${resource}.`, error);
        }
      }
    }).catch(error => console.warn('Could not restore file drafts.', error));
  }
}
