import { Emitter } from '../../../base/common/event.js';
import { dispose, toDisposable } from '../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import type { IContextKey, RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import type { IStorageService } from '../../../platform/storage/common/storage.js';
import { FocusedViewContext } from '../../common/contextkeys.js';
import { ViewContainerLocation, viewsRegistry } from '../../common/views.js';
import type { IViewContainerLocationChange, IViewContainerLocationChangeEvent, IViewDescriptor, IViewDescriptorService, ViewContainer } from '../../common/views.js';
import { IWorkbenchLayoutService } from '../../services/layout/browser/layoutService.js';
import type { Parts } from '../../services/layout/browser/layoutService.js';
import type { LayoutStateModel } from '../layout.js';
import { Part } from '../part.js';
import { CompositeDragAndDrop } from './compositeBar.js';
import { ViewPaneContainer } from './views/viewPaneContainer.js';

export abstract class PaneCompositePart extends Part {
  static readonly HEADER_HEIGHT = 34;

  private readonly didChange = this._register(new Emitter<void>());
  readonly onDidChangeComposites = this.didChange.event;

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
  private initialized = false;
  private transferring = false;

  protected constructor(
    id: Parts,
    readonly location: ViewContainerLocation,
    private readonly state: LayoutStateModel,
    private readonly activeKey: 'activeViewlet' | 'activePanel',
    activeContext: RawContextKey<string>,
    private readonly contextKeyService: IContextKeyService,
    protected readonly instantiationService: IInstantiationService,
    private readonly layoutService: IWorkbenchLayoutService,
    protected readonly viewDescriptors: IViewDescriptorService,
    private readonly storage: IStorageService,
    private readonly storageKey: string,
  ) {
    super(id);
    this._register(toDisposable(() => dispose(this.containers.values())));
    this.activeContext = activeContext.bindTo(contextKeyService);
    this.focusedView = FocusedViewContext.bindTo(contextKeyService);
    this._register(storage.onWillSaveState(() => storage.store(
      this.storageKey, this.state[this.activeKey], StorageScope.WORKSPACE, StorageTarget.MACHINE,
    )));
  }

  protected override createContentArea(parent: HTMLElement): void {
    const header = parent.ownerDocument.createElement('header');
    header.className = 'pane-composite-header';
    header.style.height = `${PaneCompositePart.HEADER_HEIGHT}px`;
    this.content = parent.ownerDocument.createElement('div');
    this.content.className = 'pane-composite-content';
    this.content.style.height = `calc(100% - ${PaneCompositePart.HEADER_HEIGHT}px)`;
    parent.append(header, this.content);
    this.createHeader(header);
    const dropTarget = this.location === ViewContainerLocation.Sidebar ? parent : this.content;
    this._register(new CompositeDragAndDrop(this.viewDescriptors, this.location).registerTarget(dropTarget, from =>
      from === this.location ? undefined : { marker: dropTarget, position: 'body' },
    ));

    const onViewsChanged = ({ viewContainer }: { viewContainer: ViewContainer }) => {
      if (this.viewDescriptors.getViewContainerLocation(viewContainer) === this.location || this.containers.has(viewContainer)) {
        this.refresh();
      }
    };
    this._register(this.viewDescriptors.onDidRegister(onViewsChanged));
    this._register(this.viewDescriptors.onDidDeregister(() => this.refresh()));
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
    const stored = this.storage.get(this.storageKey, StorageScope.WORKSPACE);
    if (stored !== undefined) {
      const descriptor = this.viewDescriptors.getViewContainerById(stored);
      if (descriptor && this.viewDescriptors.getViewContainerLocation(descriptor) === this.location) {
        this.state[this.activeKey] ??= stored;
      } else {
        console.warn('Unavailable saved view container.', { key: this.storageKey, id: stored });
      }
    }
    this.initialized = true;
    this.refresh();
  }

  override canShow(): boolean {
    return this.viewDescriptors.getViewContainersByLocation(this.location).length > 0;
  }

  bindContainerLocations(listener: (event: IViewContainerLocationChangeEvent) => void): void {
    this._register(this.viewDescriptors.onDidChangeContainerLocation(listener));
  }

  beginCompositeTransfer(): void {
    this.transferring = true;
  }

  detachComposite(descriptor: ViewContainer): ViewPaneContainer | undefined {
    const container = this.containers.get(descriptor);
    if (container) {
      this.containers.delete(descriptor);
      if (this.active === container) {
        this.active = undefined;
      }
      container.setVisible(false);
    }
    return container;
  }

  attachComposite(container: ViewPaneContainer): void {
    this.containers.set(container.descriptor, container);
    container.attachTo(this.content, this.location === ViewContainerLocation.Panel);
  }

  updateContainerLocations(changes: readonly IViewContainerLocationChange[], reset: boolean): void {
    const incoming = changes.find(change => change.to === this.location && change.from !== this.location);
    const outgoing = changes.find(change => change.from === this.location && change.to !== this.location
      && change.viewContainer.id === this.state[this.activeKey]);
    if (incoming && !reset) {
      this.state[this.activeKey] = incoming.viewContainer.id;
    } else if (outgoing) {
      const remaining = this.viewDescriptors.getViewContainersByLocation(this.location);
      this.state[this.activeKey] = (remaining[outgoing.fromIndex] ?? remaining.at(-1))?.id;
    }
    this.transferring = false;
    this.refresh();
    if (incoming && !reset && !this.visible) {
      this.layoutService.setPartHidden(false, this.id);
    }
  }

  override layout(width: number, height: number, top: number, left: number): void {
    super.layout(width, height, top, left);
    this.width = width;
    this.height = Math.max(0, height - PaneCompositePart.HEADER_HEIGHT);
    this.active?.layout(this.width, this.height);
  }

  private refresh(): void {
    if (!this.initialized || this.transferring) {
      return;
    }
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
    const descriptors = this.viewDescriptors.getViewContainersByLocation(this.location);
    this.layoutService.setPartHidden(descriptors.length === 0, this.id, { automatic: true });
    for (const container of descriptors) {
      const views = viewsRegistry.getViews(container).filter(view => {
        view.when?.keys().forEach(key => this.relevantContextKeys.add(key));
        return this.contextKeyService.contextMatchesRules(view.when);
      });
      if (views.length) {
        available.set(container, views);
      }
    }

    this.available = available;
    const candidates = [...available.keys()];
    const remembered = this.state[this.activeKey];
    const selected = (remembered === undefined
      ? candidates.find(container => container.defaultActive)
      : candidates.find(container => container.id === remembered)) ?? candidates[0];
    const previous = this.active;
    if (previous && (previous.descriptor !== selected || !this.visible)) {
      previous.setVisible(false);
    }
    for (const [descriptor, container] of this.containers) {
      const location = this.viewDescriptors.getViewContainerLocation(descriptor);
      if (location === undefined) {
        this.containers.delete(descriptor);
        container.dispose();
      } else if (location === this.location) {
        container.setViews(available.get(descriptor) ?? []);
      }
    }

    this.active = selected && this.containers.get(selected);
    if (selected && this.visible) {
      if (!this.active) {
        this.active = this.instantiationService.createInstance(
          ViewPaneContainer, selected, this.content, this.focusedView, this.location === ViewContainerLocation.Panel,
        );
        this.containers.set(selected, this.active);
        this.active.setViews(available.get(selected)!);
      }
      this.active.layout(this.width, this.height);
      this.active.setVisible(true);
    }
    // Only an explicit open, a container moving in or out (updateContainerLocations), or the first selection
    // changes the remembered selection. A fallback shown while the
    // remembered container has no visible views (a late registration, an extension loading) does not replace it.
    if (selected && this.state[this.activeKey] === undefined) {
      this.state[this.activeKey] = selected.id;
    }
    this.activeContext.set(this.activeCompositeId ?? '');
    this.didChange.fire();
  }
}
