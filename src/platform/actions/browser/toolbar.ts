import { Menu, renderMenuIcon, runMenuAction } from '../../../base/browser/ui/menu/menu.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';
import { IMenuService, MenuItemAction, SubmenuItemAction } from '../common/actions.js';
import type { IMenuContext, IMenuNumberInput, MenuActionGroup, MenuId } from '../common/actions.js';

function preserveFocusOnLeftPress(event: MouseEvent): void {
  if (event.button === 0) {
    event.preventDefault();
  }
}

function createNumberInput(document: Document, { min, max }: IMenuNumberInput) {
  const control = document.createElement('input');
  control.className = 'wr-menu-toolbar-number';
  control.type = 'number';
  control.min = String(min);
  control.max = String(max);
  control.required = true;
  let action: MenuItemAction;
  let committed = '';
  const apply = () => {
    const value = control.valueAsNumber;
    const changed = control.validity.valid && value !== Number(committed);
    control.value = committed;
    if (!control.disabled && changed) {
      void action.run(value).catch(error => console.error(error));
    }
  };
  control.addEventListener('blur', apply);
  control.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Enter') {
        apply();
      } else {
        control.value = committed;
      }
    }
  });
  return {
    control,
    update(next: MenuItemAction, value: number | undefined) {
      action = next;
      control.title = action.label;
      control.setAttribute('aria-label', action.label);
      const current = value === undefined ? '' : String(value);
      if (current !== committed || !action.enabled) {
        control.value = committed = current;
      }
      control.disabled = !action.enabled;
    },
  };
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
    const container = 'element' in target ? target.element : target;
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
    const inputs = new Map<string, ReturnType<typeof createNumberInput>>();
    const controls = () => [...toolbar.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-menu-action]')]
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
        if (index < 0 || available[index].tagName === 'INPUT') {
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
      const primary = actions.filter(([group]) => options || group === 'navigation');
      const nextControls = [];
      const inputIds = new Set<string>();
      for (const [group, items] of primary) {
        for (const action of items) {
          let control: HTMLButtonElement | HTMLInputElement;
          if (options && action instanceof MenuItemAction && action.numberInput) {
            const input = inputs.get(action.id) ?? createNumberInput(document, action.numberInput);
            inputs.set(action.id, input);
            inputIds.add(action.id);
            input.update(action, contextKeyService.getContextKeyValue?.<number>(action.numberInput.valueKey));
            control = input.control;
          } else {
            control = createControl(action);
          }
          control.dataset.menuAction = action.id;
          control.dataset.menuGroup = group;
          nextControls.push(control);
        }
      }
      for (const id of inputs.keys()) {
        if (!inputIds.has(id)) {
          inputs.delete(id);
        }
      }
      // Keep the active input in place when selection context rebuilds the surrounding buttons.
      const next = new Set<Element>(nextControls);
      for (const control of [...toolbar.children]) {
        if (control !== overflow && !next.has(control)) {
          control.remove();
        }
      }
      let anchor: HTMLElement = overflow;
      for (const control of nextControls.reverse()) {
        if (control.nextElementSibling !== anchor) {
          toolbar.insertBefore(control, anchor);
        }
        anchor = control;
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
      if (options && action instanceof MenuItemAction) {
        const shortcut = action.keybinding?.getLabel();
        if (shortcut) {
          button.title = `${action.label} (${shortcut})`;
          button.setAttribute('aria-description', action.keybinding?.getAriaLabel() ?? shortcut);
        }
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
          const value = document.createElement('span');
          const label = current?.label ?? action.item.selectFallback;
          value.className = 'wr-menu-toolbar-choice-label';
          value.textContent = label ?? '—';
          if (current instanceof MenuItemAction && current.labelClass) {
            value.classList.add(current.labelClass);
          }
          button.replaceChildren(value);
          if (label) {
            button.setAttribute('aria-description', label);
          }
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
