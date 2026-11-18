import type { IDisposable } from '../../base/common/lifecycle.js';
import { IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../platform/keybinding/common/keybinding.js';
import {
  ActivityBarVisibleContext, PanelVisibleContext, SideBarVisibleContext, StatusBarVisibleContext,
} from '../common/contextkeys.js';
import { workbenchContributions } from '../common/contributions.js';
import type { WorkbenchContribution } from '../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../services/layout/browser/layoutService.js';
import { IStatusbarService } from '../services/statusbar/browser/statusbar.js';
import { Layout } from './layout.js';
import type { Part } from './part.js';
import { ActivitybarPart } from './parts/activitybar/activitybarPart.js';
import { EditorPart } from './parts/editor/editorPart.js';
import { PanelPart } from './parts/panel/panelPart.js';
import { IPaneCompositePartService, PaneCompositePartService } from './parts/paneCompositePartService.js';
import { SidebarPart } from './parts/sidebar/sidebarPart.js';
import { StatusbarPart } from './parts/statusbar/statusbarPart.js';
import { TitlebarPart } from './parts/titlebar/titlebarPart.js';
import './workbench.css';

export class Workbench extends Layout {
  private readonly services = new ServiceCollection([IWorkbenchLayoutService, this]);
  readonly instantiationService = new InstantiationService(this.services);
  private started = false;

  startup(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const instantiation = this.instantiationService;
    const context = this._register(instantiation.invokeFunction(accessor => accessor.get(IContextKeyService)));
    const keybindings = instantiation.invokeFunction(accessor => accessor.get(IKeybindingService));
    if ('dispose' in keybindings && typeof keybindings.dispose === 'function') {
      this._register(keybindings as IKeybindingService & IDisposable);
    }
    this.bindVisibilityContextKeys(context);

    const titlebar = instantiation.createInstance(TitlebarPart);
    const sidebar = instantiation.createInstance(SidebarPart, this.layoutState);
    const activitybar = instantiation.createInstance(ActivitybarPart, sidebar);
    const editor = instantiation.createInstance(EditorPart);
    const panel = instantiation.createInstance(PanelPart, this.layoutState);
    const statusbar = instantiation.createInstance(StatusbarPart);
    this.services.set(IStatusbarService, statusbar);
    this.services.set(IPaneCompositePartService, new PaneCompositePartService(sidebar, panel));

    const parts = [titlebar, activitybar, sidebar, editor, panel, statusbar];
    for (const part of parts) {
      this.registerPart(part);
    }
    for (const part of parts) {
      this.createPart(part);
    }

    this.parent.append(this.mainContainer);
    this.createWorkbenchLayout();
    sidebar.initializeViewContainers();
    panel.initializeViewContainers();

    // Listen before the loop: a contribution that registers another while it starts is not in the list below.
    this._register(workbenchContributions.onDidRegister(([id, contribution]) => this.startContribution(id, contribution)));
    for (const [id, contribution] of workbenchContributions.getContributions()) {
      this.startContribution(id, contribution);
    }
  }

  private startContribution(id: string, contribution: WorkbenchContribution): void {
    try {
      const instance = this.instantiationService.createInstance(contribution) as Partial<IDisposable>;
      if (typeof instance.dispose === 'function') {
        this._register(instance as IDisposable);
      }
    } catch (error) {
      console.error(`Workbench contribution ${id} failed to start.`, error);
    }
  }

  private createPart(part: Part): void {
    const status = part.id === Parts.STATUSBAR_PART;
    const container = this.parent.ownerDocument.createElement(status ? 'footer' : 'div');
    container.id = part.id;
    container.className = `part ${part.id.split('.').at(-1)}`;
    const editor = part.id === Parts.EDITOR_PART;
    container.setAttribute('role', status ? 'status' : editor ? 'main' : 'none');
    if (editor) {
      container.tabIndex = -1;
    }
    part.create(container);
  }

  private bindVisibilityContextKeys(context: IContextKeyService): void {
    const keys = new Map([
      [Parts.ACTIVITYBAR_PART, ActivityBarVisibleContext.bindTo(context)],
      [Parts.SIDEBAR_PART, SideBarVisibleContext.bindTo(context)],
      [Parts.PANEL_PART, PanelVisibleContext.bindTo(context)],
      [Parts.STATUSBAR_PART, StatusBarVisibleContext.bindTo(context)],
    ]);
    for (const [part, key] of keys) {
      key.set(this.isVisible(part));
    }
    this._register(this.onDidChangePartVisibility(({ partId, visible }) => keys.get(partId)?.set(visible)));
  }
}
