import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../platform/instantiation/common/instantiation.js';
import { ViewContainerLocation } from '../../common/views.js';
import type { PaneCompositePart } from './paneCompositePart.js';
import type { ViewPaneContainer } from './views/viewPaneContainer.js';

export const IPaneCompositePartService = createDecorator<IPaneCompositePartService>('paneCompositePartService');

export interface IPaneCompositePartService extends BrandedService {
  openPaneComposite(id: string, location: ViewContainerLocation): ViewPaneContainer | undefined;
}

export class PaneCompositePartService implements IPaneCompositePartService {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly sidebar: PaneCompositePart,
    private readonly panel: PaneCompositePart,
  ) {
    sidebar.bindContainerLocations(({ changes, reset }) => {
      const affected = new Set(changes.flatMap(({ from, to }) => [this.partAt(from), this.partAt(to)]));
      // Reparenting can change focus and its context keys before both parts have their new panes.
      for (const part of affected) {
        part.beginCompositeTransfer();
      }
      try {
        for (const { viewContainer, from, to } of changes) {
          if (from !== to) {
            const container = this.partAt(from).detachComposite(viewContainer);
            if (container) {
              this.partAt(to).attachComposite(container);
            }
          }
        }
      } finally {
        // Every part must leave the transfer, even when another part fails to refresh.
        const errors: unknown[] = [];
        for (const part of affected) {
          try {
            part.updateContainerLocations(changes, reset);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Parts failed to update container locations');
        }
      }
    });
  }

  openPaneComposite(id: string, location: ViewContainerLocation): ViewPaneContainer | undefined {
    return this.partAt(location).openPaneComposite(id);
  }

  private partAt(location: ViewContainerLocation): PaneCompositePart {
    return location === ViewContainerLocation.Sidebar ? this.sidebar : this.panel;
  }
}
