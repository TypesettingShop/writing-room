import { LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { Parts } from '../../../services/layout/browser/layoutService.js';
import { Part } from '../../part.js';

export class EditorPart extends Part {
  override readonly minimumWidth = 220;
  override readonly minimumHeight = 70;
  override readonly priority = LayoutPriority.High;

  constructor() {
    super(Parts.EDITOR_PART);
  }
}
