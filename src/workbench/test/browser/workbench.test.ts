import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { MenuId, MenuRegistry } from '../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { Workbench } from '../../browser/workbench.js';
import type { LayoutStateModel } from '../../browser/layout.js';
import { registerWorkbenchContribution2 } from '../../common/contributions.js';
import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../services/layout/browser/layoutService.js';
import { IStatusbarService, StatusbarAlignment } from '../../services/statusbar/browser/statusbar.js';
import { IViewsService } from '../../services/views/browser/viewsService.js';
import '../../workbench.web.main.js';

describe('Workbench', () => {
  let disposables: DisposableStore;
  let viewport: { width: number; height: number };

  beforeEach(() => {
    disposables = new DisposableStore();
    viewport = { width: 800, height: 600 };
  });
  afterEach(() => {
    disposables.dispose();
    vi.restoreAllMocks();
  });

  function start(state?: Partial<LayoutStateModel>): Workbench {
    const workbench = disposables.add(new Workbench(document.body, state));
    Object.defineProperties(workbench.mainContainer, {
      clientWidth: { get: () => viewport.width },
      clientHeight: { get: () => viewport.height },
    });
    workbench.startup();
    return workbench;
  }

  function viewSize(workbench: Workbench, part: Parts): number[] {
    const { width, height } = workbench.getContainer(part).style;
    return [Number.parseFloat(width), Number.parseFloat(height)];
  }

  it('registers one real layout service and gives the editor all available growth', () => {
    const workbench = start({ sideBarSize: 240, panelSize: 210 });
    workbench.instantiationService.invokeFunction(accessor => {
      expect(accessor.get(ILayoutService)).toBe(workbench);
      expect(accessor.get(IWorkbenchLayoutService)).toBe(workbench);
      expect(accessor.get(ILayoutService).mainContainerOffset).toEqual({ top: 30, quickPickTop: 30 });
    });
    expect(viewSize(workbench, Parts.TITLEBAR_PART)).toEqual([800, 30]);
    expect(viewSize(workbench, Parts.ACTIVITYBAR_PART)).toEqual([48, 548]);
    expect(viewSize(workbench, Parts.SIDEBAR_PART)).toEqual([240, 548]);
    expect(viewSize(workbench, Parts.EDITOR_PART)).toEqual([512, 338]);
    expect(viewSize(workbench, Parts.PANEL_PART)).toEqual([512, 210]);
    expect(viewSize(workbench, Parts.STATUSBAR_PART)).toEqual([800, 22]);

    viewport = { width: 1280, height: 800 };
    window.dispatchEvent(new Event('resize'));
    expect(viewSize(workbench, Parts.SIDEBAR_PART)).toEqual([240, 748]);
    expect(viewSize(workbench, Parts.EDITOR_PART)).toEqual([992, 538]);
    expect(viewSize(workbench, Parts.PANEL_PART)).toEqual([992, 210]);
  });

  it('clamps initial sizes and preserves hidden values for their first reveal', () => {
    const workbench = start({
      sideBarSize: 20, panelSize: 1500, sideBarHidden: true, panelHidden: true,
      statusBarHidden: true, activityBarHidden: true, activePanel: 'workbench.panel.markers',
    });
    expect(viewSize(workbench, Parts.EDITOR_PART)).toEqual([800, 570]);
    expect(workbench.layoutState.sideBarSize).toBe(170);
    expect(workbench.layoutState.panelSize).toBe(500);
    for (const part of [Parts.SIDEBAR_PART, Parts.PANEL_PART, Parts.ACTIVITYBAR_PART, Parts.STATUSBAR_PART]) {
      expect(workbench.isVisible(part)).toBe(false);
      expect(workbench.getContainer(part).hidden).toBe(true);
    }

    workbench.setPartHidden(false, Parts.SIDEBAR_PART);
    workbench.setPartHidden(false, Parts.PANEL_PART);
    expect(viewSize(workbench, Parts.SIDEBAR_PART)).toEqual([170, 570]);
    expect(viewSize(workbench, Parts.EDITOR_PART)).toEqual([630, 70]);
    expect(viewSize(workbench, Parts.PANEL_PART)).toEqual([630, 500]);
    expect(workbench.getContainer(Parts.PANEL_PART).querySelector('[aria-selected="true"]')?.textContent).toBe('Problems');
  });

  it('syncs visibility, context and grid when commands hide and restore parts', async () => {
    const workbench = start({ sideBarSize: 235, panelSize: 113 });
    const [commands, context] = workbench.instantiationService.invokeFunction(accessor => [
      accessor.get(ICommandService), accessor.get(IContextKeyService),
    ] as const);
    const events = vi.fn();
    disposables.add(workbench.onDidChangePartVisibility(events));
    const toggles = [
      [Parts.SIDEBAR_PART, 'sideBarVisible', 'workbench.action.toggleSidebarVisibility', 0],
      [Parts.PANEL_PART, 'panelVisible', 'workbench.action.togglePanel', 1],
      [Parts.ACTIVITYBAR_PART, 'activityBarVisible', 'workbench.action.toggleActivityBarVisibility', 0],
      [Parts.STATUSBAR_PART, 'statusBarVisible', 'workbench.action.toggleStatusbarVisibility', 1],
    ] as const;
    for (const [part, key, command, axis] of toggles) {
      const original = viewSize(workbench, part);
      await commands.executeCommand(command);
      expect(workbench.isVisible(part)).toBe(false);
      expect(context.getContextKeyValue(key)).toBe(false);
      expect(workbench.getContainer(part).hidden).toBe(true);
      expect(viewSize(workbench, part)[axis]).toBe(0);
      expect(events).toHaveBeenLastCalledWith({ partId: part, visible: false });

      await commands.executeCommand(command);
      expect(workbench.isVisible(part)).toBe(true);
      expect(context.getContextKeyValue(key)).toBe(true);
      expect(workbench.getContainer(part).hidden).toBe(false);
      expect(viewSize(workbench, part)).toEqual(original);
      expect(events).toHaveBeenLastCalledWith({ partId: part, visible: true });
    }
    workbench.setPartHidden(true, Parts.TITLEBAR_PART);
    workbench.setPartHidden(true, Parts.EDITOR_PART);
    expect(workbench.isVisible(Parts.TITLEBAR_PART)).toBe(true);
    expect(workbench.isVisible(Parts.EDITOR_PART)).toBe(true);
    expect(events).toHaveBeenCalledTimes(8);
  });

  it('tracks late registrations, scopes view menus, and creates a view body once it is visible', async () => {
    const workbench = start();
    const [views, context] = workbench.instantiationService.invokeFunction(accessor => [
      accessor.get(IViewsService), accessor.get(IContextKeyService),
    ] as const);
    const enabled = context.createKey('shellTestHasView', false as boolean);
    const activity = workbench.getContainer(Parts.ACTIVITYBAR_PART);
    const descriptor = { id: 'test.secondary', title: 'Custom Explorer', icon: '$(search)' };
    const container = viewContainersRegistry.registerViewContainer(descriptor, ViewContainerLocation.Sidebar);

    try {
      expect(viewContainersRegistry.registerViewContainer({ ...descriptor }, ViewContainerLocation.Panel)).toBe(container);
      const layoutBody = vi.fn();
      const dispose = vi.fn();
      const renderBody = vi.fn(() => ({ layoutBody, dispose }));
      const view = { id: 'test.secondary.view', name: 'Custom Files', renderBody, when: ContextKeyExpr.has('shellTestHasView') };
      viewsRegistry.registerViews([view, view], container);
      disposables.add(MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
        command: { id: 'test.viewTitle', title: 'Custom action' },
        group: 'navigation', when: ContextKeyExpr.equals('view', view.id),
      }));

      expect(activity.querySelector('[aria-label="Custom Explorer"]')).toBeNull();
      expect(await views.openView(view.id)).toBeNull();
      enabled.set(true);
      expect(activity.querySelectorAll('[aria-label="Custom Explorer"]')).toHaveLength(1);
      expect(renderBody).not.toHaveBeenCalled();

      const pane = await views.openView(view.id, true);
      expect(pane?.element.querySelector('[aria-label="Custom action"]')).not.toBeNull();
      expect(context.getContextKeyValue('focusedView')).toBe(view.id);
      expect(context.getContextKeyValue('activeViewlet')).toBe(container.id);
      expect(context.getContext(pane!.element).getValue('view')).toBe(view.id);
      expect(layoutBody).toHaveBeenLastCalledWith(486, 200);

      workbench.setPartHidden(true, Parts.SIDEBAR_PART);
      expect(context.getContextKeyValue('focusedView')).toBe('');
      expect(context.getContextKeyValue('activeViewlet')).toBe('');
      workbench.setPartHidden(false, Parts.SIDEBAR_PART);
      expect(context.getContextKeyValue('activeViewlet')).toBe(container.id);
      expect(renderBody).toHaveBeenCalledTimes(1);

      viewContainersRegistry.deregisterViewContainer(container);
      expect(activity.querySelector('[aria-label="Custom Explorer"]')).toBeNull();
      expect(await views.openView(view.id)).toBeNull();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(context.getContextKeyValue('activeViewlet')).toBe('workbench.view.explorer');
    } finally {
      viewContainersRegistry.deregisterViewContainer(container);
    }
  });

  it('keeps the remembered container while sidebar visibility filters out its views', async () => {
    const workbench = start();
    const [views, context] = workbench.instantiationService.invokeFunction(accessor => [
      accessor.get(IViewsService), accessor.get(IContextKeyService),
    ] as const);
    const container = viewContainersRegistry.registerViewContainer({
      id: 'test.conditional', title: 'Conditional',
    }, ViewContainerLocation.Sidebar);
    try {
      const view = {
        id: 'test.conditional.view',
        name: 'Conditional View',
        when: ContextKeyExpr.has('sideBarVisible'),
        renderBody() {},
      };
      viewsRegistry.registerViews([view], container);
      expect(await views.openView(view.id)).not.toBeNull();

      workbench.setPartHidden(true, Parts.SIDEBAR_PART);
      expect(workbench.layoutState.activeViewlet).toBe(container.id);
      expect(context.getContextKeyValue('activeViewlet')).toBe('');
      workbench.setPartHidden(false, Parts.SIDEBAR_PART);
      expect(context.getContextKeyValue('activeViewlet')).toBe(container.id);
    } finally {
      viewContainersRegistry.deregisterViewContainer(container);
    }
  });

  it('orders status entries, updates their existing element, and executes the current command', async () => {
    const workbench = start();
    const called = vi.fn();
    disposables.add(CommandsRegistry.registerCommand('test.status', (_, ...args) => called(...args)));
    const service = workbench.instantiationService.invokeFunction(accessor => accessor.get(IStatusbarService));
    service.addEntry({ name: 'Left', text: 'Left' }, 'left', StatusbarAlignment.LEFT, 5);
    service.addEntry({ name: 'Left priority', text: 'Left priority' }, 'priority-left', StatusbarAlignment.LEFT, 10);
    service.addEntry({ name: 'Right', text: 'Right' }, 'right', StatusbarAlignment.RIGHT, 10);
    const item = service.addEntry({ name: 'Lower right', text: 'Click' }, 'lower-right', StatusbarAlignment.RIGHT, 1);
    const statusbar = workbench.getContainer(Parts.STATUSBAR_PART);
    const entries = () => [...statusbar.querySelectorAll<HTMLElement>('[data-entry-id]')].map(element => element.dataset.entryId);
    expect(entries()).toEqual(['priority-left', 'left', 'right', 'lower-right']);
    const element = statusbar.querySelector('[data-entry-id="lower-right"]');

    item.update({ name: 'Updated', text: '$(check) Ready', command: { id: 'test.status', arguments: ['clicked'] } });
    expect(entries()).toHaveLength(4);
    expect(statusbar.querySelector('[data-entry-id="lower-right"]')).toBe(element);
    expect(element?.querySelector('.codicon-check')).not.toBeNull();
    element?.querySelector('button')?.click();
    await vi.waitFor(() => expect(called).toHaveBeenCalledWith('clicked'));

    item.dispose();
    item.update({ name: 'Disposed', text: 'Disposed' });
    expect(entries()).toEqual(['priority-left', 'left', 'right']);
  });

  it('lays out before contributions start and continues after a constructor throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = vi.fn();
    disposables.add(registerWorkbenchContribution2('test.bad', class {
      constructor() { throw new Error('test failure'); }
    }));
    class GoodContribution {
      constructor(@IWorkbenchLayoutService layout: IWorkbenchLayoutService) {
        started(layout.getContainer(Parts.EDITOR_PART).style.width);
      }
    }
    disposables.add(registerWorkbenchContribution2('test.good', GoodContribution));
    const workbench = start();
    workbench.startup();
    expect(started).toHaveBeenCalledExactlyOnceWith('552px');
    expect(error).toHaveBeenCalledWith('Workbench contribution test.bad failed to start.', expect.any(Error));
  });
});
