import type { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import type { GroupIdentifier, IEditorPane } from '../../../common/editor.js';
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

/** Editors across every group, and the one that is active. */
export interface IEditorService extends BrandedService {
  /** Fires when the active group's active editor changes, or another group becomes active. */
  readonly onDidActiveEditorChange: Event<void>;
  /** The active group's active editor. */
  readonly activeEditor: EditorInput | undefined;
  readonly activeEditorPane: IEditorPane | undefined;
  /** Every open editor, group by group in creation order, each group in tab order. */
  readonly editors: readonly EditorInput[];

  openEditor(editor: EditorInput, options?: IEditorOpenOptions, group?: PreferredGroup): Promise<IEditorPane | undefined>;
}
