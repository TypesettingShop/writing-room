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
    target: HTMLElement | { readonly element: HTMLElement; readonly ariaLabel: string },
    menuId: MenuId,
    contextKeyService: IMenuContext,
    @IMenuService menuService: IMenuService,
    @ILayoutService layoutService: ILayoutService,
  ) {
    super();
    const options = 'element' in target ? target : undefined;
    const container = options?.element ?? target as HTMLElement;
    const document = container.ownerDocument;
    const toolbar = document.createElement('div');
    toolbar.className = 'wr-menu-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    if (options) {
      toolbar.setAttribute('aria-label', options.ariaLabel);
    }
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
    const open = (anchor: HTMLButtonElement, groups: MenuActionGroup[], label?: string, radioItems?: boolean) => {
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
        label,
        radioItems,
        dismissalBoundary: toolbar,
        onClose: close,
      }, groups);
      this.popup.value.focus();
    };

    overflow.addEventListener('mousedown', preserveFocusOnLeftPress);
    overflow.addEventListener('click', () => open(overflow, remaining));

    let tabStop: string | undefined;
    const controls = () => [...toolbar.querySelectorAll<HTMLButtonElement>('[data-menu-action]')]
      .filter(control => !control.disabled && !control.hidden);
    const setTabStop = (control: HTMLElement | undefined) => {
      tabStop = control?.dataset.menuAction;
      for (const candidate of controls()) {
        candidate.tabIndex = candidate === control ? 0 : -1;
      }
    };
    if (options) {
      toolbar.addEventListener('focusin', event => {
        if (event.target instanceof HTMLElement) {
          setTabStop(event.target);
        }
      });
      toolbar.addEventListener('keydown', event => {
        const available = controls();
        const index = available.findIndex(control => control === event.target);
        if (index < 0) {
          return;
        }
        const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (direction) {
          event.preventDefault();
          available[(index + direction + available.length) % available.length].focus();
        }
      });
    }

    const update = () => {
      const actions = menu.getActions();
      remaining = options ? [] : actions.filter(([group]) => group !== 'navigation');
      if (remaining.length > 0 && opener === overflow) {
        this.popup.value?.update(remaining);
      } else {
        close();
      }
      overflow.hidden = remaining.length === 0;

      const active = document.activeElement as HTMLElement | null;
      const focusedId = toolbar.contains(active) ? active?.dataset.menuAction : undefined;
      for (const control of [...toolbar.children]) {
        if (control !== overflow) {
          control.remove();
        }
      }
      const primary = actions.filter(([group]) => options || group === 'navigation');
      for (const [group, items] of primary) {
        for (const action of items) {
          const control = createControl(action);
          control.dataset.menuAction = action.id;
          control.dataset.menuGroup = group;
          toolbar.insertBefore(control, overflow);
        }
      }
      const available = controls();
      const focused = available.find(control => control.dataset.menuAction === focusedId);
      if (options) {
        setTabStop(focused ?? available.find(control => control.dataset.menuAction === tabStop) ?? available[0]);
      }
      (focused ?? (focusedId && options ? available.find(control => control.tabIndex === 0) : undefined))
        ?.focus({ preventScroll: true });
    };

    const createControl = (action: MenuActionGroup[1][number]) => {
      const button = document.createElement('button');
      button.type = 'button';
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
        if (action.item.select) {
          const choices = action.groups.flatMap(([, items]) => items);
          const current = choices.find(item => item instanceof MenuItemAction && item.checked);
          button.textContent = `${action.label}: ${current?.label ?? '—'}`;
          button.setAttribute('aria-label', current ? `${action.label}: ${current.label}` : action.label);
          button.classList.add('wr-menu-toolbar-choices');
          button.disabled = choices.every(item => !item.enabled);
          const arrow = renderMenuIcon(document, { id: 'chevron-down' });
          if (arrow) {
            button.append(arrow);
          }
        }
        button.addEventListener('mousedown', preserveFocusOnLeftPress);
        button.addEventListener('click', () => open(button, action.groups, action.label, action.item.select));
      } else {
        if (options) {
          button.addEventListener('mousedown', preserveFocusOnLeftPress);
        }
        button.addEventListener('click', () => {
          close();
          void runMenuAction(action);
        });
      }
      return button;
    };
    update();
    let pending = false;
    this._register(menu.onDidChange(() => {
      if (!options) {
        update();
      } else if (!pending) {
        pending = true;
        queueMicrotask(() => {
          pending = false;
          if (toolbar.parentNode === container) {
            update();
          }
        });
      }
    }));
  }
}
