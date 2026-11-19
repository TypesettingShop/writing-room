import { Menu, renderMenuIcon, runMenuAction } from '../../../base/browser/ui/menu/menu.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';
import { IMenuService, MenuItemAction, SubmenuItemAction } from '../common/actions.js';
import type { IMenuContext, MenuActionGroup, MenuId } from '../common/actions.js';

function preserveFocusOnLeftPress(event: MouseEvent): void {
  if (event.button === 0) {
    event.preventDefault();
  }
}

export class MenuWorkbenchToolBar extends Disposable {
  private readonly popup = this._register(new MutableDisposable<Menu>());

  constructor(
    container: HTMLElement,
    menuId: MenuId,
    contextKeyService: IMenuContext,
    @IMenuService menuService: IMenuService,
    @ILayoutService layoutService: ILayoutService,
  ) {
    super();
    const document = container.ownerDocument;
    const toolbar = document.createElement('div');
    toolbar.className = 'wr-menu-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    const overflow = document.createElement('button');
    overflow.type = 'button';
    overflow.textContent = '…';
    overflow.setAttribute('aria-label', 'More Actions');
    overflow.setAttribute('aria-haspopup', 'menu');
    overflow.setAttribute('aria-expanded', 'false');
    toolbar.append(overflow);
    container.append(toolbar);
    this._register(toDisposable(() => toolbar.remove()));

    const menu = this._register(menuService.createMenu(menuId, contextKeyService));
    let remaining: MenuActionGroup[] = [];
    let returnFocus: HTMLElement | null = null;
    let opener: HTMLButtonElement | undefined;

    const close = () => {
      const popup = this.popup.value;
      if (popup) {
        const restore = popup.shouldReturnFocus();
        this.popup.clear();
        opener?.setAttribute('aria-expanded', 'false');
        opener = undefined;
        if (restore) {
          returnFocus?.focus({ preventScroll: true });
        }
      }
    };

    // Clicking the open popup's own button closes it; clicking another popup button switches to it.
    const open = (anchor: HTMLButtonElement, groups: MenuActionGroup[]) => {
      const toggled = anchor === opener;
      close();
      if (toggled) {
        return;
      }
      returnFocus = document.activeElement as HTMLElement | null;
      opener = anchor;
      anchor.setAttribute('aria-expanded', 'true');
      this.popup.value = new Menu({
        container: layoutService.mainContainer,
        anchor,
        dismissalBoundary: toolbar,
        onClose: close,
      }, groups);
      this.popup.value.focus();
    };

    overflow.addEventListener('mousedown', preserveFocusOnLeftPress);
    overflow.addEventListener('click', () => open(overflow, remaining));

    const update = () => {
      const actions = menu.getActions();
      remaining = actions.filter(([group]) => group !== 'navigation');
      if (remaining.length > 0 && opener === overflow) {
        this.popup.value?.update(remaining);
      } else {
        close();
      }
      overflow.hidden = remaining.length === 0;

      const focusedId = (document.activeElement as HTMLElement | null)?.dataset.menuAction;
      for (const button of [...toolbar.children]) {
        if (button !== overflow) {
          button.remove();
        }
      }
      for (const action of actions.find(([group]) => group === 'navigation')?.[1] ?? []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.menuAction = action.id;
        button.title = action.label;
        button.setAttribute('aria-label', action.label);
        button.disabled = !action.enabled;
        if (action instanceof MenuItemAction && action.checked !== undefined) {
          button.setAttribute('aria-pressed', String(action.checked));
        }
        const icon = action.icon && renderMenuIcon(document, action.icon);
        if (icon) {
          button.append(icon);
        } else {
          button.textContent = action.label;
        }
        if (action instanceof SubmenuItemAction) {
          button.setAttribute('aria-haspopup', 'menu');
          button.setAttribute('aria-expanded', 'false');
          button.addEventListener('mousedown', preserveFocusOnLeftPress);
          button.addEventListener('click', () => open(button, action.groups));
        } else {
          button.addEventListener('click', () => {
            close();
            void runMenuAction(action);
          });
        }
        toolbar.insertBefore(button, overflow);
        if (focusedId === action.id) {
          button.focus({ preventScroll: true });
        }
      }
    };
    update();
    this._register(menu.onDidChange(update));
  }
}
