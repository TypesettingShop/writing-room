import { Disposable } from '../../../../base/common/lifecycle.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';

/**
 * Lets links open resources in editors: a resource some registered editor takes opens there, in the
 * active group or beside it. A resource no editor takes is left to the next opener, and in the end refused.
 */
export class EditorOpenerContribution extends Disposable {
  static readonly ID = 'workbench.contrib.editorOpener';

  constructor(
    @IOpenerService opener: IOpenerService,
    @IEditorService editorService: IEditorService,
    @IEditorResolverService resolver: IEditorResolverService,
  ) {
    super();
    this._register(opener.registerOpener({
      open: async (resource, options) => {
        // An `option` editor is never picked by default, so a resource only such editors take is
        // not this opener's either: opening it would show an error editor.
        if (!resolver.getEditors(resource).some(editor => editor.priority !== RegisteredEditorPriority.option)) {
          return false;
        }
        await editorService.openEditor(
          { resource, options: { preserveFocus: options?.preserveFocus, selection: options?.selection } },
          options?.openToSide ? SIDE_GROUP : ACTIVE_GROUP,
        );
        return true;
      },
    }));
  }
}
