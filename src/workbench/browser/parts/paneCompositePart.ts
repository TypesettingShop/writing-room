import { Emitter } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import type { IContextKey, RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { FocusedViewContext } from '../../common/contextkeys.js';
import { ViewContainerLocation, getViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../common/views.js';
import type { IViewDescriptor, ViewContainer } from '../../common/views.js';
import { IWorkbenchLayoutService } from '../../services/layout/browser/layoutService.js';
import type { Parts } from '../../services/layout/browser/layoutService.js';
import type { LayoutStateModel } from '../layout.js';
import { Part } from '../part.js';
import { ViewPaneContainer } from './views/viewPaneContainer.js';

export abstract class PaneCompositePart extends Part {
  static readonly HEADER_HEIGHT = 34;

  private readonly didChange = this._register(new Emitter<void>());
  readonly onDidChangeComposites = this.didChange.event;

  private readonly containerDisposables = this._register(new DisposableStore());
  private readonly containers = new Map<ViewContainer, ViewPaneContainer>();
  private readonly activeContext: IContextKey<string>;
  private readonly focusedView: IContextKey<string>;
  private content!: HTMLElement;
  private active: ViewPaneContainer | undefined;
  private width = 0;
  private height = 0;
  private relevantContextKeys = new Set<string>();
  private available = new Map<ViewContainer, readonly IViewDescriptor[]>();
  private refreshing = false;
  private refreshPending = false;

  protected constructor(
    id: Parts,
    private readonly location: ViewContainerLocation,
    private readonly state: LayoutStateModel,
    private readonly activeKey: 'activeViewlet' | 'activePanel',
    activeContext: RawContextKey<string>,
    private readonly contextKeyService: IContextKeyService,
    private readonly instantiationService: IInstantiationService,
    private readonly layoutService: IWorkbenchLayoutService,
  ) {
    super(id);
    this.activeContext = activeContext.bindTo(contextKeyService);
    this.focusedView = FocusedViewContext.bindTo(contextKeyService);
  }

  protected override createContentArea(parent: HTMLElement): void {
    const header = parent.ownerDocument.createElement('header');
    header.className = 'pane-composite-header';
    header.style.height = `${PaneCompositePart.HEADER_HEIGHT}px`;
    this.content = parent.ownerDocument.createElement('div');
    this.content.className = 'pane-composite-content';
    parent.append(header, this.content);
    this.createHeader(header);

    const onViewsChanged = ({ viewContainer }: { viewContainer: ViewContainer }) => {
      if (getViewContainerLocation(viewContainer) === this.location || this.containers.has(viewContainer)) {
        this.refresh();
      }
    };
    this._register(viewContainersRegistry.onDidRegister(onViewsChanged));
    this._register(viewContainersRegistry.onDidDeregister(() => this.refresh()));
    this._register(viewsRegistry.onViewsRegistered(onViewsChanged));
    this._register(viewsRegistry.onViewsDeregistered(onViewsChanged));
    this._register(this.layoutService.onDidChangePartVisibility(({ partId }) => {
      if (partId === this.id) {
        this.refresh();
      }
    }));
    this._register(this.contextKeyService.onDidChangeContext(event => {
      if (event.affectsSome(this.relevantContextKeys)) {
        this.refresh();
      }
    }));
  }

  protected abstract createHeader(parent: HTMLElement): void;

  get activeCompositeId(): string | undefined {
    return this.visible ? this.active?.descriptor.id : undefined;
  }

  getVisibleViewContainers(): ViewContainer[] {
    return [...this.available.keys()];
  }

  openPaneComposite(id: string): ViewPaneContainer | undefined {
    if (!this.getVisibleViewContainers().some(container => container.id === id)) {
      return undefined;
    }
    this.state[this.activeKey] = id;
    if (this.visible) {
      this.refresh();
    } else {
      this.layoutService.setPartHidden(false, this.id);
    }
    return this.active;
  }

  initializeViewContainers(): void {
    this.refresh();
  }

  override layout(width: number, height: number, top: number, left: number): void {
    super.layout(width, height, top, left);
    this.width = width;
    this.height = Math.max(0, height - PaneCompositePart.HEADER_HEIGHT);
    this.active?.layout(this.width, this.height);
  }

  private refresh(): void {
    if (this.refreshing) {
      this.refreshPending = true;
      return;
    }
    this.refreshing = true;
    const previousSelections = new Set<string | undefined>();
    try {
      do {
        this.refreshPending = false;
        const before = this.activeContext.get();
        this.updateComposites();
        const after = this.activeContext.get();
        if (before !== after) {
          // A self-referential when clause can otherwise keep alternating between two selections.
          if (previousSelections.has(after)) {
            break;
          }
          previousSelections.add(before);
        }
      } while (this.refreshPending);
    } finally {
      this.refreshing = false;
    }
  }

  private updateComposites(): void {
    const available = new Map<ViewContainer, readonly IViewDescriptor[]>();
    this.relevantContextKeys = new Set();
    for (const container of viewContainersRegistry.all) {
      if (getViewContainerLocation(container) !== this.location) {
        continue;
      }
      const views = viewsRegistry.getViews(container).filter(view => {
        view.when?.keys().forEach(key => this.relevantContextKeys.add(key));
        return this.contextKeyService.contextMatchesRules(view.when);
      });
      if (views.length) {
        available.set(container, views);
      }
    }

    this.available = available;
    const selected = [...available.keys()].find(container => container.id === this.state[this.activeKey])
      ?? available.keys().next().value;
    const previous = this.active;
    if (previous && (previous.descriptor !== selected || !this.visible)) {
      previous.setVisible(false);
    }
    for (const [descriptor, container] of this.containers) {
      if (getViewContainerLocation(descriptor) !== this.location) {
        this.containers.delete(descriptor);
        this.containerDisposables.delete(container);
      } else {
        container.setViews(available.get(descriptor) ?? []);
      }
    }

    this.active = selected && this.containers.get(selected);
    if (selected && this.visible) {
      if (!this.active) {
        this.active = this.containerDisposables.add(
          this.instantiationService.createInstance(
            ViewPaneContainer, selected, this.content, this.focusedView, this.location === ViewContainerLocation.Panel,
          ),
        );
        this.containers.set(selected, this.active);
        this.active.setViews(available.get(selected)!);
      }
      this.active.layout(this.width, this.height);
      this.active.setVisible(true);
    }
    // Keep the last selection through a temporary lack of visible views, such as an extension loading.
    if (selected && (this.visible || this.state[this.activeKey] === undefined)) {
      this.state[this.activeKey] = selected.id;
    }
    this.activeContext.set(this.activeCompositeId ?? '');
    this.didChange.fire();
  }
}
