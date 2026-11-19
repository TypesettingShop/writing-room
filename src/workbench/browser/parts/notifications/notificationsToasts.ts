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

/** Toasts shown at once; the rest wait in order. */
export const maxVisibleToasts = 3;
/** Waiting toasts kept per source; a source that sends more loses its oldest waiting ones. */
export const maxWaitingPerSource = 10;
/** Waiting toasts kept in all. */
export const maxWaiting = 50;

const icons: Record<Severity, string> = {
  [Severity.Ignore]: 'info', [Severity.Info]: 'info', [Severity.Warning]: 'warning', [Severity.Error]: 'error',
};

class Toast implements INotificationHandle {
  private readonly didClose = new Emitter<void>();
  readonly onDidClose = this.didClose.event;
  closed = false;
  element: HTMLElement | undefined;
  private readonly store = new DisposableStore();
  private text: HTMLElement | undefined;
  private progressBar: HTMLElement | undefined;
  private buttons: HTMLElement | undefined;

  constructor(
    private notification: INotification,
    private readonly owner: NotificationsToasts,
  ) {}

  get source(): string | undefined {
    return this.notification.source;
  }

  render(): HTMLElement {
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
    const actions = this.notification.actions ?? [];
    this.buttons?.replaceChildren(...actions.map(action => {
      const button = $('button', { type: 'button' }, String(action.label));
      if (action.enabled === false) {
        button.setAttribute('aria-disabled', 'true');
      }
      button.addEventListener('click', () => this.run(action));
      return button;
    }));
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
  }

  updateProgress(progress: INotificationProgressState | undefined): void {
    this.notification = { ...this.notification, progress };
    this.renderProgress();
  }

  updateActions(actions: readonly INotificationAction[]): void {
    this.notification = { ...this.notification, actions };
    this.renderActions();
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.store.dispose();
      this.element?.remove();
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

  constructor(layout: HTMLElement) {
    super();
    this.stack = layout.ownerDocument.createElement('div');
    this.stack.className = 'extension-toasts';
    layout.append(this.stack);
    this._register(toDisposable(() => {
      for (const toast of [...this.waiting, ...this.visible]) {
        toast.close();
      }
      this.stack.remove();
    }));
  }

  add(notification: INotification): INotificationHandle {
    const toast = new Toast(notification, this);
    if (this.visible.length < maxVisibleToasts) {
      this.show(toast);
    } else {
      this.waiting.push(toast);
      this.trim(toast.source);
    }
    return toast;
  }

  private trim(source: string | undefined): void {
    const fromSource = this.waiting.filter(toast => toast.source === source);
    for (const toast of fromSource.slice(0, Math.max(0, fromSource.length - maxWaitingPerSource))) {
      toast.close();
    }
    while (this.waiting.length > maxWaiting) {
      this.waiting[0].close();
    }
  }

  private show(toast: Toast): void {
    this.visible.push(toast);
    this.stack.append(toast.render());
  }

  /** Called by a toast as it closes. */
  closed(toast: Toast): void {
    const waiting = this.waiting.indexOf(toast);
    if (waiting !== -1) {
      this.waiting.splice(waiting, 1);
      return;
    }
    const index = this.visible.indexOf(toast);
    if (index !== -1) {
      this.visible.splice(index, 1);
      const next = this.waiting.shift();
      if (next) {
        this.show(next);
      }
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
    return handle;
  }
}

registerSingleton(INotificationService, NotificationService);
