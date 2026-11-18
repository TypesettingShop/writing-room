import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { Part } from '../../part.js';
import { CompositeBar } from '../compositeBar.js';
import type { SidebarPart } from '../sidebar/sidebarPart.js';

export class ActivitybarPart extends Part {
  override readonly minimumWidth = 48;
  override readonly maximumWidth = 48;

  constructor(
    private readonly sidebar: SidebarPart,
    @IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
  ) {
    super(Parts.ACTIVITYBAR_PART);
  }

  protected override createContentArea(parent: HTMLElement): void {
    const bar = this._register(new CompositeBar(parent, true, id => {
      if (this.sidebar.activeCompositeId === id) {
        this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
      } else {
        this.sidebar.openPaneComposite(id);
      }
    }));
    this._register(this.sidebar.onDidChangeComposites(() => bar.update(
      this.sidebar.getVisibleViewContainers(), this.sidebar.activeCompositeId,
    )));
  }
}
