import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { MessageSeverity } from '../../../api/common/extHost.protocol.js';
import './notificationsToasts.css';

const icons: Record<MessageSeverity, string> = { info: 'info', warning: 'warning', error: 'error' };

export class NotificationsToasts extends Disposable {
  private readonly stack: HTMLElement;
  private readonly entries = this._register(new DisposableStore());

  constructor(layout: HTMLElement) {
    super();
    this.stack = layout.ownerDocument.createElement('div');
    this.stack.className = 'extension-toasts';
    layout.append(this.stack);
    this._register(toDisposable(() => this.stack.remove()));
  }

  show(
    severity: MessageSeverity, message: string, actions: readonly string[], resolve: (index: number | undefined) => void,
  ): IDisposable {
    const document = this.stack.ownerDocument;
    const item = document.createElement('section');
    item.className = 'extension-toast';
    item.setAttribute('aria-label', message);
    const icon = document.createElement('span');
    icon.className = 'codicon codicon-' + icons[severity];
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = message;
    text.setAttribute('role', severity === 'error' ? 'alert' : 'status');
    const buttons = document.createElement('div');
    buttons.className = 'extension-toast-actions';
    let selection: number | undefined;
    const subscription = this.entries.add(toDisposable(() => {
      item.remove();
      resolve(selection);
    }));
    const close = (index?: number) => {
      selection = index;
      this.entries.delete(subscription);
    };
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'codicon codicon-close';
    dismiss.setAttribute('aria-label', 'Dismiss message');
    dismiss.addEventListener('click', () => close());
    item.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    });
    for (const [index, action] of actions.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action;
      button.addEventListener('click', () => close(index));
      buttons.append(button);
    }
    item.append(icon, text, dismiss, buttons);
    this.stack.append(item);
    return { dispose: () => this.entries.delete(subscription) };
  }
}
