import type { Event } from '../../../../base/common/event.js';
import type { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { ITextEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import type { EditorsOrder, GroupIdentifier, IEditorPane } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import type { IGroupModelChangeEvent } from '../../../common/editor/editorGroupModel.js';

export const IEditorGroupsService = createDecorator<IEditorGroupsService>('editorGroupsService');

export enum GroupDirection {
  UP,
  DOWN,
  LEFT,
  RIGHT,
}

export enum GroupsOrder {
  /** The order the groups were created in. */
  CREATION_TIME,
  /** The most recently active group first. */
  MOST_RECENTLY_ACTIVE,
  /** The order the groups appear in the grid: rows before columns, depth first. */
  GRID_APPEARANCE,
}

export enum GroupLocation {
  FIRST,
  LAST,
  NEXT,
  PREVIOUS,
}

export interface IFindGroupScope {
  readonly direction?: GroupDirection;
  readonly location?: GroupLocation;
}

export enum MergeGroupMode {
  COPY_EDITORS,
  MOVE_EDITORS,
}

export interface IMergeGroupOptions {
  readonly mode?: MergeGroupMode;
  /** Where the merged editors go in the target; by default after its last editor. */
  readonly index?: number;
}

export interface IEditorOpenOptions extends ITextEditorOptions {
  /** The editor's index in the group; by default the part's `openPositioning` decides. */
  readonly index?: number;
  /** Opens the editor without making it the group's active editor or the group the active group. */
  readonly inactive?: boolean;
}

export interface IEditorMoveOptions {
  /** The editor's index in the target group after the move. */
  readonly index?: number;
  readonly inactive?: boolean;
  readonly preserveFocus?: boolean;
}

export interface ICloseEditorsFilter {
  /** Close every editor of the group except this one. */
  readonly except?: EditorInput;
}

/** One editor group: a tab strip over the pane that shows its active editor. */
export interface IEditorGroup {
  readonly id: GroupIdentifier;
  readonly element: HTMLElement;
  /** The group's own context key scope, on its element. */
  readonly scopedContextKeyService: IContextKeyService;

  readonly onDidModelChange: Event<IGroupModelChangeEvent>;
  readonly onDidActiveEditorChange: Event<void>;
  readonly onWillDispose: Event<void>;

  readonly count: number;
  readonly isEmpty: boolean;
  readonly activeEditor: EditorInput | null;
  readonly activeEditorPane: IEditorPane | undefined;
  /** The editors in tab order. */
  readonly editors: readonly EditorInput[];

  getEditors(order: EditorsOrder): readonly EditorInput[];
  getEditorByIndex(index: number): EditorInput | undefined;
  getIndexOfEditor(editor: EditorInput): number;
  /** Whether the group holds this editor object, or with `matches`, an editor that matches it. */
  contains(editor: EditorInput, options?: { readonly matches?: boolean }): boolean;
  isActive(editor: EditorInput): boolean;

  /**
   * Opens `editor`, or activates the editor of the group that `matches` it. The promise settles once
   * the pane shows it; it is `undefined` when the editor did not become active.
   */
  openEditor(editor: EditorInput, options?: IEditorOpenOptions): Promise<IEditorPane | undefined>;
  /** Moves `editor` within this group, or to `target`, taking its view state along. */
  moveEditor(editor: EditorInput, target: IEditorGroup, options?: IEditorMoveOptions): boolean;
  /** Opens `editor` in `target` too, starting from the view state it has here. */
  copyEditor(editor: EditorInput, target: IEditorGroup, options?: IEditorMoveOptions): void;
  /**
   * Closes `editor`, by default the active one, without activating it first. Focus that was inside
   * the group stays in it, or moves to the group that becomes active when this one goes away.
   */
  closeEditor(editor?: EditorInput): boolean;
  closeEditors(editors: readonly EditorInput[] | ICloseEditorsFilter): boolean;
  closeAllEditors(): boolean;

  focus(): void;
}

/** The editor part: the grid of editor groups. */
export interface IEditorGroupsService extends BrandedService {
  readonly onDidChangeActiveGroup: Event<IEditorGroup>;
  readonly onDidAddGroup: Event<IEditorGroup>;
  readonly onDidRemoveGroup: Event<IEditorGroup>;
  readonly onDidMoveGroup: Event<IEditorGroup>;
  /** The active group's active editor changed, or another group became active. */
  readonly onDidActiveEditorChange: Event<void>;

  readonly activeGroup: IEditorGroup;
  /** The groups in creation order. */
  readonly groups: readonly IEditorGroup[];
  readonly count: number;

  getGroups(order?: GroupsOrder): readonly IEditorGroup[];
  getGroup(identifier: GroupIdentifier): IEditorGroup | undefined;
  /** The group in `scope` seen from `source` (by default the active group). */
  findGroup(scope: IFindGroupScope, source?: IEditorGroup | GroupIdentifier, wrap?: boolean): IEditorGroup | undefined;

  activateGroup(group: IEditorGroup | GroupIdentifier): IEditorGroup;
  /** Adds an empty group beside `location`. */
  addGroup(location: IEditorGroup | GroupIdentifier, direction: GroupDirection): IEditorGroup;
  /** Removes `group`, first merging its editors into the most recently active other group. */
  removeGroup(group: IEditorGroup | GroupIdentifier, preserveFocus?: boolean): void;
  /** Moves `group`'s own view beside `location`; nothing inside it is created again. */
  moveGroup(group: IEditorGroup | GroupIdentifier, location: IEditorGroup | GroupIdentifier, direction: GroupDirection): IEditorGroup;
  /** Moves (or copies) `group`'s editors into `target`, in order, and removes `group`. */
  mergeGroup(group: IEditorGroup | GroupIdentifier, target: IEditorGroup | GroupIdentifier, options?: IMergeGroupOptions): boolean;
  /** Merges every other group into `target` (by default the active group). */
  mergeAllGroups(target?: IEditorGroup | GroupIdentifier): boolean;
}
