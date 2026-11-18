import { $ } from '../../../base/browser/dom.js';
import type { IInputOptions } from '../common/quickInput.js';

export class QuickInputBox {
  readonly element = $('div.wr-quick-input-box');
  readonly input = $('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
  private readonly message = $('div.wr-quick-input-message', { role: 'status' });

  constructor(id: string, options: IInputOptions, listId?: string) {
    if (options.title) {
      this.element.append($('div.wr-quick-input-title', null, options.title));
    }
    this.input.setAttribute('aria-label', options.title ?? options.placeHolder ?? (listId ? 'Choose an item' : 'Enter text'));
    this.input.placeholder = options.placeHolder ?? '';
    this.input.value = options.value ?? '';
    if (listId) {
      this.input.setAttribute('role', 'combobox');
      this.input.setAttribute('aria-autocomplete', 'list');
      this.input.setAttribute('aria-controls', listId);
      this.input.setAttribute('aria-expanded', 'true');
    }

    this.element.append(this.input);
    const descriptions: string[] = [];
    if (options.prompt) {
      const promptId = id + '-prompt';
      this.element.append($('div.wr-quick-input-prompt', { id: promptId }, options.prompt));
      descriptions.push(promptId);
    }
    if (options.validateInput) {
      this.message.id = id + '-message';
      this.element.append(this.message);
      descriptions.push(this.message.id);
    }
    if (descriptions.length) {
      this.input.setAttribute('aria-describedby', descriptions.join(' '));
    }
  }

  setValidation(message: string | undefined): void {
    this.input.setAttribute('aria-invalid', String(Boolean(message)));
    this.message.textContent = message ?? '';
  }
}
