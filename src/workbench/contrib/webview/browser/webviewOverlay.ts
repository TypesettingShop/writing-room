import type { Dimension } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { EditorDragAndDropObserver } from '../../../browser/dnd.js';
import { hasNavigatorDrag, onDidEndNavigatorDrag } from '../../../browser/parts/editor/editorAreaDrops.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IWebviewService } from './webview.js';
import type { WebviewElement, WebviewElementOptions } from './webviewElement.js';
import type { WebviewOrigin } from '../common/webviewOrigin.js';

export class WebviewOverlay extends Disposable {
  private readonly messages = this._register(new Emitter<unknown>());
  readonly onDidReceiveMessage = this.messages.event;
  private readonly states = this._register(new Emitter<string>());
  readonly onDidChangeState = this.states.event;
  private readonly focused = this._register(new Emitter<void>());
  readonly onDidFocus = this.focused.event;
  private readonly elementListeners = this._register(new DisposableStore());
  private readonly anchorListeners = this._register(new DisposableStore());

  private anchor: HTMLElement | undefined;
  private element: WebviewElement | undefined;
  private animationFrame: number | undefined;
  private dimensions: Dimension | undefined;
  private html = '';
  private options: WebviewElementOptions = {};
  private state: string | undefined;
  private alert: string | undefined;
  private dragging = false;
  private focusPending = false;

  constructor(
    private readonly viewType: string, private origin: WebviewOrigin | undefined, private readonly retain: boolean,
    @IWebviewService private readonly webviews: IWebviewService,
    @IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
    @IContextKeyService private readonly contextKeys: IContextKeyService,
    @IMenuService private readonly menus: IMenuService,
    @IContextMenuService private readonly contextMenus: IContextMenuService,
  ) {
    super();
    const root = layoutService.mainContainer;
    const window = root.ownerDocument.defaultView!;
    const startDrag = (event: DragEvent) => {
      // Registered navigator rows can drop on editor groups through the frame.
      if (EditorDragAndDropObserver.INSTANCE.getDraggedItem(event, root)
        || hasNavigatorDrag(event, root)) {
        this.setDragging(true);
      }
    };
    // This runs after the tab, group or navigator row has registered the drag payload.
    window.addEventListener('dragstart', startDrag);
    this._register(toDisposable(() => window.removeEventListener('dragstart', startDrag)));
    this._register(EditorDragAndDropObserver.INSTANCE.onDidEndDrag(() => this.setDragging(false)));
    this._register(onDidEndNavigatorDrag(() => this.setDragging(false)));
    const onWindowBlur = () => {
      queueMicrotask(() => this.checkFocus());
    };
    window.addEventListener('blur', onWindowBlur);
    this._register(toDisposable(() => window.removeEventListener('blur', onWindowBlur)));
    this._register(toDisposable(() => {
      if (this.animationFrame !== undefined) {
        window.cancelAnimationFrame(this.animationFrame);
      }
    }));
    this._register(layoutService.onDidChangePartVisibility(() => this.scheduleLayout()));
  }

  get isVisible(): boolean {
    return this.anchor !== undefined;
  }

  setState(state: string | undefined): void {
    this.state = state;
    this.element?.setState(state);
  }

  setContent(html: string, options: WebviewElementOptions): void {
    this.html = html;
    this.options = options;
    this.element?.setContent(html, options);
  }

  setError(message: string): void {
    this.alert = message;
    this.createDisplay();
  }

  resetForRestore(): void {
    this.origin = undefined;
    this.alert = undefined;
    this.html = '';
    this.elementListeners.clear();
    this.element = undefined;
    this.createDisplay();
  }

  setOrigin(origin: WebviewOrigin): void {
    this.origin = origin;
    this.createDisplay();
    this.scheduleLayout();
  }

  show(anchor: HTMLElement, dimension?: Dimension): void {
    this.dimensions = dimension;
    if (this.anchor !== anchor) {
      this.anchorListeners.clear();
      this.anchor = anchor;
      const window = anchor.ownerDocument.defaultView!;
      const observer = new ResizeObserver(() => this.scheduleLayout());
      observer.observe(anchor);
      this.anchorListeners.add(toDisposable(() => observer.disconnect()));
      const layout = () => this.scheduleLayout();
      window.addEventListener('resize', layout);
      window.addEventListener('scroll', layout, true);
      this.anchorListeners.add(toDisposable(() => {
        window.removeEventListener('resize', layout);
        window.removeEventListener('scroll', layout, true);
      }));
    }
    this.createDisplay();
    this.scheduleLayout();
  }

  hide(anchor: HTMLElement): void {
    if (this.anchor !== anchor) {
      return;
    }
    this.anchor = undefined;
    anchor.replaceChildren();
    this.anchorListeners.clear();
    this.focusPending = false;
    if (this.retain && this.element) {
      this.element.container.hidden = true;
    } else {
      this.elementListeners.clear();
      this.element = undefined;
    }
  }

  layout(anchor: HTMLElement, dimension?: Dimension): void {
    if (this.anchor === anchor) {
      this.dimensions = dimension;
      this.scheduleLayout();
    }
  }

  focus(): void {
    this.focusPending = true;
    if (!this.element?.focus()) {
      this.anchor?.focus({ preventScroll: true });
    }
  }

  postMessage(value: unknown): Promise<boolean> {
    return this.element?.postMessage(value) ?? Promise.resolve(false);
  }

  private createDisplay(): void {
    const anchor = this.anchor;
    if (!anchor) {
      return;
    }
    if (this.alert || !this.origin) {
      this.elementListeners.clear();
      this.element = undefined;
      const status = anchor.ownerDocument.createElement('p');
      status.textContent = this.alert ?? 'Restoring Webview…';
      status.setAttribute('role', 'status');
      anchor.replaceChildren(status);
      return;
    }
    anchor.replaceChildren();
    if (!this.element) {
      const root = this.layoutService.mainContainer;
      const element = this.element = this.elementListeners.add(this.webviews.createElement(root.ownerDocument, this.origin));
      Object.assign(element.container.style, { position: 'fixed', zIndex: '2' });
      element.container.addEventListener('focusin', () => this.checkFocus());
      element.setState(this.state);
      element.setContent(this.html, this.options);
      this.elementListeners.add(element.onDidLoadContent(() => {
        if (this.focusPending && this.anchor?.ownerDocument.activeElement === this.anchor) {
          element.focus();
        }
      }));
      this.elementListeners.add(element.onDidReceiveMessage(value => this.messages.fire(value)));
      this.elementListeners.add(element.onDidChangeState(state => {
        this.state = element.savedState;
        this.states.fire(state);
      }));
      this.elementListeners.add(element.onDidRequestContextMenu(({ x, y, context }) => this.showContextMenu(x, y, context)));
      root.append(element.container);
    }
    this.element.container.hidden = false;
    this.setDragging(this.dragging);
    if (this.focusPending) {
      this.element.focus();
    }
  }

  private scheduleLayout(): void {
    if (!this.anchor || this.animationFrame !== undefined) {
      return;
    }
    const window = this.anchor.ownerDocument.defaultView!;
    this.animationFrame = window.requestAnimationFrame(() => {
      this.animationFrame = undefined;
      const anchor = this.anchor;
      const element = this.element;
      if (!anchor || !element) {
        return;
      }
      const { left, top, width, height } = anchor.getBoundingClientRect();
      element.container.hidden = !anchor.isConnected || width <= 0 || height <= 0;
      Object.assign(element.container.style, {
        left: left + 'px', top: top + 'px',
        width: Math.min(width, this.dimensions?.width ?? width) + 'px',
        height: Math.min(height, this.dimensions?.height ?? height) + 'px',
      });
    });
  }

  private checkFocus(): void {
    const element = this.element?.container;
    if (this.anchor && element?.contains(element.ownerDocument.activeElement)) {
      this.focusPending = false;
      this.focused.fire();
    }
  }

  private setDragging(dragging: boolean): void {
    this.dragging = dragging;
    if (this.element) {
      this.element.container.style.pointerEvents = dragging ? 'none' : '';
    }
  }

  private showContextMenu(x: number, y: number, value: unknown): void {
    if (!this.anchor) {
      return;
    }
    const scope = this.contextKeys.getScopedContextKeyService(this.anchor).createScoped();
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (key !== 'webviewId' && /^[\w.-]{1,128}$/.test(key)
          && (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number')) {
          scope.createKey(key, entry);
        }
      }
    }
    scope.createKey('webviewId', this.viewType);
    const actions = this.menus.getMenuActions(MenuId.WebviewContext, scope);
    scope.dispose();
    this.contextMenus.showContextMenu({ getAnchor: () => ({ x, y }), getActions: () => actions });
  }
}
