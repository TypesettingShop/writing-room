import { Dimension } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IViewBody } from '../../../common/views.js';
import type { WebviewOverlay } from '../../webview/browser/webviewOverlay.js';

export type ResolveWebviewView = (pane: WebviewViewPane, token: CancellationToken) => Promise<void>;

export class WebviewViewPane extends Disposable implements IViewBody {
  private readonly shown = this._register(new Emitter<boolean>());
  readonly onDidChangeVisibility = this.shown.event;
  private readonly closed = this._register(new Emitter<void>());
  readonly onDidDispose = this.closed.event;

  private readonly anchor: HTMLElement;
  private readonly section: HTMLElement | null;
  private readonly heading: HTMLElement | null;
  readonly originalTitle: string;
  private currentVisible = false;
  private observer: ResizeObserver;
  private dimensions = new Dimension(0, 0);
  private resolution: CancellationTokenSource | undefined;
  private renderer: ResolveWebviewView | undefined;
  private overlay: WebviewOverlay | undefined;
  private disposed = false;
  private scheduled = false;
  private activated = false;

  constructor(
    parent: HTMLElement, readonly id: string, readonly extensionId: string, private readonly activate: () => Promise<void>,
  ) {
    super();
    this.section = parent.closest('section.view-pane');
    this.heading = this.section?.querySelector('.view-pane-header h3') ?? null;
    this.originalTitle = this.heading?.textContent ?? id;
    this.anchor = parent.ownerDocument.createElement('div');
    this.anchor.tabIndex = -1;
    this.anchor.className = 'webview-view-anchor';
    this.anchor.style.cssText = 'width:100%;height:100%';
    parent.append(this.anchor);
    this.observer = new ResizeObserver(() => this.scheduleVisibility());
    this.observer.observe(this.anchor);
    this._register(toDisposable(() => this.observer.disconnect()));
    this._register(toDisposable(() => this.anchor.remove()));
    this.scheduleVisibility();
  }

  get visible(): boolean {
    return this.currentVisible;
  }

  layoutBody(height: number, width: number): void {
    this.dimensions = new Dimension(width, height);
    this.overlay?.layout(this.anchor, this.dimensions);
    this.scheduleVisibility();
  }

  setProvider(renderer: ResolveWebviewView | undefined): void {
    if (this.renderer === renderer || this.disposed) {
      return;
    }
    this.renderer = renderer;
    this.resolution?.dispose(true);
    this.resolution = undefined;
    this.overlay?.dispose();
    this.overlay = undefined;
    this.setTitle();
    this.setDescription();
    if (this.currentVisible && renderer) {
      this.resolve(renderer);
    } else {
      this.label('No Webview content.');
    }
  }

  mount(token: CancellationToken, overlay: WebviewOverlay): IDisposable | undefined {
    if (!this.resolution || token !== this.resolution.token || token.isCancellationRequested || this.disposed) {
      overlay.dispose();
      return undefined;
    }
    this.overlay = overlay;
    this.anchor.replaceChildren();
    if (this.currentVisible) {
      overlay.show(this.anchor, this.dimensions);
    }
    return toDisposable(() => {
      if (this.overlay === overlay) {
        this.overlay = undefined;
        overlay.dispose();
      }
    });
  }

  setTitle(title?: string): void {
    const value = title ?? this.originalTitle;
    if (this.heading) {
      this.heading.textContent = value;
    }
    this.section?.setAttribute('aria-label', value);
  }

  setDescription(description?: string): void {
    if (this.heading) {
      this.heading.title = description ?? '';
    }
  }

  focus(): void {
    this.overlay?.focus();
  }

  private label(text: string): void {
    const status = this.anchor.ownerDocument.createElement('p');
    status.textContent = text;
    status.setAttribute('role', 'status');
    this.anchor.replaceChildren(status);
  }

  private scheduleVisibility(): void {
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.disposed) {
          return;
        }
        const bounds = this.anchor.getBoundingClientRect();
        const visible = this.anchor.isConnected && bounds.width > 0 && bounds.height > 0;
        if (visible !== this.currentVisible) {
          this.currentVisible = visible;
          if (visible) {
            this.overlay?.show(this.anchor, this.dimensions);
            this.show();
          } else {
            this.overlay?.hide(this.anchor);
          }
          this.shown.fire(visible);
        } else if (visible) {
          this.overlay?.layout(this.anchor, this.dimensions);
        }
      });
    }
  }

  private show(): void {
    if (this.renderer) {
      this.resolve(this.renderer);
    } else if (!this.activated) {
      this.activated = true;
      this.label('Opening Webview…');
      void this.activate().catch(() => {}).finally(() => {
        if (!this.renderer && !this.disposed) {
          this.label('No Webview content.');
        }
      });
    }
  }

  private resolve(renderer: ResolveWebviewView): void {
    if (this.resolution) {
      return;
    }
    const source = this.resolution = new CancellationTokenSource();
    this.label('Opening Webview…');
    void renderer(this, source.token).catch(() => {
      if (!source.token.isCancellationRequested && this.resolution === source) {
        this.overlay?.dispose();
        this.overlay = undefined;
        this.label('The extension could not open this Webview.');
      }
    });
  }

  override dispose(): void {
    this.disposed = true;
    this.resolution?.dispose(true);
    this.closed.fire();
    this.overlay?.dispose();
    super.dispose();
  }
}
