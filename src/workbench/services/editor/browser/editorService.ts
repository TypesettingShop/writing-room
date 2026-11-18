import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { IEditorPane } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { GroupDirection, IEditorGroupsService } from '../common/editorGroupsService.js';
import type { IEditorGroup, IEditorOpenOptions } from '../common/editorGroupsService.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../common/editorService.js';
import type { PreferredGroup } from '../common/editorService.js';

/** Editors across the groups of the editor part. */
export class EditorService extends Disposable implements IEditorService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidActiveEditorChange = this._register(new Emitter<void>());
  readonly onDidActiveEditorChange = this._onDidActiveEditorChange.event;

  constructor(@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService) {
    super();
    this._register(editorGroupsService.onDidActiveEditorChange(() => this._onDidActiveEditorChange.fire()));
  }

  get activeEditor(): EditorInput | undefined {
    return this.editorGroupsService.activeGroup.activeEditor ?? undefined;
  }

  get activeEditorPane(): IEditorPane | undefined {
    const group = this.editorGroupsService.activeGroup;
    return group.activeEditor ? group.activeEditorPane : undefined;
  }

  get editors(): readonly EditorInput[] {
    return this.editorGroupsService.groups.flatMap(group => group.editors);
  }

  openEditor(editor: EditorInput, options?: IEditorOpenOptions, group: PreferredGroup = ACTIVE_GROUP): Promise<IEditorPane | undefined> {
    return this.findTargetGroup(group).openEditor(editor, options);
  }

  private findTargetGroup(preferred: PreferredGroup): IEditorGroup {
    const groups = this.editorGroupsService;
    if (preferred === ACTIVE_GROUP) {
      return groups.activeGroup;
    }
    if (preferred === SIDE_GROUP) {
      return groups.findGroup({ direction: GroupDirection.RIGHT }, groups.activeGroup)
        ?? groups.addGroup(groups.activeGroup, GroupDirection.RIGHT);
    }
    const group = typeof preferred === 'number' ? groups.getGroup(preferred) : preferred;
    return group ?? groups.activeGroup;
  }
}

registerSingleton(IEditorService, EditorService);
