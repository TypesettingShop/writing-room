import { addDisposableListener } from '../../../base/browser/dom.js';
import { renderMenuIcon } from '../../../base/browser/ui/menu/menu.js';
import type { MenuAnchor, MenuGroup } from '../../../base/browser/ui/menu/menu.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { IMenuService, MenuId, MenuItemAction } from '../../../platform/actions/common/actions.js';
import type { MenuActionGroup } from '../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextMenuService.js';
import { IViewDescriptorService, ViewContainerLocation, ViewContainerLocationContext } from '../../common/views.js';
import type { ViewContainer } from '../../common/views.js';
import { CompositeDragAndDropObserver, DraggedCompositeIdentifier } from '../dnd.js';

interface CompositeInsertion {
  readonly relativeTo?: ViewContainer;
  readonly marker: HTMLElement;
  readonly position: 'before' | 'after' | 'empty' | 'body';
}

export class CompositeDragAndDrop {
  constructor(private readonly views: IViewDescriptorService, private readonly location: ViewContainerLocation) {}

  registerTarget(element: HTMLElement, getInsertion: (from: ViewContainerLocation, event: DragEvent) => CompositeInsertion | undefined) {
    let marker: HTMLElement | undefined;
    const clearMarker = () => {
      marker?.removeAttribute('data-view-drop-position');
      marker = undefined;
    };
    const resolve = (event: DragEvent, id: string) => {
      const container = this.views.getViewContainerById(id);
      const from = container && this.views.getViewContainerLocation(container);
      if (!container || from === undefined) {
        return undefined;
      }
      const insertion = getInsertion(from, event);
      if (!insertion || insertion.relativeTo === container) {
        return undefined;
      }
      const ordered = this.views.getViewContainersByLocation(this.location);
      const remaining = ordered.filter(item => item !== container);
      let index = remaining.length;
      if (insertion.relativeTo) {
        const reference = remaining.indexOf(insertion.relativeTo);
        if (reference < 0) {
          return undefined;
        }
        index = reference + (insertion.position === 'after' ? 1 : 0);
      }
      if (from === this.location && ordered.indexOf(container) === index) {
        return undefined;
      }
      return { container, insertion, index };
    };
    return CompositeDragAndDropObserver.INSTANCE.registerTarget(element, {
      onDragOver: (event, { id }) => {
        const drop = resolve(event, id);
        if (!drop) {
          return false;
        }
        if (marker !== drop.insertion.marker) {
          clearMarker();
          marker = drop.insertion.marker;
        }
        marker.setAttribute('data-view-drop-position', drop.insertion.position);
        return true;
      },
      onDragLeave: clearMarker,
      onDrop: (event, { id }) => {
        const drop = resolve(event, id);
        if (drop) {
          this.views.moveViewContainerToLocation(drop.container, this.location, drop.index);
        }
      },
    });
  }
}

function bindMenuArguments(groups: MenuActionGroup[], id: string): MenuGroup[] {
  return groups.map(([group, actions]) => [group, actions.map(action => action instanceof MenuItemAction
    ? { ...action, run: () => action.run(id) }
    : { ...action, groups: bindMenuArguments(action.groups, id) })]);
}

export class CompositeBar extends Disposable {
  private readonly element: HTMLElement;
  private readonly buttons = new Map<ViewContainer, { element: HTMLButtonElement; listeners: DisposableStore }>();
  private readonly buttonListeners = this._register(new DisposableStore());
  private readonly icons: boolean;

  constructor(
    parent: HTMLElement,
    private readonly location: ViewContainerLocation,
    private readonly select: (id: string) => void,
    @IViewDescriptorService private readonly views: IViewDescriptorService,
    @IContextKeyService private readonly contextKeys: IContextKeyService,
    @IMenuService private readonly menus: IMenuService,
    @IContextMenuService private readonly contextMenu: IContextMenuService,
  ) {
    super();
    const icons = this.icons = location === ViewContainerLocation.Sidebar;
    this.element = parent.ownerDocument.createElement('div');
    this.element.className = 'composite-bar';
    this.element.setAttribute('role', icons ? 'toolbar' : 'tablist');
    this.element.setAttribute('aria-label', icons ? 'Activity Bar' : 'Panel views');
    parent.append(this.element);
    this._register(toDisposable(() => this.element.remove()));
    const dnd = new CompositeDragAndDrop(this.views, location);
    this._register(dnd.registerTarget(parent, (_, event) => this.getInsertion(event)));
  }

  update(containers: readonly ViewContainer[], activeId: string | undefined): void {
    for (const [container, button] of this.buttons) {
      if (!containers.includes(container)) {
        this.buttonListeners.delete(button.listeners);
        button.element.remove();
        this.buttons.delete(container);
      }
    }
    containers.forEach((container, index) => {
      let entry = this.buttons.get(container);
      if (!entry) {
        entry = this.createButton(container);
        this.buttons.set(container, entry);
      }
      const button = entry.element;
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

  private getInsertion(event: DragEvent): CompositeInsertion {
    for (const [container, { element }] of this.buttons) {
      if (element.contains(event.target as Node)) {
        const rect = element.getBoundingClientRect();
        const before = this.icons ? event.clientY < rect.top + rect.height / 2 : event.clientX < rect.left + rect.width / 2;
        return { relativeTo: container, marker: element, position: before ? 'before' : 'after' };
      }
    }
    const last = this.element.lastElementChild as HTMLElement | null;
    return last ? { marker: last, position: 'after' } : { marker: this.element, position: 'empty' };
  }

  private createButton(container: ViewContainer) {
    const listeners = this.buttonListeners.add(new DisposableStore());
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
      listeners.add(addDisposableListener(button, 'keydown', event => this.navigate(event, button)));
    }
    listeners.add(addDisposableListener(button, 'click', () => this.select(container.id)));
    listeners.add(addDisposableListener(button, 'contextmenu', event => {
      event.preventDefault();
      this.showContextMenu(button, container, event.button === 2 ? { x: event.clientX, y: event.clientY } : button);
    }));
    listeners.add(addDisposableListener(button, 'keydown', event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        this.showContextMenu(button, container, button);
      }
    }));
    listeners.add(CompositeDragAndDropObserver.INSTANCE.registerDraggable(button, () => new DraggedCompositeIdentifier(container.id)));
    return { element: button, listeners };
  }

  private showContextMenu(button: HTMLButtonElement, container: ViewContainer, anchor: MenuAnchor): void {
    const context = this.contextKeys.createScoped(button);
    try {
      ViewContainerLocationContext.bindTo(context).set(this.location);
      const groups = bindMenuArguments(this.menus.getMenuActions(MenuId.ViewContainerTitleContext, context), container.id);
      this.contextMenu.showContextMenu({ getAnchor: () => anchor, getActions: () => groups });
    } finally {
      context.dispose();
    }
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
