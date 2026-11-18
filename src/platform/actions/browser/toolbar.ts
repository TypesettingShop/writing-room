import { Menu, renderMenuIcon, runMenuAction } from '../../../base/browser/ui/menu/menu.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';
import { IMenuService, MenuItemAction, SubmenuItemAction } from '../common/actions.js';
import type { IMenuContext, MenuId } from '../common/actions.js';

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
    let remaining = menu.getActions().filter(([group]) => group !== 'navigation');
    let returnFocus: HTMLElement | null = null;

    const close = () => {
      if (this.popup.value) {
        this.popup.clear();
        overflow.setAttribute('aria-expanded', 'false');
        returnFocus?.focus({ preventScroll: true });
      }
    };

    const open = (anchor: HTMLButtonElement, groups: ReturnType<typeof menu.getActions>) => {
      if (this.popup.value) {
        close();
        return;
      }
      returnFocus = document.activeElement as HTMLElement | null;
      if (anchor === overflow) {
        overflow.setAttribute('aria-expanded', 'true');
      }
      this.popup.value = new Menu({
        container: layoutService.mainContainer,
        anchor,
        dismissalBoundary: toolbar,
        onClose: close,
      }, groups);
      this.popup.value.focus();
    };

    overflow.addEventListener('mousedown', event => event.preventDefault());
    overflow.addEventListener('click', () => open(overflow, remaining));

    const update = () => {
      const actions = menu.getActions();
      remaining = actions.filter(([group]) => group !== 'navigation');
      if (remaining.length > 0 && overflow.getAttribute('aria-expanded') === 'true') {
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
        if (action.icon) {
          button.append(renderMenuIcon(document, action.icon));
        } else {
          button.textContent = action.label;
        }
        if (action instanceof SubmenuItemAction) {
          button.setAttribute('aria-haspopup', 'menu');
          button.addEventListener('mousedown', event => event.preventDefault());
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
