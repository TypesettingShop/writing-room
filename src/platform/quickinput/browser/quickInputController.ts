import { addDisposableListener } from '../../../base/browser/dom.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import type { ILayoutService } from '../../layout/browser/layoutService.js';
import { Severity } from '../common/quickInput.js';
import type { IInputBox, IInputOptions, IPickOptions, IQuickInputButton, IQuickPick, IQuickPickItem, IQuickPickSeparator } from '../common/quickInput.js';
import { handleKey, InputBox, QuickPick } from './quickInput.js';
import type { IQuickInputHost, QuickInput } from './quickInput.js';
import './quickInput.css';

interface QuickInputSession {
  readonly input: QuickInput;
  readonly returnFocus: HTMLElement | undefined;
  close(restoreFocus: boolean): void;
}

const widgetReturnFocus = new WeakMap<Element, HTMLElement | undefined>();

/** The focused element; while focus is in an open quick input, the element that quick input gives focus back to. */
export function getQuickInputFocus(document: Document): HTMLElement | undefined {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  const widget = element?.closest('.wr-quick-input');
  if (widget && widgetReturnFocus.has(widget)) {
    return widgetReturnFocus.get(widget);
  }
  return element instanceof HTMLElement ? element : undefined;
}

export const backButton: IQuickInputButton = Object.freeze({ icon: 'arrow-left', tooltip: 'Back' });

/** Shows one quick input at a time: showing another hides the current one, which then reports that it hid. */
export class QuickInputController implements IQuickInputHost {
  private session: QuickInputSession | undefined;
  private disposed = false;

  constructor(private readonly layout: ILayoutService) {}

  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
    return new QuickPick<T>(this);
  }

  createInputBox(): IInputBox {
    return new InputBox(this);
  }

  pick<T extends IQuickPickItem>(items: readonly (T | IQuickPickSeparator)[], options: IPickOptions = {}):
  Promise<T | undefined> {
    return new Promise(resolve => {
      const picker = new QuickPick<T>(this);
      picker.title = options.title;
      picker.placeholder = options.placeHolder;
      picker.value = options.value ?? '';
      picker.matchOnDescription = true;
      picker.items = items;
      let result: T | undefined;
      picker.onDidAccept(() => {
        result = picker.selectedItems[0];
        if (result !== undefined) {
          picker.hide();
        }
      });
      picker.onDidHide(() => {
        picker.dispose();
        resolve(result);
      });
      picker.show();
      if (!picker.visible) {
        picker.dispose();
        resolve(undefined);
      }
    });
  }

  input(options: IInputOptions = {}): Promise<string | undefined> {
    return new Promise(resolve => {
      const box = new InputBox(this);
      box.title = options.title;
      box.placeholder = options.placeHolder;
      box.prompt = options.prompt;
      box.value = options.value ?? '';
      const validator = options.validateInput;
      let validation: { value: string; result: Promise<string | null | undefined> } | undefined;
      const validate = () => {
        if (!validator) {
          return;
        }
        const value = box.value;
        const result = Promise.resolve().then(() => validator(value)).catch(() => 'Could not validate this input.');
        validation = { value, result };
        void result.then(message => {
          if (validation?.result === result) {
            box.validationMessage = message ?? undefined;
            box.severity = message ? Severity.Error : Severity.Ignore;
          }
        });
      };
      let result: string | undefined;
      box.onDidChangeValue(validate);
      box.onDidAccept(() => {
        const value = box.value;
        if (validation?.value !== value) {
          validate();
        }
        const pending = validation?.result;
        if (!pending) {
          result = value;
          box.hide();
          return;
        }
        void pending.then(message => {
          // A result that arrives after the value changed, or for an older value, accepts nothing.
          if (validation?.result === pending && !message && box.value === value && box.visible) {
            result = value;
            box.hide();
          }
        });
      });
      box.onDidHide(() => {
        box.dispose();
        resolve(result);
      });
      validate();
      box.show();
      if (!box.visible) {
        box.dispose();
        resolve(undefined);
      }
    });
  }

  hide(input: QuickInput): void {
    if (this.session?.input === input) {
      this.session.close(true);
    }
  }

  show(input: QuickInput): void {
    if (this.disposed || this.session?.input === input) {
      return;
    }
    const container = this.layout.mainContainer;
    const document = container.ownerDocument;
    const window = document.defaultView!;
    const returnFocus = this.session ? this.session.returnFocus : getQuickInputFocus(document);
    this.session?.close(false);

    const listeners = new DisposableStore();
    const { element: widget, field, focused } = input.open(listeners);
    widgetReturnFocus.set(widget, returnFocus);
    const close = (restoreFocus: boolean) => {
      if (this.session !== session) {
        return;
      }
      this.session = undefined;
      listeners.dispose();
      widget.remove();
      if (restoreFocus && returnFocus?.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
      input.closed();
    };
    const session: QuickInputSession = { input, returnFocus, close };
    this.session = session;

    listeners.add(addDisposableListener(field, 'keydown', event => handleKey(event, key => {
      if (key === 'Escape') {
        close(true);
        return true;
      }
      // As in VS Code, Tab keeps focus in the quick input, where Escape still reaches it.
      return key === 'Tab';
    })));
    // Pressing the title, prompt, rows or padding keeps focus in the input, and clicks on rows still arrive.
    listeners.add(addDisposableListener(widget, 'mousedown', event => {
      if (event.target !== field) {
        event.preventDefault();
      }
    }));
    // Focus moved to another element, by a click or a command, cancels and stays where it went.
    listeners.add(addDisposableListener(widget, 'focusout', event => {
      if (!input.ignoreFocusOut && event.relatedTarget instanceof Node && !widget.contains(event.relatedTarget)) {
        close(false);
      }
    }));
    // A press that starts in the widget, such as selecting the input's text, may be released outside.
    let pressedInside = false;
    listeners.add(addDisposableListener(document, 'mousedown', event => {
      pressedInside = event.composedPath().includes(widget);
    }, true));
    listeners.add(addDisposableListener(document, 'click', event => {
      const inside = pressedInside || event.composedPath().includes(widget);
      pressedInside = false;
      if (!inside && !input.ignoreFocusOut) {
        close(true);
      }
    }, true));
    listeners.add(addDisposableListener(window, 'pagehide', () => close(false)));

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
    field.focus({ preventScroll: true });
    focused();
  }

  dispose(): void {
    this.disposed = true;
    this.session?.close(true);
  }
}
