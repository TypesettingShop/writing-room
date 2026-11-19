import type { Event } from '../../base/common/event.js';
import { Emitter } from '../../base/common/event.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';
import type { ContextKeyExpression } from '../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../platform/registry/common/platform.js';

export const Extensions = {
  ViewContainersRegistry: 'workbench.registry.view.containers',
  ViewsRegistry: 'workbench.registry.view',
};

export enum ViewContainerLocation {
  Sidebar,
  Panel,
}

export const ViewContainerLocationContext = new RawContextKey<ViewContainerLocation | undefined>(
  'viewContainerLocation', undefined,
);

export interface ViewContainer {
  readonly id: string;
  readonly title: string;
  readonly icon?: string | URL;
}

export interface IViewBody extends Partial<IDisposable> {
  layoutBody?(height: number, width: number): void;
}

export interface IViewDescriptor {
  readonly id: string;
  readonly name: string;
  readonly when?: ContextKeyExpression;
  readonly renderBody: (parent: HTMLElement) => IViewBody | void;
}

export interface IViewContainersRegistry {
  readonly onDidRegister: ViewContainersRegistry['onDidRegister'];
  readonly onDidDeregister: ViewContainersRegistry['onDidDeregister'];
  readonly all: readonly ViewContainer[];
  registerViewContainer(descriptor: ViewContainer, location: ViewContainerLocation): ViewContainer;
  deregisterViewContainer(container: ViewContainer): void;
  get(id: string): ViewContainer | undefined;
  getViewContainerLocation(container: ViewContainer): ViewContainerLocation | undefined;
}

class ViewContainersRegistry implements IViewContainersRegistry {
  private readonly entries = new Map<string, { container: ViewContainer; location: ViewContainerLocation }>();
  private readonly didRegister = new Emitter<{ viewContainer: ViewContainer; viewContainerLocation: ViewContainerLocation }>();
  private readonly didDeregister = new Emitter<{ viewContainer: ViewContainer; viewContainerLocation: ViewContainerLocation }>();
  readonly onDidRegister = this.didRegister.event;
  readonly onDidDeregister = this.didDeregister.event;

  get all(): readonly ViewContainer[] {
    return [...this.entries.values()].map(({ container }) => container);
  }

  registerViewContainer(container: ViewContainer, location: ViewContainerLocation): ViewContainer {
    const registered = this.get(container.id);
    if (registered) {
      return registered;
    }
    this.entries.set(container.id, { container, location });
    this.didRegister.fire({ viewContainer: container, viewContainerLocation: location });
    return container;
  }

  deregisterViewContainer(container: ViewContainer): void {
    const entry = this.entries.get(container.id);
    if (entry?.container === container) {
      this.entries.delete(container.id);
      this.didDeregister.fire({ viewContainer: container, viewContainerLocation: entry.location });
    }
  }

  get(id: string): ViewContainer | undefined {
    return this.entries.get(id)?.container;
  }

  getViewContainerLocation(container: ViewContainer): ViewContainerLocation | undefined {
    const entry = this.entries.get(container.id);
    return entry?.container === container ? entry.location : undefined;
  }
}

export interface IViewsRegistry {
  readonly onViewsRegistered: ViewsRegistry['onViewsRegistered'];
  readonly onViewsDeregistered: ViewsRegistry['onViewsDeregistered'];
  registerViews(views: readonly IViewDescriptor[], container: ViewContainer): void;
  deregisterViews(views: readonly IViewDescriptor[], container: ViewContainer): void;
  getViews(container: ViewContainer): readonly IViewDescriptor[];
  getViewContainer(viewId: string): ViewContainer | undefined;
}

class ViewsRegistry implements IViewsRegistry {
  private readonly locations = new Map<string, ViewContainer>();
  private readonly viewsByContainer = new Map<ViewContainer, IViewDescriptor[]>();
  private readonly didRegister = new Emitter<{ views: readonly IViewDescriptor[]; viewContainer: ViewContainer }>();
  private readonly didDeregister = new Emitter<{ views: readonly IViewDescriptor[]; viewContainer: ViewContainer }>();
  readonly onViewsRegistered = this.didRegister.event;
  readonly onViewsDeregistered = this.didDeregister.event;

  registerViews(views: readonly IViewDescriptor[], container: ViewContainer): void {
    if (viewContainersRegistry.get(container.id) !== container) {
      throw new Error(`Unknown view container: ${container.id}.`);
    }
    const registered = this.viewsByContainer.get(container) ?? [];
    const added: IViewDescriptor[] = [];
    for (const view of views) {
      if (!this.locations.has(view.id)) {
        this.locations.set(view.id, container);
        added.push(view);
      }
    }
    if (added.length) {
      this.viewsByContainer.set(container, [...registered, ...added]);
      this.didRegister.fire({ views: added, viewContainer: container });
    }
  }

  deregisterViews(views: readonly IViewDescriptor[], container: ViewContainer): void {
    const removing = new Set(views);
    const current = this.getViews(container);
    const removed = current.filter(view => removing.has(view));
    if (removed.length) {
      for (const { id } of removed) {
        this.locations.delete(id);
      }
      const remaining = current.filter(view => !removing.has(view));
      if (remaining.length) {
        this.viewsByContainer.set(container, remaining);
      } else {
        this.viewsByContainer.delete(container);
      }
      this.didDeregister.fire({ views: removed, viewContainer: container });
    }
  }

  getViews(container: ViewContainer): readonly IViewDescriptor[] {
    return this.viewsByContainer.get(container) ?? [];
  }

  getViewContainer(viewId: string): ViewContainer | undefined {
    return this.locations.get(viewId);
  }
}

export const viewContainersRegistry: IViewContainersRegistry = new ViewContainersRegistry();
export const viewsRegistry: IViewsRegistry = new ViewsRegistry();
viewContainersRegistry.onDidDeregister(({ viewContainer }) => {
  viewsRegistry.deregisterViews(viewsRegistry.getViews(viewContainer), viewContainer);
});
Registry.add(Extensions.ViewContainersRegistry, viewContainersRegistry);
Registry.add(Extensions.ViewsRegistry, viewsRegistry);

export const IViewDescriptorService = createDecorator<IViewDescriptorService>('viewDescriptorService');

export interface IViewContainerLocationChange {
  readonly viewContainer: ViewContainer;
  readonly from: ViewContainerLocation;
  readonly to: ViewContainerLocation;
  readonly fromIndex: number;
}

export interface IViewContainerLocationChangeEvent {
  readonly changes: readonly IViewContainerLocationChange[];
  readonly reset: boolean;
}

export interface IViewDescriptorService extends BrandedService {
  /** The registry's events without its registered location: ask `getViewContainerLocation` for where a container is. */
  readonly onDidRegister: Event<{ readonly viewContainer: ViewContainer }>;
  readonly onDidDeregister: Event<{ readonly viewContainer: ViewContainer }>;
  readonly onDidChangeContainerLocation: Event<IViewContainerLocationChangeEvent>;
  getViewContainerById(id: string): ViewContainer | undefined;
  getViewContainerLocation(container: ViewContainer): ViewContainerLocation | undefined;
  getDefaultViewContainerLocation(container: ViewContainer): ViewContainerLocation | undefined;
  getViewContainersByLocation(location: ViewContainerLocation): readonly ViewContainer[];
  /** Index in the destination after removing the source item. Defaults to append. */
  moveViewContainerToLocation(container: ViewContainer, location: ViewContainerLocation, index?: number): void;
  /** Forgets saved placements for permanently removed containers. */
  forgetViewContainerPlacements(ids: readonly string[]): void;
  resetViewLocations(): void;
}
