import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import type { GroupIdentifier, IEditorIdentifier, IEditorPane } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import type { IEditorGroup, IEditorOpenOptions } from './editorGroupsService.js';

export const IEditorService = createDecorator<IEditorService>('editorService');

/** Opens in the active group. */
export const ACTIVE_GROUP = -1;
export type ACTIVE_GROUP_TYPE = typeof ACTIVE_GROUP;

/** Opens in the group beside the active one, adding it to the right when there is none. */
export const SIDE_GROUP = -2;
export type SIDE_GROUP_TYPE = typeof SIDE_GROUP;

export type PreferredGroup = IEditorGroup | GroupIdentifier | ACTIVE_GROUP_TYPE | SIDE_GROUP_TYPE;

export interface IEditorCloseEvent extends IEditorIdentifier {
  /** The index the editor had in its group. */
  readonly index: number;
}

/** Editors across every group, and the one that is active. */
export interface IEditorService extends BrandedService {
  /** Fires when the active group's active editor changes, or another group becomes active. */
  readonly onDidActiveEditorChange: Event<void>;
  /** Fires once per change of `visibleEditors`: a group showed another editor, came or went. */
  readonly onDidVisibleEditorsChange: Event<void>;
  /** An editor left a group: closed, or moved to another group. */
  readonly onDidCloseEditor: Event<IEditorCloseEvent>;

  /** The active group's active editor. */
  readonly activeEditor: EditorInput | undefined;
  readonly activeEditorPane: IEditorPane | undefined;
  /** Every open editor, group by group in creation order, each group in tab order. */
  readonly editors: readonly EditorInput[];
  /** The active editor of each group, groups in grid order. */
  readonly visibleEditors: readonly EditorInput[];
  /** The panes that show `visibleEditors`, in the same order. */
  readonly visibleEditorPanes: readonly IEditorPane[];

  /**
   * Opens `editor` in `group`. A resource opens through the editor resolver, which picks the
   * editor (or `options.override` names it); one nobody can open shows an error editor instead.
   */
  openEditor(editor: EditorInput, options?: IEditorOpenOptions, group?: PreferredGroup): Promise<IEditorPane | undefined>;
  openEditor(editor: IResourceEditorInput, group?: PreferredGroup): Promise<IEditorPane | undefined>;
  /** The open editors of `resource`, in every group or in `group`. */
  findEditors(resource: URI, group?: IEditorGroup | GroupIdentifier): readonly IEditorIdentifier[];
}
