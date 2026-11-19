import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IPaneCompositePartService } from '../../../browser/parts/paneCompositePartService.js';
import type { ViewPane } from '../../../browser/parts/views/viewPane.js';
import type { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewDescriptorService, viewsRegistry } from '../../../common/views.js';

export const IViewsService = createDecorator<IViewsService>('viewsService');

export interface IViewsService extends BrandedService {
  openView(id: string, focus?: boolean): Promise<ViewPane | null>;
  openViewContainer(id: string, focus?: boolean): Promise<ViewPaneContainer | null>;
}

export class ViewsService implements IViewsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IPaneCompositePartService private readonly parts: IPaneCompositePartService,
    @IContextKeyService private readonly contextKeyService: IContextKeyService,
    @IViewDescriptorService private readonly viewDescriptors: IViewDescriptorService,
  ) {}

  async openView(id: string, focus?: boolean): Promise<ViewPane | null> {
    const descriptor = viewsRegistry.getViewContainer(id);
    const view = descriptor && viewsRegistry.getViews(descriptor).find(view => view.id === id);
    if (!view || !this.contextKeyService.contextMatchesRules(view.when)) {
      return null;
    }
    const pane = this.openContainer(descriptor.id)?.getView(id);
    if (focus) {
      pane?.focus();
    }
    return pane ?? null;
  }

  async openViewContainer(id: string, focus?: boolean): Promise<ViewPaneContainer | null> {
    const container = this.openContainer(id);
    if (focus) {
      container?.focus();
    }
    return container ?? null;
  }

  private openContainer(id: string): ViewPaneContainer | undefined {
    const descriptor = this.viewDescriptors.getViewContainerById(id);
    const location = descriptor && this.viewDescriptors.getViewContainerLocation(descriptor);
    return location === undefined ? undefined : this.parts.openPaneComposite(id, location);
  }
}

registerSingleton(IViewsService, ViewsService);
