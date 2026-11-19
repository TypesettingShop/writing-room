import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatKeybinding } from '../../../base/common/keybindingLabels.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { MenuId, MenuRegistry } from '../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { KeybindingResolver } from '../../../platform/keybinding/common/keybindingResolver.js';
import { KeybindingsRegistry } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { Workbench } from '../../browser/workbench.js';
import type { LayoutStateModel } from '../../browser/layout.js';
import { registerWorkbenchContribution2 } from '../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../services/layout/browser/layoutService.js';
import { IStatusbarService, StatusbarAlignment } from '../../services/statusbar/browser/statusbar.js';
import { IViewsService } from '../../services/views/browser/viewsService.js';
import '../../workbench.web.main.js';

// These shell tests set up their own view containers and exercise the empty-part transitions.
vi.mock('../../services/extensionManagement/browser/builtinExtensionsScannerService.js', () => ({
  scanBuiltinExtensions: () => ({ extensions: [], messages: [] }),
}));

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
    const workbench = new Workbench(document.body, state);
    // Startup reads saved view locations through the browser storage service, which keeps them in this window's
    // storage. A test that fails before its own reset must not leave containers moved for the tests after it,
    // so the reset runs before the workbench is disposed.
    disposables.add(toDisposable(() => workbench.instantiationService.invokeFunction(accessor =>
      accessor.get(IViewDescriptorService).resetViewLocations())));
    disposables.add(workbench);
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

  it('moves live view panes, opens a hidden destination, and keeps empty parts hidden', async () => {
    const workbench = start({ panelHidden: true });
    const [views, descriptors, context] = workbench.instantiationService.invokeFunction(accessor => [
      accessor.get(IViewsService), accessor.get(IViewDescriptorService), accessor.get(IContextKeyService),
    ] as const);
    const explorer = descriptors.getViewContainerById('workbench.view.explorer')!;
    const open = await views.openViewContainer(explorer.id);
    const body = open!.element.querySelector('.view-pane-body');
    const panel = workbench.getContainer(Parts.PANEL_PART);
    const sidebar = workbench.getContainer(Parts.SIDEBAR_PART);
    expect(sidebar.contains(body)).toBe(true);

    descriptors.moveViewContainerToLocation(explorer, ViewContainerLocation.Panel);
    expect(panel.contains(body)).toBe(true);
    expect(sidebar.contains(body)).toBe(false);
    // The move alone opens the hidden panel on the moved container; no explicit open follows yet.
    expect(panel.hidden).toBe(false);
    expect(open!.element).toHaveProperty('hidden', false);
    expect(open!.element.getAttribute('role')).toBe('tabpanel');
    expect(context.getContextKeyValue('activePanel')).toBe(explorer.id);
    expect(context.getContextKeyValue('panelVisible')).toBe(true);
    expect(context.getContextKeyValue('activeViewlet')).toBe('');
    expect(context.getContextKeyValue('sideBarVisible')).toBe(false);
    expect(await views.openViewContainer(explorer.id)).toBe(open);
    const visibility = vi.fn();
    const visibilityListener = workbench.onDidChangePartVisibility(visibility);
    workbench.setPartHidden(false, Parts.SIDEBAR_PART);
    expect(sidebar.hidden).toBe(true);
    // An empty part refuses to show, rather than showing and hiding again.
    expect(visibility).not.toHaveBeenCalled();

    descriptors.resetViewLocations();
    expect(sidebar.contains(body)).toBe(true);
    expect(open!.element.hasAttribute('role')).toBe(false);
    expect(context.getContextKeyValue('activeViewlet')).toBe(explorer.id);
    expect(context.getContextKeyValue('activePanel')).toBe('workbench.panel.markers');

    const output = descriptors.getViewContainerById('workbench.panel.output')!;
    const problems = descriptors.getViewContainerById('workbench.panel.markers')!;
    descriptors.moveViewContainerToLocation(output, ViewContainerLocation.Sidebar);
    descriptors.moveViewContainerToLocation(problems, ViewContainerLocation.Sidebar);
    expect(panel.hidden).toBe(true);
    expect(context.getContextKeyValue('activePanel')).toBe('');
    expect(context.getContextKeyValue('panelVisible')).toBe(false);
    visibility.mockClear();
    workbench.setPartHidden(false, Parts.PANEL_PART);
    expect(panel.hidden).toBe(true);
    expect(visibility).not.toHaveBeenCalled();
    visibilityListener.dispose();

    descriptors.resetViewLocations();
    expect(panel.hidden).toBe(false);
    expect(context.getContextKeyValue('activePanel')).toBe(output.id);
  });

  it('keeps a part the person hid hidden when its containers come back by reset', () => {
    const workbench = start({ sideBarHidden: true });
    const [descriptors, context] = workbench.instantiationService.invokeFunction(accessor => [
      accessor.get(IViewDescriptorService), accessor.get(IContextKeyService),
    ] as const);
    const sidebar = workbench.getContainer(Parts.SIDEBAR_PART);
    for (const container of descriptors.getViewContainersByLocation(ViewContainerLocation.Sidebar)) {
      descriptors.moveViewContainerToLocation(container, ViewContainerLocation.Panel);
    }
    expect(descriptors.getViewContainersByLocation(ViewContainerLocation.Sidebar)).toEqual([]);
    expect(sidebar.hidden).toBe(true);

    descriptors.resetViewLocations();
    expect(descriptors.getViewContainersByLocation(ViewContainerLocation.Sidebar)).not.toEqual([]);
    expect(sidebar.hidden).toBe(true);
    expect(context.getContextKeyValue('sideBarVisible')).toBe(false);
    expect(context.getContextKeyValue('activeViewlet')).toBe('');
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
    const own = new Set(['left', 'priority-left', 'right', 'lower-right']);
    // Entries that workbench contributions add (the Problems counts) are not this test's.
    const entries = () => [...statusbar.querySelectorAll<HTMLElement>('[data-entry-id]')]
      .map(element => element.dataset.entryId).filter(id => own.has(id!));
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

  it('restores a remembered container that a contribution registers after the first layout', () => {
    disposables.add(registerWorkbenchContribution2('test.lateContainer', class {
      constructor() {
        const container = viewContainersRegistry.registerViewContainer({ id: 'test.late', title: 'Late' }, ViewContainerLocation.Sidebar);
        viewsRegistry.registerViews([{ id: 'test.late.view', name: 'Late View', renderBody() {} }], container);
      }
    }));
    try {
      const workbench = start({ activeViewlet: 'test.late' });
      expect(workbench.layoutState.activeViewlet).toBe('test.late');
      const context = workbench.instantiationService.invokeFunction(accessor => accessor.get(IContextKeyService));
      expect(context.getContextKeyValue('activeViewlet')).toBe('test.late');
    } finally {
      const container = viewContainersRegistry.get('test.late');
      if (container) {
        viewContainersRegistry.deregisterViewContainer(container);
      }
    }
  });

  it('starts despite a view whose body throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = viewContainersRegistry.registerViewContainer({ id: 'test.broken', title: 'Broken' }, ViewContainerLocation.Panel);
    viewsRegistry.registerViews([{ id: 'test.broken.view', name: 'Broken', renderBody() { throw new Error('test failure'); } }], container);
    const started = vi.fn();
    disposables.add(registerWorkbenchContribution2('test.afterBroken', class { constructor() { started(); } }));
    try {
      start({ activePanel: 'test.broken' });
      expect(started).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith('View test.broken.view failed to render.', expect.any(Error));
    } finally {
      viewContainersRegistry.deregisterViewContainer(container);
    }
  });

  it('keeps part sizes while the container has no size and starts late contributions', () => {
    const workbench = start({ sideBarSize: 240, panelSize: 210 });
    viewport = { width: 0, height: 0 };
    workbench.layout();
    viewport = { width: 800, height: 600 };
    workbench.layout();
    expect(workbench.layoutState).toMatchObject({ sideBarSize: 240, panelSize: 210 });
    expect(viewSize(workbench, Parts.SIDEBAR_PART)).toEqual([240, 548]);

    const started = vi.fn();
    disposables.add(registerWorkbenchContribution2('test.late', class { constructor() { started(); } }));
    expect(started).toHaveBeenCalledOnce();
  });

  it('starts a contribution that another contribution registers while the workbench starts', () => {
    const started = vi.fn();
    disposables.add(registerWorkbenchContribution2('test.registersAnother', class {
      constructor() {
        disposables.add(registerWorkbenchContribution2('test.registeredDuringStartup', class { constructor() { started(); } }));
      }
    }));
    start();
    expect(started).toHaveBeenCalledOnce();
  });

  it('keeps the default visibility for an explicitly undefined initial value', () => {
    const workbench = start({ panelHidden: undefined });
    const events = vi.fn();
    disposables.add(workbench.onDidChangePartVisibility(events));
    workbench.setPartHidden(false, Parts.PANEL_PART);
    expect(workbench.isVisible(Parts.PANEL_PART)).toBe(true);
    expect(events).not.toHaveBeenCalled();
  });

  it('drops a container that was never opened from the Activity Bar when it is deregistered', () => {
    const workbench = start();
    const activity = workbench.getContainer(Parts.ACTIVITYBAR_PART);
    const container = viewContainersRegistry.registerViewContainer({ id: 'test.unopened', title: 'Unopened' }, ViewContainerLocation.Sidebar);
    try {
      viewsRegistry.registerViews([{ id: 'test.unopened.view', name: 'Unopened View', renderBody() {} }], container);
      expect(activity.querySelector('[aria-label="Unopened"]')).not.toBeNull();
    } finally {
      viewContainersRegistry.deregisterViewContainer(container);
    }
    expect(activity.querySelector('[aria-label="Unopened"]')).toBeNull();
  });

  it('binds the sidebar and panel toggles to Cmd on macOS and Ctrl elsewhere', () => {
    const rules = KeybindingsRegistry.getDefaultKeybindings();
    for (const [id, key] of [['workbench.action.toggleSidebarVisibility', 'B'], ['workbench.action.togglePanel', 'J']] as const) {
      expect(formatKeybinding(new KeybindingResolver(rules, 'mac').lookupKeybinding(id)!, 'mac')).toBe(`⌘${key}`);
      expect(formatKeybinding(new KeybindingResolver(rules, 'linux').lookupKeybinding(id)!, 'linux')).toBe(`Ctrl+${key}`);
    }
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
