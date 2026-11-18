import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Parts } from '../../../services/layout/browser/layoutService.js';
import { Part } from '../../part.js';
import { CustomMenubarControl } from './menubarControl.js';

export class TitlebarPart extends Part {
  override readonly minimumHeight = 30;
  override readonly maximumHeight = 30;

  constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
    super(Parts.TITLEBAR_PART);
  }

  protected override createContentArea(parent: HTMLElement): void {
    const title = parent.ownerDocument.createElement('span');
    title.className = 'workbench-title';
    title.append(...renderLabelWithIcons('$(edit) Writing Room'));
    parent.append(title);
    this.installMenubar(parent);
  }

  private installMenubar(parent: HTMLElement): void {
    const menubar = this._register(this.instantiationService.createInstance(CustomMenubarControl));
    menubar.installMenubar(parent);
  }
}
