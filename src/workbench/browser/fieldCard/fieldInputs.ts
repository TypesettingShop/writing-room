import { Disposable } from '../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../base/browser/dom.js';
import type { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { SAVE_FILE_COMMAND_ID } from '../../contrib/files/browser/fileCommands.js';

export type FieldInputKind = 'text' | 'longText' | 'choice';

export interface FieldInputOptions {
  readonly label: string;
  readonly placeholder?: string;
  readonly options?: readonly string[];
}

export interface FieldInputEvents {
  readonly change: (value: string) => void;
  readonly compositionStart?: () => void;
  readonly compositionEnd?: () => void;
}

let fieldId = 0;

/** Native controls used by the card and field template editor. */
export class FieldInput extends Disposable {
  readonly element: HTMLDivElement;
  readonly control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  private readonly label: HTMLLabelElement;
  private readonly description: HTMLSpanElement;
  private options: readonly string[] = [];
  private choiceValue: HTMLInputElement | undefined;
  private _composing = false;
  private disposed = false;

  constructor(
    document: Document,
    readonly kind: FieldInputKind,
    private readonly events: FieldInputEvents,
    keybindings?: IKeybindingService,
    { saveCommandId = SAVE_FILE_COMMAND_ID }: { readonly saveCommandId?: string } = {},
  ) {
    super();
    this.element = document.createElement('div');
    this.element.className = 'character-field';
    this.label = this.element.appendChild(document.createElement('label'));
    this.control = this.element.appendChild(document.createElement(
      kind === 'longText' ? 'textarea' : kind === 'choice' ? 'select' : 'input',
    ));
    this.description = this.element.appendChild(document.createElement('span'));
    this.description.className = 'character-field-description';
    this.control.id = 'character-field-' + ++fieldId;
    this.label.htmlFor = this.control.id;
    this.description.id = this.control.id + '-description';
    if (this.control instanceof HTMLTextAreaElement) {
      this.control.rows = 2;
    }
    if (this.control instanceof HTMLSelectElement) {
      const copy = this.choiceValue = this.element.appendChild(document.createElement('input'));
      copy.readOnly = true;
      copy.hidden = true;
      copy.id = this.control.id + '-readonly';
    }

    const change = () => this.events.change(this.control.value);
    this._register(addDisposableListener(this.control, kind === 'choice' ? 'change' : 'input', change));
    if (kind !== 'choice') {
      this._register(addDisposableListener(this.control, 'compositionstart', () => {
        if (!this._composing) {
          this._composing = true;
          this.events.compositionStart?.();
        }
      }));
      this._register(addDisposableListener(this.control, 'compositionend', () => {
        if (this._composing) {
          change();
          this._composing = false;
          this.events.compositionEnd?.();
        }
      }));
      this._register(addDisposableListener(this.control, 'keydown', event => {
        if ((event.isComposing || event.keyCode === 229) && (event.ctrlKey || event.metaKey) && !event.defaultPrevented) {
          // Synchronize the native preedit before the workbench's Save command reads the draft.
          change();
          keybindings?.dispatchDuringComposition?.(event, [saveCommandId]);
        }
      }));
    }
  }

  get composing(): boolean { return this._composing; }

  update({ label, placeholder, options = [] }: FieldInputOptions): void {
    if (this.label.textContent !== label) {
      this.label.textContent = label;
    }
    if (this.description.textContent !== (placeholder ?? '')) {
      this.description.textContent = placeholder ?? '';
    }
    for (const control of [this.control, this.choiceValue]) {
      if (!control) {
        continue;
      }
      if (placeholder) {
        control.setAttribute('aria-describedby', this.description.id);
      } else {
        control.removeAttribute('aria-describedby');
      }
    }
    if (this.control instanceof HTMLSelectElement) {
      if (options.length !== this.options.length || options.some((value, index) => value !== this.options[index])) {
        this.options = options;
        this.setChoices(this.control, this.control.value);
      }
    } else if (this.control.placeholder !== (placeholder ?? '')) {
      this.control.placeholder = placeholder ?? '';
    }
  }

  setValue(value: string, readonly = false): void {
    if (this.composing) {
      return;
    }
    if (this.control instanceof HTMLSelectElement) {
      const copy = this.choiceValue!;
      copy.hidden = !readonly;
      this.control.hidden = readonly;
      this.label.htmlFor = readonly ? copy.id : this.control.id;
      copy.value = value;
      // An obsolete choice keeps its raw value until the writer makes a new selection.
      const choiceCount = 1 + this.options.length + Number(value !== '' && !this.options.includes(value));
      if (this.control.value !== value || this.control.options.length !== choiceCount) {
        this.setChoices(this.control, value);
      }
    } else {
      this.control.readOnly = readonly;
      if (this.control.value !== value) {
        this.control.value = value;
      }
    }
  }

  private setChoices(select: HTMLSelectElement, value: string): void {
    const choices = ['', ...this.options];
    if (!choices.includes(value)) {
      choices.push(value);
    }
    select.replaceChildren(...choices.map(choice => {
      const option = select.ownerDocument.createElement('option');
      option.value = choice;
      option.textContent = choice || '—';
      return option;
    }));
    select.value = value;
  }

  override dispose(): void {
    if (!this.disposed && this.composing) {
      // A pane can be replaced while its field still owns native preedit.
      this.events.change(this.control.value);
      this._composing = false;
      this.events.compositionEnd?.();
    }
    this.disposed = true;
    this.element.remove();
    super.dispose();
  }
}
