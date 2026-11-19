import type { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';

export enum Parts {
  TITLEBAR_PART = 'workbench.parts.titlebar',
  ACTIVITYBAR_PART = 'workbench.parts.activitybar',
  SIDEBAR_PART = 'workbench.parts.sidebar',
  EDITOR_PART = 'workbench.parts.editor',
  PANEL_PART = 'workbench.parts.panel',
  STATUSBAR_PART = 'workbench.parts.statusbar',
}

export interface IPartVisibilityChangeEvent {
  readonly partId: Parts;
  readonly visible: boolean;
}

export interface IWorkbenchLayoutService extends ILayoutService {
  readonly onDidChangePartVisibility: Event<IPartVisibilityChangeEvent>;
  isVisible(part: Parts): boolean;
  /** Automatic hiding follows container availability and leaves the stored user choice intact. */
  setPartHidden(hidden: boolean, part: Parts, options?: { readonly automatic: boolean }): void;
  getContainer(part: Parts): HTMLElement;
}

// Both service identifiers resolve to the same instance in a workbench.
export const IWorkbenchLayoutService = createDecorator<IWorkbenchLayoutService>(ILayoutService.toString());
