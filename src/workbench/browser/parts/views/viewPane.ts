import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewContext } from '../../../common/contextkeys.js';
import type { IViewBody, IViewDescriptor } from '../../../common/views.js';

export class ViewPane extends Disposable {
  static readonly HEADER_HEIGHT = 28;

  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private bodyContent: IViewBody | void = undefined;
  private bodyCreated = false;

  constructor(
    readonly descriptor: IViewDescriptor,
    document: Document,
    private readonly focusedView: IContextKey<string>,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IInstantiationService instantiationService: IInstantiationService,
  ) {
    super();
    this.element = document.createElement('section');
    this.element.className = 'view-pane';
    this.element.setAttribute('aria-label', descriptor.name);
    this.element.tabIndex = -1;
    this._register(toDisposable(() => this.element.remove()));

    const context = this._register(contextKeyService.createScoped(this.element));
    ViewContext.bindTo(context).set(descriptor.id);

    const header = document.createElement('header');
    header.className = 'view-pane-header';
    header.style.height = `${ViewPane.HEADER_HEIGHT}px`;
    const title = document.createElement('h3');
    title.textContent = descriptor.name;
    header.append(title);
    this._register(instantiationService.createInstance(MenuWorkbenchToolBar, header, MenuId.ViewTitle, context));

    this.body = document.createElement('div');
    this.body.className = 'view-pane-body';
    this.element.append(header, this.body);
    this._register(addDisposableListener(this.element, 'focusin', () => this.focusedView.set(descriptor.id)));
    this._register(addDisposableListener(this.element, 'focusout', event => {
      if (!this.element.contains(event.relatedTarget as Node | null)) {
        this.clearFocus();
      }
    }));
    this._register(toDisposable(() => this.clearFocus()));
  }

  setVisible(visible: boolean): void {
    if (visible && !this.bodyCreated) {
      this.bodyCreated = true;
      const bodyContent = this.renderBody();
      this.bodyContent = bodyContent;
      if (bodyContent?.dispose) {
        this._register(toDisposable(() => bodyContent.dispose?.()));
      }
    }
    if (!visible) {
      this.clearFocus();
    }
  }

  layoutBody(height: number, width: number): void {
    this.body.style.height = `${height}px`;
    this.bodyContent?.layoutBody?.(height, width);
  }

  focus(): void {
    this.element.focus();
  }

  private renderBody(): IViewBody | void {
    try {
      return this.descriptor.renderBody(this.body);
    } catch (error) {
      // One failing view must not stop its container or the workbench from starting.
      console.error(`View ${this.descriptor.id} failed to render.`, error);
      return undefined;
    }
  }

  private clearFocus(): void {
    if (this.focusedView.get() === this.descriptor.id) {
      this.focusedView.reset();
    }
  }
}
