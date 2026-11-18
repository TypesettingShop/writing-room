import { Disposable, MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import { Menu } from './menu.js';
import type { MenuGroup } from './menu.js';

interface MenuBarItem {
  readonly id: string;
  readonly label: string;
  readonly groups: readonly MenuGroup[];
}

export class MenuBar extends Disposable {
  private readonly popup = this._register(new MutableDisposable<Menu>());
  private readonly element: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private items: readonly MenuBarItem[] = [];
  private opened: string | undefined;
  private returnFocus: HTMLElement | undefined;

  constructor(container: HTMLElement, private readonly overlayContainer: HTMLElement) {
    super();
    this.element = container.ownerDocument.createElement('div');
    this.element.className = 'wr-menubar';
    this.element.setAttribute('role', 'menubar');
    container.append(this.element);
    this._register(toDisposable(() => this.element.remove()));
  }

  update(items: readonly MenuBarItem[]): void {
    this.items = items;
    const current = new Set(items.map(item => item.id));
    if (this.opened && !current.has(this.opened)) {
      this.close();
    }
    for (const [id, button] of this.buttons) {
      if (!current.has(id)) {
        button.remove();
        this.buttons.delete(id);
      }
    }
    for (const [index, item] of items.entries()) {
      const button = this.buttons.get(item.id) ?? this.createButton(item.id);
      button.textContent = item.label;
      button.tabIndex = index === 0 ? 0 : -1;
      if (this.element.children[index] !== button) {
        this.element.insertBefore(button, this.element.children[index] ?? null);
      }
      if (item.id === this.opened) {
        this.popup.value?.update(item.groups);
      }
    }
  }

  private createButton(id: string): HTMLButtonElement {
    const button = this.element.ownerDocument.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('mousedown', event => {
      if (event.button === 0) {
        event.preventDefault();
      }
    });
    button.addEventListener('click', () => this.opened === id ? this.close() : this.open(id));
    button.addEventListener('mouseenter', () => {
      if (this.opened && this.opened !== id) {
        this.open(id);
      }
    });
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        this.open(id, event.key === 'ArrowUp');
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        this.buttons.get(this.adjacent(id, event.key === 'ArrowLeft' ? -1 : 1))?.focus();
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    });
    this.buttons.set(id, button);
    return button;
  }

  private adjacent(id: string, direction: -1 | 1): string {
    const index = this.items.findIndex(item => item.id === id);
    return this.items.at((index + direction) % this.items.length)!.id;
  }

  private open(id: string, last = false): void {
    const item = this.items.find(entry => entry.id === id);
    const button = this.buttons.get(id);
    if (!item || !button) {
      return;
    }
    if (this.opened) {
      this.buttons.get(this.opened)?.setAttribute('aria-expanded', 'false');
    } else {
      this.returnFocus = this.element.ownerDocument.activeElement as HTMLElement | undefined;
    }
    this.opened = id;
    button.setAttribute('aria-expanded', 'true');
    this.popup.value = new Menu({
      container: this.overlayContainer,
      anchor: button,
      label: item.label,
      dismissalBoundary: this.element,
      onClose: () => this.close(),
      onNavigate: direction => this.open(this.adjacent(id, direction)),
    }, item.groups);
    this.popup.value.focus(last);
  }

  private close(): void {
    if (this.opened) {
      this.buttons.get(this.opened)?.setAttribute('aria-expanded', 'false');
      this.opened = undefined;
      const restore = this.popup.value?.shouldReturnFocus() ?? false;
      this.popup.clear();
      if (restore) {
        this.returnFocus?.focus({ preventScroll: true });
      }
      this.returnFocus = undefined;
    }
  }

  override dispose(): void {
    this.close();
    super.dispose();
  }
}
