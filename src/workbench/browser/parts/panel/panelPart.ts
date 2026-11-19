import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ActivePanelContext } from '../../../common/contextkeys.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import type { LayoutStateModel } from '../../layout.js';
import { CompositeBar } from '../compositeBar.js';
import { PaneCompositePart } from '../paneCompositePart.js';

export class PanelPart extends PaneCompositePart {
  override readonly minimumWidth = 300;
  override readonly minimumHeight = 77;

  constructor(
    state: LayoutStateModel,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
    @IViewDescriptorService viewDescriptors: IViewDescriptorService,
    @IStorageService storage: IStorageService,
  ) {
    super(Parts.PANEL_PART, ViewContainerLocation.Panel, state, 'activePanel',
      ActivePanelContext, contextKeyService, instantiationService, layoutService, viewDescriptors, storage, 'workbench.panelpart.activepanelid');
  }

  protected override createHeader(parent: HTMLElement): void {
    const bar = this._register(this.instantiationService.createInstance(
      CompositeBar, parent, this.location, (id: string) => this.openPaneComposite(id),
    ));
    this._register(this.onDidChangeComposites(() => bar.update(this.getVisibleViewContainers(), this.activeCompositeId)));
  }
}
