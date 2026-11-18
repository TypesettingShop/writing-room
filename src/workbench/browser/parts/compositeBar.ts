import { renderMenuIcon } from '../../../base/browser/ui/menu/menu.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { ViewContainer } from '../../common/views.js';

export class CompositeBar extends Disposable {
  private readonly element: HTMLElement;
  private readonly buttons = new Map<ViewContainer, HTMLButtonElement>();

  constructor(
    parent: HTMLElement,
    private readonly icons: boolean,
    private readonly select: (id: string) => void,
  ) {
    super();
    this.element = parent.ownerDocument.createElement('div');
    this.element.className = 'composite-bar';
    this.element.setAttribute('role', icons ? 'toolbar' : 'tablist');
    this.element.setAttribute('aria-label', icons ? 'Activity Bar' : 'Panel views');
    parent.append(this.element);
    this._register(toDisposable(() => this.element.remove()));
  }

  update(containers: readonly ViewContainer[], activeId: string | undefined): void {
    for (const [container, button] of this.buttons) {
      if (!containers.includes(container)) {
        button.remove();
        this.buttons.delete(container);
      }
    }
    containers.forEach((container, index) => {
      let button = this.buttons.get(container);
      if (!button) {
        button = this.createButton(container);
        this.buttons.set(container, button);
      }
      const atIndex = this.element.children[index];
      if (atIndex !== button) {
        this.element.insertBefore(button, atIndex ?? null);
      }
      button.setAttribute(this.icons ? 'aria-pressed' : 'aria-selected', String(container.id === activeId));
      if (!this.icons) {
        button.tabIndex = container.id === activeId ? 0 : -1;
      }
    });
  }

  private createButton(container: ViewContainer): HTMLButtonElement {
    const document = this.element.ownerDocument;
    const button = document.createElement('button');
    button.type = 'button';
    button.title = container.title;
    button.setAttribute('aria-label', container.title);
    if (this.icons) {
      const icon = typeof container.icon === 'string' ? ThemeIcon.fromString(container.icon) ?? container.icon : container.icon;
      const element = icon && renderMenuIcon(document, icon);
      button.append(element || container.title.slice(0, 1));
    } else {
      button.setAttribute('role', 'tab');
      button.textContent = container.title;
      button.addEventListener('keydown', event => this.navigate(event, button));
    }
    button.addEventListener('click', () => this.select(container.id));
    return button;
  }

  private navigate(event: KeyboardEvent, button: HTMLButtonElement): void {
    const tabs = Array.from(this.element.children) as HTMLButtonElement[];
    const index = tabs.indexOf(button);
    let next: HTMLButtonElement;
    switch (event.key) {
      case 'ArrowLeft': next = tabs[(index + tabs.length - 1) % tabs.length]; break;
      case 'ArrowRight': next = tabs[(index + 1) % tabs.length]; break;
      case 'Home': next = tabs[0]; break;
      case 'End': next = tabs[tabs.length - 1]; break;
      default: return;
    }
    event.preventDefault();
    next.click();
    next.focus();
  }
}
