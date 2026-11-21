import { addDisposableListener } from '../../dom.js';
import { renderIcon } from '../iconLabel/iconLabels.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import { DeferredIcon } from '../../../common/themables.js';
import type { ThemeIcon } from '../../../common/themables.js';
import './menu.css';

export interface MenuAction {
  readonly id: string;
  readonly label: string;
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly icon?: ThemeIcon | string | URL;
  readonly labelClass?: string;
  readonly keybinding?: { getLabel(): string | null; getAriaLabel(): string | null };
  readonly groups?: readonly MenuGroup[];
  run?(): unknown;
}

export type MenuGroup = readonly [group: string, actions: readonly MenuAction[]];
export type MenuAnchor = HTMLElement | { readonly x: number; readonly y: number };

export interface MenuOptions {
  readonly container: HTMLElement;
  readonly anchor: MenuAnchor;
  readonly label?: string;
  readonly radioItems?: boolean;
  readonly onClose: () => void;
  readonly onNavigate?: (direction: -1 | 1) => void;
  readonly dismissalBoundary?: HTMLElement;
}

export function renderMenuIcon(document: Document, icon: NonNullable<MenuAction['icon']>): HTMLElement | undefined {
  if (icon instanceof DeferredIcon) {
    const fallback = renderIcon({ id: 'extensions' });
    const element = document.createElement('span');
    element.className = 'wr-menu-icon wr-deferred-icon';
    element.style.backgroundImage = `var(${icon.styleProperty}, none)`;
    element.setAttribute('aria-hidden', 'true');
    if (fallback) {
      fallback.style.display = `var(${icon.styleProperty}-fallback, inline-block)`;
      element.append(fallback);
    }
    return element;
  }
  if (typeof icon === 'string' || !('id' in icon)) {
    const image = document.createElement('img');
    image.className = 'wr-menu-icon';
    image.src = String(icon);
    image.alt = '';
    image.draggable = false;
    return image;
  }
  const glyph = renderIcon(icon);
  glyph?.classList.add('wr-menu-icon');
  return glyph;
}

export async function runMenuAction(action: MenuAction): Promise<void> {
  try {
    await action.run?.();
  } catch (error) {
    console.error(error);
  }
}

interface MenuRow {
  readonly button: HTMLButtonElement;
  readonly action: MenuAction;
}

export class Menu extends Disposable {
  readonly element: HTMLElement;
  private readonly child = this._register(new MutableDisposable<Menu>());
  private childRow: MenuRow | undefined;
  private rows: MenuRow[] = [];

  constructor(
    private readonly options: MenuOptions,
    groups: readonly MenuGroup[],
    private readonly parent?: Menu,
  ) {
    super();
    const { container, label } = options;
    const document = container.ownerDocument;
    this.element = document.createElement('div');
    this.element.className = 'wr-menu';
    this.element.setAttribute('role', 'menu');
    this.element.tabIndex = -1;
    if (label) {
      this.element.setAttribute('aria-label', label);
    }
    container.append(this.element);
    this._register(toDisposable(() => this.element.remove()));
    this.element.addEventListener('keydown', this.onKeyDown);

    if (!parent) {
      const dismiss = (event: MouseEvent) => {
        const path = event.composedPath();
        if (!this.contains(path) && (!options.dismissalBoundary || !path.includes(options.dismissalBoundary))) {
          options.onClose();
        }
      };
      this._register(addDisposableListener(document, 'click', dismiss, true));
      this._register(addDisposableListener(document, 'contextmenu', dismiss, true));
      if (document.defaultView) {
        this._register(addDisposableListener(document.defaultView, 'resize', () => this.position()));
      }
    }

    this.update(groups);
  }

  update(groups: readonly MenuGroup[]): void {
    const focused = this.element.ownerDocument.activeElement;
    const focusedId = this.rows.find(row => row.button === focused)?.action.id ?? this.childRow?.action.id;
    const hadFocus = this.element.contains(focused) || Boolean(this.childRow);
    this.closeChild();
    this.rows = [];
    this.element.replaceChildren();

    for (const [, actions] of groups) {
      if (actions.length === 0) {
        continue;
      }
      if (this.rows.length > 0) {
        const separator = this.element.ownerDocument.createElement('div');
        separator.setAttribute('role', 'separator');
        this.element.append(separator);
      }
      for (const action of actions) {
        this.appendRow(action);
      }
    }
    this.position();
    if (hadFocus) {
      const matching = this.rows.find(row => row.action.id === focusedId && row.action.enabled !== false);
      matching ? matching.button.focus() : this.focus();
    }
  }

  /**
   * Whether closing this menu should send focus back to where it was: true while focus is inside the menu or
   * nowhere in particular, false once the user has moved it elsewhere (for example by clicking another input).
   */
  shouldReturnFocus(): boolean {
    const { activeElement, body } = this.element.ownerDocument;
    return !activeElement || activeElement === body || this.hasFocus();
  }

  private hasFocus(): boolean {
    return this.element.contains(this.element.ownerDocument.activeElement) || (this.child.value?.hasFocus() ?? false);
  }

  focus(last = false): void {
    const enabled = this.rows.filter(row => row.action.enabled !== false);
    (enabled.at(last ? -1 : 0)?.button ?? this.element).focus();
  }

  private appendRow(action: MenuAction): void {
    const document = this.element.ownerDocument;
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    const checkRole = this.options.radioItems ? 'menuitemradio' : 'menuitemcheckbox';
    button.setAttribute('role', action.checked === undefined ? 'menuitem' : checkRole);
    button.setAttribute('aria-disabled', String(action.enabled === false));
    if (action.checked !== undefined) {
      button.setAttribute('aria-checked', String(action.checked));
      const check = document.createElement('span');
      check.setAttribute('aria-hidden', 'true');
      check.textContent = action.checked ? '✓' : '';
      button.append(check);
    }
    const icon = action.icon && renderMenuIcon(document, action.icon);
    if (icon) {
      button.append(icon);
    }
    const label = document.createElement('span');
    label.textContent = action.label;
    if (action.labelClass) {
      label.classList.add(action.labelClass);
    }
    button.append(label);
    button.setAttribute('aria-label', action.label);
    const keybinding = action.keybinding?.getLabel();
    if (keybinding) {
      const shortcut = document.createElement('span');
      shortcut.className = 'wr-menu-shortcut';
      shortcut.textContent = keybinding;
      shortcut.setAttribute('aria-hidden', 'true');
      button.append(shortcut);
      button.setAttribute('aria-description', action.keybinding?.getAriaLabel() ?? keybinding);
    }
    if (action.groups) {
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      const arrow = document.createElement('span');
      arrow.className = 'wr-menu-shortcut';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '›';
      button.append(arrow);
    }
    const row = { button, action };
    this.rows.push(row);
    button.addEventListener('click', () => this.activate(row));
    button.addEventListener('mouseenter', () => {
      if (action.enabled !== false) {
        if (this.childRow !== row) {
          this.closeChild();
        }
        button.focus({ preventScroll: true });
      }
    });
    this.element.append(button);
  }

  private activate(row: MenuRow): void {
    if (row.action.enabled === false) {
      return;
    }
    if (row.action.groups) {
      this.openChild(row);
    } else {
      this.options.onClose();
      void runMenuAction(row.action);
    }
  }

  private openChild(row: MenuRow): void {
    if (row !== this.childRow) {
      this.closeChild();
      this.childRow = row;
      row.button.setAttribute('aria-expanded', 'true');
      this.child.value = new Menu({
        container: this.options.container,
        anchor: row.button,
        label: row.action.label,
        onClose: this.options.onClose,
        onNavigate: this.options.onNavigate,
      }, row.action.groups ?? [], this);
    }
    this.child.value?.focus();
  }

  private closeChild(): void {
    this.childRow?.button.setAttribute('aria-expanded', 'false');
    this.childRow = undefined;
    this.child.clear();
  }

  private contains(path: EventTarget[]): boolean {
    return path.includes(this.element) || (this.child.value?.contains(path) ?? false);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const active = this.rows.find(row => row.button === this.element.ownerDocument.activeElement);
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        this.closeChild();
        const enabled = this.rows.filter(row => row.action.enabled !== false);
        const index = active ? enabled.indexOf(active) : -1;
        const next = event.key === 'ArrowDown' ? index + 1 : (index < 0 ? -1 : index - 1);
        if (enabled.length) {
          enabled.at(next % enabled.length)?.button.focus();
        }
        break;
      }
      case 'ArrowRight':
        if (active?.action.groups && active.action.enabled !== false) {
          this.openChild(active);
        } else {
          this.options.onNavigate?.(1);
        }
        break;
      case 'ArrowLeft':
        if (this.parent) {
          const opener = this.parent.childRow?.button;
          this.parent.closeChild();
          opener?.focus();
        } else {
          this.options.onNavigate?.(-1);
        }
        break;
      case 'Enter':
        if (active) {
          this.activate(active);
        }
        break;
      case 'Escape':
        this.options.onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  private position(): void {
    const { anchor, container } = this.options;
    const { ownerDocument } = container;
    const view = ownerDocument.defaultView!;
    const rect = container.getBoundingClientRect();
    const viewport = container === ownerDocument.body;
    const left = viewport ? 0 : Math.max(0, rect.left);
    const top = viewport ? 0 : Math.max(0, rect.top);
    const right = viewport ? view.innerWidth : Math.min(view.innerWidth, rect.right);
    const bottom = viewport ? view.innerHeight : Math.min(view.innerHeight, rect.bottom);
    this.element.style.maxWidth = Math.max(0, right - left) + 'px';
    this.element.style.maxHeight = Math.max(0, bottom - top) + 'px';

    const bounds = 'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect()
      : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const { width, height } = this.element.getBoundingClientRect();
    let x = this.parent ? bounds.right : bounds.left;
    let y = this.parent ? bounds.top : bounds.bottom;
    if (x + width > right) {
      x = this.parent ? bounds.left - width : bounds.right - width;
    }
    if (!this.parent && y + height > bottom) {
      y = bounds.top - height;
    }
    this.element.style.left = Math.max(left, Math.min(x, right - width)) + 'px';
    this.element.style.top = Math.max(top, Math.min(y, bottom - height)) + 'px';
    this.child.value?.position();
  }
}
