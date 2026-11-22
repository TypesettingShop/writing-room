import { Menu } from '../../../base/browser/ui/menu/menu.js';
import type { MenuAction, MenuAnchor, MenuGroup } from '../../../base/browser/ui/menu/menu.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';

export interface IContextMenuDelegate {
  getAnchor(): MenuAnchor;
  getActions(): readonly MenuGroup[] | readonly MenuAction[];
  readonly label?: string;
  readonly horizontalGroup?: string;
  onHide?(): void;
}

export const IContextMenuService = createDecorator<IContextMenuService>('contextMenuService');

export interface IContextMenuService extends BrandedService {
  showContextMenu(delegate: IContextMenuDelegate): IDisposable | undefined;
  hideContextMenu(): void;
}

export class ContextMenuService extends Disposable implements IContextMenuService {
  declare readonly _serviceBrand: undefined;
  private readonly popup = this._register(new MutableDisposable<Menu>());
  private onHide: ((returnFocus: boolean) => void) | undefined;

  constructor(@ILayoutService private readonly layoutService: ILayoutService) { super(); }

  showContextMenu(delegate: IContextMenuDelegate): IDisposable | undefined {
    this.hideContextMenu();
    const actions = delegate.getActions();
    if (actions.length === 0) {
      return;
    }
    const groups = Array.isArray(actions[0]) ? actions as readonly MenuGroup[] : [['', actions as readonly MenuAction[]]] as const;
    const container = this.layoutService.mainContainer;
    const returnFocus = container.ownerDocument.activeElement as HTMLElement | null;
    this.onHide = restore => {
      if (restore) {
        returnFocus?.focus({ preventScroll: true });
      }
      delegate.onHide?.();
    };
    const popup = this.popup.value = new Menu({
      container,
      anchor: delegate.getAnchor(),
      label: delegate.label,
      horizontalGroup: delegate.horizontalGroup,
      onClose: () => this.hideContextMenu(),
    }, groups);
    popup.focus();
    return toDisposable(() => {
      if (this.popup.value === popup) this.hideContextMenu();
    });
  }

  hideContextMenu(): void {
    const onHide = this.onHide;
    this.onHide = undefined;
    const restore = this.popup.value?.shouldReturnFocus() ?? false;
    this.popup.clear();
    onHide?.(restore);
  }

  override dispose(): void {
    this.hideContextMenu();
    super.dispose();
  }
}

registerSingleton(IContextMenuService, ContextMenuService);
