import { $, addDisposableListener } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import type {
  INotification, INotificationAction, INotificationHandle, INotificationProgressState, IPromptChoice, IPromptOptions,
} from '../../../../platform/notification/common/notification.js';
import './notificationsToasts.css';

/** Toasts shown at once. */
export const maxVisibleToasts = 3;
/** Waiting toasts kept per source; a source that sends more loses its oldest waiting ones. */
export const maxWaitingPerSource = 10;
/** Waiting toasts kept in all. */
export const maxWaiting = 50;
/** Visible time before a plain information toast closes. */
export const toastAutoCloseDelay = 10_000;

const icons: Record<Severity, string> = {
  [Severity.Ignore]: 'info', [Severity.Info]: 'info', [Severity.Warning]: 'warning', [Severity.Error]: 'error',
};

class Toast implements INotificationHandle {
  private readonly didClose = new Emitter<void>();
  readonly onDidClose = this.didClose.event;
  closed = false;
  element: HTMLElement | undefined;
  private readonly store = new DisposableStore();
  private readonly actionListeners = this.store.add(new DisposableStore());
  private text: HTMLElement | undefined;
  private progressBar: HTMLElement | undefined;
  private buttons: HTMLElement | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private notification: INotification,
    private readonly owner: NotificationsToasts,
    readonly arrival: number,
  ) {}

  get source(): string | undefined {
    return this.notification.source;
  }

  /** Errors, and toasts while they show progress, go first and are never displaced. */
  get urgent(): boolean {
    return this.notification.severity === Severity.Error || !!this.notification.progress;
  }

  get droppable(): boolean {
    // A rendered toast has already been shown. Its response stays live while it waits.
    return !this.element && !this.notification.progress && !this.notification.actions?.length;
  }

  show(stack: HTMLElement): void {
    stack.append(this.element ?? this.render());
    this.updateCloseTimer();
  }

  hide(): void {
    this.element?.remove();
    this.updateCloseTimer();
  }

  private render(): HTMLElement {
    const { severity, message, source } = this.notification;
    const item = $('section.extension-toast', { 'aria-label': message });
    const icon = $('span', { class: 'codicon codicon-' + (icons[severity] ?? 'info'), 'aria-hidden': 'true' });
    // Text only: what an extension sends is never read as markup.
    this.text = $('span.extension-toast-message', { role: severity === Severity.Error ? 'alert' : 'status' }, String(message));
    const dismiss = $('button', { type: 'button', class: 'codicon codicon-close', 'aria-label': 'Dismiss message' });
    this.store.add(addDisposableListener(dismiss, 'click', () => this.close()));
    this.store.add(addDisposableListener(item, 'keydown', event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.close();
      }
    }));
    this.buttons = $('div.extension-toast-actions');
    item.append(icon, this.text, dismiss, this.buttons);
    if (source) {
      item.append($('div.extension-toast-source', null, 'Source: ' + String(source)));
    }
    this.progressBar = $('div.extension-toast-progress', { role: 'progressbar', 'aria-label': message, 'aria-valuemin': '0', 'aria-valuemax': '100' },
      $('div.extension-toast-progress-bit'));
    item.append(this.progressBar);
    this.element = item;
    this.renderActions();
    this.renderProgress();
    return item;
  }

  private renderActions(): void {
    const buttons = this.buttons;
    if (this.closed || !buttons) {
      return;
    }
    this.actionListeners.clear();
    const actions = this.notification.actions ?? [];
    const focused = [...buttons.children].findIndex(button => button === button.ownerDocument.activeElement);
    buttons.replaceChildren(...actions.map(action => {
      const button = $('button', { type: 'button' }, String(action.label));
      if (action.enabled === false) {
        button.setAttribute('aria-disabled', 'true');
      }
      this.actionListeners.add(addDisposableListener(button, 'click', () => this.run(action)));
      return button;
    }));
    if (focused !== -1) {
      // Keep keyboard focus in the toast, so it still counts as in use and is not displaced.
      const next = buttons.children[Math.min(focused, buttons.children.length - 1)] ?? this.element?.querySelector('[aria-label="Dismiss message"]');
      (next as HTMLElement | null | undefined)?.focus();
    }
  }

  private renderProgress(): void {
    const bar = this.progressBar;
    if (!bar) {
      return;
    }
    const progress = this.notification.progress;
    bar.hidden = !progress;
    bar.classList.toggle('infinite', !!progress && progress.worked === undefined);
    if (progress && progress.worked !== undefined) {
      const worked = Math.max(0, Math.min(100, progress.worked));
      bar.setAttribute('aria-valuenow', String(Math.round(worked)));
      (bar.firstElementChild as HTMLElement).style.width = worked + '%';
    } else {
      bar.removeAttribute('aria-valuenow');
      (bar.firstElementChild as HTMLElement).style.width = '';
    }
  }

  restartCloseTimer(): void {
    this.clearCloseTimer();
    this.updateCloseTimer();
  }

  private clearCloseTimer(): void {
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  private updateCloseTimer(): void {
    const { severity, progress, actions } = this.notification;
    const element = this.element;
    const shouldTime = !this.closed && element?.parentElement && !progress && !actions?.length
      && (severity === Severity.Info || severity === Severity.Ignore) && this.owner.hasFocus();
    if (!shouldTime) {
      this.clearCloseTimer();
    } else if (this.closeTimer === undefined) {
      this.closeTimer = setTimeout(() => {
        this.closeTimer = undefined;
        if (this.owner.canAutoClose(element)) {
          this.close();
        } else {
          this.updateCloseTimer();
        }
      }, toastAutoCloseDelay);
    }
  }

  private run(action: INotificationAction): void {
    if (this.closed || action.enabled === false) {
      return;
    }
    try {
      action.run();
    } catch (error) {
      console.error(error);
    }
    if (!action.keepOpen) {
      this.close();
    }
  }

  updateMessage(message: string): void {
    this.notification = { ...this.notification, message };
    if (this.text) {
      this.text.textContent = String(message);
      this.element?.setAttribute('aria-label', String(message));
      this.progressBar?.setAttribute('aria-label', String(message));
    }
    this.recheckPosition();
  }

  updateProgress(progress: INotificationProgressState | undefined): void {
    if (this.closed) {
      return;
    }
    this.notification = { ...this.notification, progress };
    this.renderProgress();
    this.updateCloseTimer();
    // Progress can change priority even while the toast is waiting.
    this.owner.fillVisible();
  }

  updateActions(actions: readonly INotificationAction[]): void {
    this.notification = { ...this.notification, actions };
    this.renderActions();
    this.updateCloseTimer();
    this.recheckPosition();
  }

  private recheckPosition(): void {
    if (this.element?.parentElement) {
      this.owner.fillVisible();
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.store.dispose();
      this.hide();
      this.owner.closed(this);
      this.didClose.fire();
      this.didClose.dispose();
    }
  }
}

/** The stack of toasts at the bottom right of the workbench. */
export class NotificationsToasts extends Disposable {
  private readonly stack: HTMLElement;
  private readonly visible: Toast[] = [];
  private readonly waiting: Toast[] = [];

  private nextArrival = 0;
  private disposed = false;
  private pointer: { x: number; y: number } | undefined;
  private pointerFrame: number | undefined;
  /** Where focus is going while a focus change in the stack is under way. */
  private focusing: Node | undefined;

  constructor(layout: HTMLElement, readonly hasFocus = () => layout.ownerDocument.hasFocus()) {
    super();
    const document = layout.ownerDocument;
    const view = document.defaultView;
    this.stack = document.createElement('div');
    this.stack.className = 'extension-toasts';
    layout.append(this.stack);
    const trackPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') {
        this.pointer = { x: event.clientX, y: event.clientY };
        if (view && this.pointerFrame === undefined && this.visible.some(toast => !toast.urgent)
          && this.waiting.some(toast => toast.urgent)) {
          this.pointerFrame = view.requestAnimationFrame(() => {
            this.pointerFrame = undefined;
            this.fillVisible();
          });
        }
      }
    };
    this._register(addDisposableListener(document, 'pointerover', trackPointer, true));
    this._register(addDisposableListener(document, 'pointermove', trackPointer, true));
    this._register(addDisposableListener(document, 'pointerout', event => {
      if (event.pointerType !== 'touch' && !event.relatedTarget) {
        this.pointer = undefined;
        this.fillVisible();
      }
    }, true));
    this._register(addDisposableListener(this.stack, 'focusout', event => {
      // In a user's focus change the browser runs this microtask before focus lands, while activeElement is
      // still the body, so the element gaining focus counts as focused.
      const next = event.relatedTarget as Node | null;
      const focusing = next && this.stack.contains(next) ? next : undefined;
      queueMicrotask(() => {
        this.focusing = focusing;
        try {
          this.fillVisible();
        } finally {
          this.focusing = undefined;
        }
      });
    }));
    if (view) {
      const windowFocusChanged = () => {
        for (const toast of this.visible) {
          toast.restartCloseTimer();
        }
      };
      this._register(addDisposableListener(view, 'focus', windowFocusChanged));
      this._register(addDisposableListener(view, 'blur', windowFocusChanged));
    }
    this._register(toDisposable(() => {
      this.disposed = true;
      if (this.pointerFrame !== undefined) {
        view?.cancelAnimationFrame(this.pointerFrame);
      }
      for (const toast of [...this.waiting, ...this.visible]) {
        toast.close();
      }
      this.stack.remove();
    }));
  }

  add(notification: INotification): INotificationHandle {
    const toast = new Toast(notification, this, this.nextArrival++);
    if (this.disposed) {
      toast.close();
      return toast;
    }
    this.waiting.push(toast);
    this.fillVisible();
    if (this.waiting.includes(toast)) {
      this.trim(toast.source);
    }
    return toast;
  }

  canAutoClose(element: HTMLElement): boolean {
    return this.hasFocus() && !this.isInteracting(element, this.pointerTarget());
  }

  private pointerTarget(): Element | null {
    // Recompute the hit against the current layout, even when the pointer hasn't moved.
    return (this.pointer && this.stack.ownerDocument.elementFromPoint?.(this.pointer.x, this.pointer.y)) ?? null;
  }

  private isInteracting(element: HTMLElement, pointer: Element | null): boolean {
    return element.contains(this.stack.ownerDocument.activeElement) || element.contains(pointer)
      || (this.focusing !== undefined && element.contains(this.focusing));
  }

  private trim(source: string | undefined): void {
    this.trimWaiting(maxWaitingPerSource, toast => toast.source === source);
    this.trimWaiting(maxWaiting, () => true);
  }

  private trimWaiting(limit: number, matches: (toast: Toast) => boolean): void {
    while (true) {
      const queued = this.waiting.filter(matches);
      const oldest = queued.length > limit && queued.find(toast => toast.droppable);
      if (!oldest) {
        return;
      }
      oldest.close();
    }
  }

  /** Fills an open slot or gives it to a waiting urgent toast when a normal toast can move. */
  fillVisible(): void {
    while (!this.disposed && this.waiting.length) {
      const urgent = this.waiting.findIndex(toast => toast.urgent);
      if (this.visible.length < maxVisibleToasts) {
        this.showNext(urgent === -1 ? 0 : urgent);
        continue;
      }
      if (urgent === -1 || this.visible.every(toast => toast.urgent)) {
        return;
      }
      const pointer = this.pointerTarget();
      const displaced = [...this.visible].reverse().find(toast => !toast.urgent && !this.isInteracting(toast.element!, pointer));
      if (!displaced) {
        return;
      }
      this.visible.splice(this.visible.indexOf(displaced), 1);
      displaced.hide();
      this.showNext(urgent);
      const later = this.waiting.findIndex(toast => toast.arrival > displaced.arrival);
      this.waiting.splice(later === -1 ? this.waiting.length : later, 0, displaced);
      this.trim(displaced.source);
    }
  }

  private showNext(index: number): void {
    const [toast] = this.waiting.splice(index, 1);
    this.visible.push(toast);
    toast.show(this.stack);
  }

  /** Called by a toast as it closes. */
  closed(toast: Toast): void {
    const waiting = this.waiting.indexOf(toast);
    if (waiting !== -1) {
      this.waiting.splice(waiting, 1);
      return;
    }
    const visible = this.visible.indexOf(toast);
    if (visible !== -1) {
      this.visible.splice(visible, 1);
      this.fillVisible();
    }
  }
}

export class NotificationService extends Disposable implements INotificationService {
  declare readonly _serviceBrand: undefined;
  private toasts: NotificationsToasts | undefined;

  constructor(@ILayoutService private readonly layout: ILayoutService) {
    super();
  }

  notify(notification: INotification): INotificationHandle {
    this.toasts ??= this._register(new NotificationsToasts(this.layout.mainContainer));
    return this.toasts.add(notification);
  }

  info(message: string): INotificationHandle {
    return this.notify({ severity: Severity.Info, message });
  }

  warn(message: string): INotificationHandle {
    return this.notify({ severity: Severity.Warning, message });
  }

  error(message: string): INotificationHandle {
    return this.notify({ severity: Severity.Error, message });
  }

  prompt(severity: Severity, message: string, choices: readonly IPromptChoice[], options?: IPromptOptions): INotificationHandle {
    let chosen = false;
    const handle = this.notify({
      severity, message, source: options?.source,
      actions: choices.map(choice => ({ label: choice.label, run: () => { chosen = true; choice.run(); } })),
    });
    handle.onDidClose(() => {
      if (!chosen) {
        options?.onCancel?.();
      }
    });
    if (handle.closed) {
      // Dropped as it arrived, or the service is gone: its close event has already fired.
      options?.onCancel?.();
    }
    return handle;
  }
}

registerSingleton(INotificationService, NotificationService);
