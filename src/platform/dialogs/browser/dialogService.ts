import { $, addDisposableListener } from '../../../base/browser/dom.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { Severity } from '../../../base/common/severity.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';
import { IDialogService } from '../common/dialogs.js';
import type { IPrompt, IPromptHandle } from '../common/dialogs.js';
import './dialog.css';

interface Request {
  readonly prompt: IPrompt;
  readonly resolve: (index: number | undefined) => void;
  done: boolean;
  close?: (index: number | undefined) => void;
}

const icons: Partial<Record<Severity, string>> = {
  [Severity.Info]: 'info', [Severity.Warning]: 'warning', [Severity.Error]: 'error',
};

let nextId = 0;

function deepActiveElement(document: Document): HTMLElement | undefined {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  return element instanceof HTMLElement ? element : undefined;
}

export class DialogService implements IDialogService {
  declare readonly _serviceBrand: undefined;
  private readonly queue: Request[] = [];
  private current: Request | undefined;

  constructor(@ILayoutService private readonly layout: ILayoutService) {}

  prompt(prompt: IPrompt): IPromptHandle {
    let resolve!: (index: number | undefined) => void;
    const result = new Promise<number | undefined>(done => { resolve = done; });
    const request: Request = { prompt, resolve, done: false };
    this.queue.push(request);
    this.next();
    return {
      result,
      close: () => {
        if (request.close) {
          request.close(undefined);
        } else if (!request.done) {
          request.done = true;
          this.queue.splice(this.queue.indexOf(request), 1);
          resolve(undefined);
        }
      },
    };
  }

  private next(): void {
    const request = this.current ? undefined : this.queue.shift();
    if (request) {
      this.current = request;
      this.open(request);
    }
  }

  private open(request: Request): void {
    const { prompt } = request;
    const container = this.layout.mainContainer;
    const document = container.ownerDocument;
    const returnFocus = deepActiveElement(document);
    const id = 'wr-dialog-' + ++nextId;
    const store = new DisposableStore();

    const message = $('div.wr-dialog-message', { id: id + '-message' }, String(prompt.message));
    const body = $('div.wr-dialog-body', null, message);
    const describedBy: string[] = [];
    if (prompt.detail) {
      body.append($('div.wr-dialog-detail', { id: id + '-detail' }, String(prompt.detail)));
      describedBy.push(id + '-detail');
    }
    if (prompt.source) {
      body.append($('div.wr-dialog-source', { id: id + '-source' }, 'Source: ' + String(prompt.source)));
      describedBy.push(id + '-source');
    }
    const icon = icons[prompt.type];
    const buttons = prompt.buttons.map((label, index) => {
      const button = $('button', { type: 'button', class: index === 0 ? 'wr-dialog-button primary' : 'wr-dialog-button' }, String(label));
      store.add(addDisposableListener(button, 'click', () => close(index)));
      return button;
    });
    const dialog = $('div.wr-dialog', {
      id, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': message.id,
      'aria-describedby': describedBy.join(' ') || undefined, tabindex: '-1',
    }, ...icon ? [$('span', { class: 'wr-dialog-icon codicon codicon-' + icon, 'aria-hidden': 'true' })] : [], body,
    $('div.wr-dialog-buttons', null, ...buttons));
    const overlay = $('div.wr-dialog-overlay', null, dialog);

    // Everything else in the workbench takes no focus and no clicks while the dialog is open.
    const inert: Element[] = [];
    for (const child of container.children) {
      if (!child.hasAttribute('inert')) {
        child.setAttribute('inert', '');
        inert.push(child);
      }
    }
    const focusables = () => buttons.length ? buttons : [dialog];
    const close = (index: number | undefined) => {
      if (request.done) {
        return;
      }
      request.done = true;
      store.dispose();
      overlay.remove();
      for (const element of inert) {
        element.removeAttribute('inert');
      }
      if (returnFocus?.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
      this.current = undefined;
      request.resolve(index);
      this.next();
    };
    request.close = close;

    store.add(addDisposableListener(dialog, 'keydown', event => {
      if (event.isComposing) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(prompt.cancelButton);
      } else if (event.key === 'Tab') {
        // Tab goes round the buttons and never leaves the dialog.
        event.preventDefault();
        event.stopPropagation();
        const list = focusables();
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = at === -1 ? 0 : (at + (event.shiftKey ? -1 : 1) + list.length) % list.length;
        list[next].focus();
      }
    }));
    // Focus that reaches the workbench by any other way comes back to the dialog.
    store.add(addDisposableListener(document, 'focusin', event => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        focusables()[0].focus();
      }
    }, true));
    store.add(addDisposableListener(overlay, 'mousedown', event => {
      if (!dialog.contains(event.target as Node)) {
        event.preventDefault();
      }
    }));
    container.append(overlay);
    focusables()[0].focus();
  }
}

registerSingleton(IDialogService, DialogService);
