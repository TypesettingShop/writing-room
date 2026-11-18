import { LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ActiveViewletContext } from '../../../common/contextkeys.js';
import { ViewContainerLocation, viewContainersRegistry } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import type { LayoutStateModel } from '../../layout.js';
import { PaneCompositePart } from '../paneCompositePart.js';

export class SidebarPart extends PaneCompositePart {
  override readonly minimumWidth = 170;
  override readonly priority = LayoutPriority.Low;

  constructor(
    state: LayoutStateModel,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
  ) {
    super(Parts.SIDEBAR_PART, ViewContainerLocation.Sidebar, state, 'activeViewlet',
      ActiveViewletContext, contextKeyService, instantiationService, layoutService);
  }

  protected override createHeader(parent: HTMLElement): void {
    const title = parent.ownerDocument.createElement('h2');
    parent.append(title);
    this._register(this.onDidChangeComposites(() => {
      const id = this.activeCompositeId;
      title.textContent = id ? viewContainersRegistry.get(id)?.title ?? '' : '';
    }));
  }
}
