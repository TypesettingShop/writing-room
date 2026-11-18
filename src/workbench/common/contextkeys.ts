import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

export const SideBarVisibleContext = new RawContextKey<boolean>('sideBarVisible', false);
export const PanelVisibleContext = new RawContextKey<boolean>('panelVisible', false);
export const ActivityBarVisibleContext = new RawContextKey<boolean>('activityBarVisible', false);
export const StatusBarVisibleContext = new RawContextKey<boolean>('statusBarVisible', false);
export const ActiveViewletContext = new RawContextKey<string>('activeViewlet', '');
export const ActivePanelContext = new RawContextKey<string>('activePanel', '');
export const FocusedViewContext = new RawContextKey<string>('focusedView', '');
export const ViewContext = new RawContextKey<string>('view', '');
