import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IViewDescriptor, ViewContainer } from '../../../common/views.js';
import { ViewPane } from './viewPane.js';

export class ViewPaneContainer extends Disposable {
  readonly element: HTMLElement;
  private readonly paneDisposables = this._register(new DisposableStore());
  private readonly panes = new Map<IViewDescriptor, ViewPane>();
  private visible = false;
  private width = 0;
  private height = 0;

  constructor(
    readonly descriptor: ViewContainer,
    parent: HTMLElement,
    private readonly focusedView: IContextKey<string>,
    isPanel: boolean,
    @IInstantiationService private readonly instantiationService: IInstantiationService,
  ) {
    super();
    this.element = parent.ownerDocument.createElement('div');
    this.element.className = 'view-pane-container';
    if (isPanel) {
      this.element.setAttribute('role', 'tabpanel');
      this.element.setAttribute('aria-label', descriptor.title);
    }
    this.element.hidden = true;
    parent.append(this.element);
    this._register(toDisposable(() => this.element.remove()));
  }

  setViews(views: readonly IViewDescriptor[]): void {
    for (const [descriptor, pane] of this.panes) {
      if (!views.includes(descriptor)) {
        this.panes.delete(descriptor);
        this.paneDisposables.delete(pane);
      }
    }
    views.forEach((descriptor, index) => {
      let pane = this.panes.get(descriptor);
      if (!pane) {
        pane = this.paneDisposables.add(
          this.instantiationService.createInstance(ViewPane, descriptor, this.element.ownerDocument, this.focusedView),
        );
        this.panes.set(descriptor, pane);
      }
      const atIndex = this.element.children[index];
      if (atIndex !== pane.element) {
        this.element.insertBefore(pane.element, atIndex ?? null);
      }
      pane.setVisible(this.visible);
    });
    this.layout(this.width, this.height);
  }

  setVisible(visible: boolean): void {
    if (this.visible !== visible) {
      this.visible = visible;
      this.element.hidden = !visible;
      for (const pane of this.panes.values()) {
        pane.setVisible(visible);
      }
      if (visible) {
        this.layout(this.width, this.height);
      }
    }
  }

  layout(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.visible && this.panes.size) {
      const available = Math.max(0, height - ViewPane.HEADER_HEIGHT * this.panes.size);
      let index = 0;
      for (const pane of this.panes.values()) {
        const start = Math.floor(index * available / this.panes.size);
        const end = Math.floor(++index * available / this.panes.size);
        pane.layoutBody(end - start, width);
      }
    }
  }

  focus(): void {
    this.panes.values().next().value?.focus();
  }

  getView(id: string): ViewPane | undefined {
    return [...this.panes.values()].find(pane => pane.descriptor.id === id);
  }
}
