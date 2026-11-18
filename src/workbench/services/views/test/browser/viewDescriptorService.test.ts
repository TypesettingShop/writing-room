import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ViewContainerLocation, viewContainersRegistry } from '../../../../common/views.js';
import { ViewDescriptorService } from '../../browser/viewDescriptorService.js';

const { Sidebar, Panel } = ViewContainerLocation;
const scope = StorageScope.PROFILE;
const customizations = 'views.customizations';
const sidebarOrder = 'workbench.activity.pinnedViewlets2';
const panelOrder = 'workbench.panel.pinnedPanels';

describe('ViewDescriptorService', () => {
  let disposables: DisposableStore;
  let storage: InMemoryStorageService;

  beforeEach(() => {
    disposables = new DisposableStore();
    storage = new InMemoryStorageService();
  });

  afterEach(() => {
    disposables.dispose();
    storage.dispose();
  });

  function register(id: string, location: ViewContainerLocation) {
    const container = viewContainersRegistry.registerViewContainer({ id, title: id }, location);
    disposables.add(toDisposable(() => viewContainersRegistry.deregisterViewContainer(container)));
    return container;
  }

  function store(key: string, value: string | object) {
    storage.store(key, value, scope, StorageTarget.USER);
  }

  it('moves and reorders containers, emits once per change, and skips writes for a no-op', () => {
    const explorer = register('explorer', Sidebar);
    const output = register('output', Panel);
    const problems = register('problems', Panel);
    const views = disposables.add(new ViewDescriptorService(storage));
    const changes = vi.fn();
    disposables.add(views.onDidChangeContainerLocation(changes));
    const write = vi.spyOn(storage, 'store');
    const remove = vi.spyOn(storage, 'remove');

    expect(views.getViewContainerLocation(explorer)).toBe(Sidebar);
    views.moveViewContainerToLocation(explorer, Sidebar, 0);
    expect(changes).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    views.moveViewContainerToLocation(explorer, Panel, 1);
    expect(views.getViewContainerLocation(explorer)).toBe(Panel);
    expect(views.getDefaultViewContainerLocation(explorer)).toBe(Sidebar);
    expect(views.getViewContainersByLocation(Panel)).toEqual([output, explorer, problems]);
    expect(views.getViewContainersByLocation(Sidebar)).toEqual([]);
    expect(changes).toHaveBeenCalledExactlyOnceWith({
      changes: [{ viewContainer: explorer, from: Sidebar, to: Panel, fromIndex: 0 }], reset: false,
    });
    expect(storage.getObject(customizations, scope)).toEqual({ viewContainerLocations: { explorer: Panel } });
    expect(storage.getObject(panelOrder, scope)).toEqual(['output', 'explorer', 'problems']);

    views.moveViewContainerToLocation(problems, Panel, 0);
    expect(views.getViewContainersByLocation(Panel)).toEqual([problems, output, explorer]);
    expect(changes).toHaveBeenCalledTimes(2);
    write.mockClear();
    remove.mockClear();
    views.moveViewContainerToLocation(explorer, Panel);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(['{', 'null', '[]', '{}', '{"viewContainerLocations":{"explorer":7}}'])(
    'uses defaults for malformed stored locations %s and orders', value => {
      const explorer = register('explorer', Sidebar);
      const output = register('output', Panel);
      const problems = register('problems', Panel);
      store(customizations, value);
      store(panelOrder, ['problems', 2]);
      const views = disposables.add(new ViewDescriptorService(storage));
      expect(views.getViewContainerLocation(explorer)).toBe(Sidebar);
      expect(views.getViewContainersByLocation(Panel)).toEqual([output, problems]);
    },
  );

  it('preserves saved slots for unregistered containers and reuses them on late registration', () => {
    const explorer = register('explorer', Sidebar);
    const output = register('output', Panel);
    store(customizations, { viewContainerLocations: { late: Panel, explorer: Panel } });
    store(panelOrder, ['output', 'late', 'explorer']);
    const views = disposables.add(new ViewDescriptorService(storage));
    expect(views.getViewContainersByLocation(Panel)).toEqual([output, explorer]);

    views.moveViewContainerToLocation(explorer, Sidebar);
    expect(storage.getObject(customizations, scope)).toEqual({ viewContainerLocations: { late: Panel } });
    expect(storage.getObject(panelOrder, scope)).toEqual(['output', 'late']);
    const late = register('late', Sidebar);
    expect(views.getViewContainersByLocation(Panel)).toEqual([output, late]);

    viewContainersRegistry.deregisterViewContainer(late);
    expect(views.getViewContainerLocation(late)).toBeUndefined();
    expect(views.getViewContainersByLocation(Panel)).toEqual([output]);
    views.moveViewContainerToLocation(explorer, Panel);
    const reloaded = disposables.add(new ViewDescriptorService(storage));
    const returned = register('late', Sidebar);
    expect(reloaded.getViewContainersByLocation(Panel)).toEqual([output, returned, explorer]);
  });

  it('resets moves and reordering and removes all three saved keys', () => {
    const explorer = register('explorer', Sidebar);
    const search = register('search', Sidebar);
    const output = register('output', Panel);
    const problems = register('problems', Panel);
    const views = disposables.add(new ViewDescriptorService(storage));
    views.moveViewContainerToLocation(search, Sidebar, 0);
    views.moveViewContainerToLocation(output, Sidebar, 1);
    views.moveViewContainerToLocation(explorer, Panel, 0);
    expect(views.getViewContainersByLocation(Sidebar)).toEqual([search, output]);
    expect(views.getViewContainersByLocation(Panel)).toEqual([explorer, problems]);

    const changes = vi.fn();
    disposables.add(views.onDidChangeContainerLocation(changes));
    views.resetViewLocations();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(views.getViewContainersByLocation(Sidebar)).toEqual([explorer, search]);
    expect(views.getViewContainersByLocation(Panel)).toEqual([output, problems]);
    for (const key of [customizations, sidebarOrder, panelOrder]) {
      expect(storage.get(key, scope)).toBeUndefined();
    }
  });
});
