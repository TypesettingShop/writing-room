import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

export const SideBarVisibleContext = new RawContextKey<boolean>('sideBarVisible', false);
export const PanelVisibleContext = new RawContextKey<boolean>('panelVisible', false);
export const ActivityBarVisibleContext = new RawContextKey<boolean>('activityBarVisible', false);
export const StatusBarVisibleContext = new RawContextKey<boolean>('statusBarVisible', false);
export const ActiveViewletContext = new RawContextKey<string>('activeViewlet', '');
export const ActivePanelContext = new RawContextKey<string>('activePanel', '');
export const FocusedViewContext = new RawContextKey<string>('focusedView', '');
export const ViewContext = new RawContextKey<string>('view', '');

// Editor part (the part's scope) and editor groups (each group's scope)
export const ActiveEditorContext = new RawContextKey<string | null>('activeEditor', null);
export const EditorIsOpenContext = new RawContextKey<boolean>('editorIsOpen', false);
export const MultipleEditorGroupsContext = new RawContextKey<boolean>('multipleEditorGroups', false);
export const GroupEditorsCountContext = new RawContextKey<number>('groupEditorsCount', 0);
export const ActiveEditorGroupEmptyContext = new RawContextKey<boolean>('activeEditorGroupEmpty', false);
