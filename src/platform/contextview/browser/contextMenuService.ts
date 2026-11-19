import { Menu } from '../../../base/browser/ui/menu/menu.js';
import type { MenuAction, MenuAnchor, MenuGroup } from '../../../base/browser/ui/menu/menu.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';

export interface IContextMenuDelegate {
  getAnchor(): MenuAnchor;
  getActions(): readonly MenuGroup[] | readonly MenuAction[];
  onHide?(): void;
}

export const IContextMenuService = createDecorator<IContextMenuService>('contextMenuService');

export interface IContextMenuService extends BrandedService {
  showContextMenu(delegate: IContextMenuDelegate): void;
  hideContextMenu(): void;
}

export class ContextMenuService extends Disposable implements IContextMenuService {
  declare readonly _serviceBrand: undefined;
  private readonly popup = this._register(new MutableDisposable<Menu>());
  private onHide: ((returnFocus: boolean) => void) | undefined;

  constructor(@ILayoutService private readonly layoutService: ILayoutService) { super(); }

  showContextMenu(delegate: IContextMenuDelegate): void {
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
    this.popup.value = new Menu({
      container,
      anchor: delegate.getAnchor(),
      onClose: () => this.hideContextMenu(),
    }, groups);
    this.popup.value.focus();
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
