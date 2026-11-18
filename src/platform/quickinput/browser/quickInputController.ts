import { $, addDisposableListener } from '../../../base/browser/dom.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import type { ILayoutService } from '../../layout/browser/layoutService.js';
import type { IInputOptions, IPickOptions, IQuickPickItem, IQuickPickSeparator } from '../common/quickInput.js';
import { QuickInputBox } from './quickInputBox.js';
import { QuickInputList } from './quickInputList.js';
import './quickInput.css';

interface QuickInputSession {
  readonly returnFocus: HTMLElement | undefined;
  cancel(restoreFocus?: boolean): void;
}

let nextId = 0;

export function getQuickInputFocus(document: Document): HTMLElement | undefined {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  return element instanceof HTMLElement ? element : undefined;
}

function handleKey(event: KeyboardEvent, handler: (key: string) => boolean): void {
  if (event.isComposing || event.keyCode === 229 || !handler(event.key)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

export class QuickInputController {
  private session: QuickInputSession | undefined;
  private disposed = false;

  constructor(private readonly layout: ILayoutService) {}

  pick<T extends IQuickPickItem>(items: readonly (T | IQuickPickSeparator)[], options: IPickOptions = {}):
  Promise<T | undefined> {
    return this.show<T>(options, true, (box, listId, listeners, finish) => {
      const list = new QuickInputList(listId, items, box.input, finish);
      list.filter(box.input.value);
      listeners.add(addDisposableListener(box.input, 'input', () => list.filter(box.input.value)));
      listeners.add(addDisposableListener(box.input, 'keydown', event => handleKey(event, key => {
        switch (key) {
          case 'ArrowUp': list.move(-1); return true;
          case 'ArrowDown': list.move(1); return true;
          case 'Enter':
            if (list.activeItem !== undefined) {
              finish(list.activeItem);
            }
            return true;
          default: return false;
        }
      })));
      return list.element;
    });
  }

  input(options: IInputOptions = {}): Promise<string | undefined> {
    return this.show<string>(options, false, (box, _, listeners, finish) => {
      const validator = options.validateInput;
      let validation: { value: string; result: Promise<string | null | undefined> } | undefined;
      const validate = () => {
        if (!validator) {
          return;
        }
        const value = box.input.value;
        const result = Promise.resolve().then(() => validator(value)).catch(() => 'Could not validate this input.');
        validation = { value, result };
        void result.then(message => {
          if (validation?.result === result) {
            box.setValidation(message ?? undefined);
          }
        });
      };

      validate();
      listeners.add(addDisposableListener(box.input, 'input', validate));
      listeners.add(addDisposableListener(box.input, 'keydown', event => handleKey(event, key => {
        if (key !== 'Enter') {
          return false;
        }
        const value = box.input.value;
        if (validation?.value !== value) {
          validate();
        }
        const result = validation?.result;
        if (result) {
          void result.then(message => {
            if (validation?.result === result && !message && box.input.value === value) {
              finish(value);
            }
          });
        } else {
          finish(value);
        }
        return true;
      })));
    });
  }

  private show<T>(
    options: IInputOptions,
    hasList: boolean,
    configure: (
      box: QuickInputBox,
      listId: string,
      listeners: DisposableStore,
      finish: (result: T) => void,
    ) => HTMLElement | void,
  ): Promise<T | undefined> {
    if (this.disposed) {
      return Promise.resolve(undefined);
    }
    const container = this.layout.mainContainer;
    const document = container.ownerDocument;
    const window = document.defaultView!;
    const returnFocus = this.session ? this.session.returnFocus : getQuickInputFocus(document);
    this.session?.cancel(false);

    const id = 'wr-quick-input-' + ++nextId;
    const listId = id + '-list';
    const box = new QuickInputBox(id, options, hasList ? listId : undefined);
    const widget = $('div.wr-quick-input', null, box.element);
    const listeners = new DisposableStore();

    return new Promise<T | undefined>(resolve => {
      const finish = (result: T | undefined, restoreFocus = true) => {
        if (this.session !== session) {
          return;
        }
        this.session = undefined;
        listeners.dispose();
        widget.remove();
        if (restoreFocus && returnFocus?.isConnected) {
          returnFocus.focus({ preventScroll: true });
        }
        resolve(result);
      };
      const session: QuickInputSession = { returnFocus, cancel: restore => finish(undefined, restore) };
      this.session = session;
      const content = configure(box, listId, listeners, finish);
      if (content) {
        widget.append(content);
      }

      listeners.add(addDisposableListener(box.input, 'keydown', event => handleKey(event, key => {
        if (key !== 'Escape') {
          return false;
        }
        finish(undefined);
        return true;
      })));
      listeners.add(addDisposableListener(document, 'click', event => {
        if (!event.composedPath().includes(widget)) {
          finish(undefined);
        }
      }, true));
      listeners.add(addDisposableListener(window, 'pagehide', () => finish(undefined, false)));

      const layout = () => {
        const { left, top } = container.getBoundingClientRect();
        const { width, height } = this.layout.mainContainerDimension;
        const offset = this.layout.mainContainerOffset.quickPickTop;
        widget.style.left = left + width / 2 + 'px';
        widget.style.top = top + offset + 'px';
        widget.style.maxWidth = Math.max(0, width - 16) + 'px';
        widget.style.maxHeight = Math.max(0, height - offset - 8) + 'px';
      };
      layout();
      listeners.add(addDisposableListener(window, 'resize', layout));
      container.append(widget);
      box.input.focus({ preventScroll: true });
      box.input.select();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.session?.cancel();
  }
}
