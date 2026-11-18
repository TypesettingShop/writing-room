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

  constructor(private readonly sidebar: PaneCompositePart, private readonly panel: PaneCompositePart) {}

  openPaneComposite(id: string, location: ViewContainerLocation): ViewPaneContainer | undefined {
    const part = location === ViewContainerLocation.Sidebar ? this.sidebar : this.panel;
    return part.openPaneComposite(id);
  }
}
