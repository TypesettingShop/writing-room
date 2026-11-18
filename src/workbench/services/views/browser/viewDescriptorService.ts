import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IViewDescriptorService, ViewContainerLocation, viewContainersRegistry } from '../../../common/views.js';
import type { IViewContainerLocationChangeEvent, ViewContainer } from '../../../common/views.js';

const scope = StorageScope.PROFILE;
const customizationsKey = 'views.customizations';
const orderKeys = {
  [ViewContainerLocation.Sidebar]: 'workbench.activity.pinnedViewlets2',
  [ViewContainerLocation.Panel]: 'workbench.panel.pinnedPanels',
};
const locations = [ViewContainerLocation.Sidebar, ViewContainerLocation.Panel] as const;

// The storage service reads malformed JSON and non-object values as absent.
function readJSON(storage: IStorageService, key: string): unknown {
  return storage.getObject<object>(key, scope);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocation(value: unknown): value is ViewContainerLocation {
  return value === ViewContainerLocation.Sidebar || value === ViewContainerLocation.Panel;
}

function readLocations(storage: IStorageService): Map<string, ViewContainerLocation> {
  const data = readJSON(storage, customizationsKey);
  if (isObject(data) && isObject(data.viewContainerLocations)) {
    const entries = Object.entries(data.viewContainerLocations);
    if (entries.every((entry): entry is [string, ViewContainerLocation] => !!entry[0] && isLocation(entry[1]))) {
      return new Map(entries);
    }
  }
  return new Map();
}

function readOrder(storage: IStorageService, location: ViewContainerLocation): string[] {
  const data = readJSON(storage, orderKeys[location]);
  if (!Array.isArray(data) || !data.every(id => typeof id === 'string' && id.length > 0)) {
    return [];
  }
  return [...new Set<string>(data)];
}

export class ViewDescriptorService extends Disposable implements IViewDescriptorService {
  declare readonly _serviceBrand: undefined;
  private readonly moved = this._register(new Emitter<IViewContainerLocationChangeEvent>());
  readonly onDidChangeContainerLocation = this.moved.event;
  readonly onDidRegister = viewContainersRegistry.onDidRegister;
  readonly onDidDeregister = viewContainersRegistry.onDidDeregister;
  private readonly customLocations: Map<string, ViewContainerLocation>;
  private readonly order: Record<ViewContainerLocation, string[]>;

  constructor(@IStorageService private readonly storage: IStorageService) {
    super();
    this.customLocations = readLocations(storage);
    this.order = {
      [ViewContainerLocation.Sidebar]: readOrder(storage, ViewContainerLocation.Sidebar),
      [ViewContainerLocation.Panel]: readOrder(storage, ViewContainerLocation.Panel),
    };
  }

  getViewContainerById(id: string): ViewContainer | undefined {
    return viewContainersRegistry.get(id);
  }

  getDefaultViewContainerLocation(container: ViewContainer): ViewContainerLocation | undefined {
    return viewContainersRegistry.getViewContainerLocation(container);
  }

  getViewContainerLocation(container: ViewContainer): ViewContainerLocation | undefined {
    const location = this.getDefaultViewContainerLocation(container);
    return location === undefined ? undefined : this.customLocations.get(container.id) ?? location;
  }

  getViewContainersByLocation(location: ViewContainerLocation): readonly ViewContainer[] {
    return this.orderedIds(location).flatMap(id => {
      const container = this.getViewContainerById(id);
      return container && this.getViewContainerLocation(container) === location ? [container] : [];
    });
  }

  moveViewContainerToLocation(container: ViewContainer, to: ViewContainerLocation, index?: number): void {
    const from = this.getViewContainerLocation(container);
    if (from === undefined || !isLocation(to)) {
      return;
    }
    const fromIndex = this.getViewContainersByLocation(from).indexOf(container);
    const destination = this.getViewContainersByLocation(to).filter(item => item !== container);
    const toIndex = index === undefined || !Number.isFinite(index)
      ? destination.length : Math.max(0, Math.min(Math.trunc(index), destination.length));
    if (from === to && fromIndex === toIndex) {
      return;
    }

    // Materialize implicit registered items before moving. Unknown IDs stay in their saved slots.
    const order = this.orderedIds(to).filter(id => id !== container.id);
    const next = destination[toIndex];
    order.splice(next ? order.indexOf(next.id) : order.length, 0, container.id);

    if (from !== to) {
      if (to === this.getDefaultViewContainerLocation(container)) {
        this.customLocations.delete(container.id);
      } else {
        this.customLocations.set(container.id, to);
      }
      this.save(customizationsKey, this.customLocations.size
        ? { viewContainerLocations: Object.fromEntries(this.customLocations) } : undefined);
      this.updateOrder(from, this.order[from].filter(id => id !== container.id));
    }
    this.updateOrder(to, order);
    this.moved.fire({ changes: [{ viewContainer: container, from, to, fromIndex }], reset: false });
  }

  resetViewLocations(): void {
    const changes = locations.flatMap(from =>
      this.getViewContainersByLocation(from).map((viewContainer, fromIndex) => ({
        viewContainer, from, to: this.getDefaultViewContainerLocation(viewContainer)!, fromIndex,
      })),
    );
    this.customLocations.clear();
    this.storage.remove(customizationsKey, scope);
    for (const location of locations) {
      this.order[location] = [];
      this.storage.remove(orderKeys[location], scope);
    }
    this.moved.fire({ changes, reset: true });
  }

  private orderedIds(location: ViewContainerLocation): string[] {
    const ids = new Set(this.order[location]);
    for (const container of viewContainersRegistry.all) {
      if (this.getViewContainerLocation(container) === location) {
        ids.add(container.id);
      }
    }
    return [...ids];
  }

  private updateOrder(location: ViewContainerLocation, order: string[]): void {
    const previous = this.order[location];
    if (previous.length !== order.length || previous.some((id, index) => id !== order[index])) {
      this.order[location] = order;
      this.save(orderKeys[location], order.length ? order : undefined);
    }
  }

  private save(key: string, value: object | undefined): void {
    if (value === undefined) {
      this.storage.remove(key, scope);
    } else {
      this.storage.store(key, value, scope, StorageTarget.USER);
    }
  }
}

registerSingleton(IViewDescriptorService, ViewDescriptorService);
