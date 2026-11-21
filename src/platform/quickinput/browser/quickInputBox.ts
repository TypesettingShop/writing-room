import { $ } from '../../../base/browser/dom.js';
import { Severity } from '../common/quickInput.js';
import type { IQuickInputButton } from '../common/quickInput.js';

export interface IQuickInputBoxState {
  readonly title: string | undefined;
  readonly step: number | undefined;
  readonly totalSteps: number | undefined;
  readonly placeholder: string | undefined;
  readonly prompt: string | undefined;
  readonly validationMessage: string | undefined;
  readonly severity: Severity;
  readonly password: boolean;
  readonly busy: boolean;
  readonly enabled: boolean;
  readonly buttons: readonly IQuickInputButton[];
}

const severityClass: Record<Severity, string> = {
  [Severity.Ignore]: '', [Severity.Info]: 'info', [Severity.Warning]: 'warning', [Severity.Error]: 'error',
};

/** The top of a quick input: title row, field, prompt and validation message. Text goes in as text only. */
export class QuickInputBox {
  readonly element = $('div.wr-quick-input-box');
  readonly input = $('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
  private readonly header = $('div.wr-quick-input-header');
  private readonly title = $('div.wr-quick-input-title');
  private readonly steps = $('span.wr-quick-input-steps');
  private readonly buttons = $('div.wr-quick-input-buttons');
  private readonly prompt: HTMLElement;
  private readonly message: HTMLElement;
  private readonly progress = $('div.wr-quick-input-progress', { 'aria-hidden': 'true' });
  private renderedButtons: readonly IQuickInputButton[] = [];

  constructor(id: string, private readonly defaultLabel: string, private readonly onButton: (button: IQuickInputButton) => void, listId?: string) {
    if (listId) {
      this.input.setAttribute('role', 'combobox');
      this.input.setAttribute('aria-autocomplete', 'list');
      this.input.setAttribute('aria-controls', listId);
      this.input.setAttribute('aria-expanded', 'true');
    }
    this.prompt = $('div.wr-quick-input-prompt', { id: id + '-prompt' });
    this.message = $('div.wr-quick-input-message', { id: id + '-message', role: 'status' });
    this.header.append(this.title, this.steps, this.buttons);
    this.element.append(this.header, this.input, this.prompt, this.message, this.progress);
  }

  update(state: IQuickInputBoxState): void {
    const title = state.title ?? '';
    if (this.title.textContent !== title) {
      this.title.textContent = title;
    }
    const steps = state.step !== undefined ? state.step + (state.totalSteps !== undefined ? '/' + state.totalSteps : '') : '';
    if (this.steps.textContent !== steps) {
      this.steps.textContent = steps;
    }
    this.renderButtons(state.buttons);
    this.header.hidden = !title && !steps && !state.buttons.length;
    this.title.hidden = !title;

    this.input.setAttribute('aria-label', state.title || state.placeholder || this.defaultLabel);
    this.input.placeholder = state.placeholder ?? '';
    const type = state.password ? 'password' : 'text';
    if (this.input.type !== type) {
      this.input.type = type;
    }
    this.input.readOnly = !state.enabled;
    this.input.toggleAttribute('aria-disabled', !state.enabled);

    const prompt = state.prompt ?? '';
    if (this.prompt.textContent !== prompt) {
      this.prompt.textContent = prompt;
    }
    this.prompt.hidden = !prompt;
    const message = state.validationMessage ?? '';
    if (this.message.textContent !== message) {
      this.message.textContent = message;
    }
    const severity = message ? severityClass[state.severity] : '';
    this.message.className = 'wr-quick-input-message' + (severity ? ' ' + severity : '');
    this.input.setAttribute('aria-invalid', String(Boolean(message) && state.severity === Severity.Error));
    this.input.setAttribute('aria-describedby', [...prompt ? [this.prompt.id] : [], this.message.id].join(' '));
    this.progress.hidden = !state.busy;
  }

  /** Sets the field's text; a text that is already there keeps its caret. */
  setValue(value: string): void {
    if (this.input.value !== value) {
      this.input.value = value;
    }
  }

  private renderButtons(buttons: readonly IQuickInputButton[]): void {
    if (buttons.length === this.renderedButtons.length && buttons.every((button, index) => button === this.renderedButtons[index])) {
      return;
    }
    this.renderedButtons = buttons;
    this.buttons.replaceChildren(...buttons.map(button => {
      const element = $('button.wr-quick-input-button', { type: 'button', tabindex: '-1' });
      const icon = button.icon && /^[a-z\d-]+$/i.test(button.icon) ? button.icon : undefined;
      const label = button.tooltip || icon || 'Button';
      if (icon) {
        element.classList.add('codicon', 'codicon-' + icon);
        element.setAttribute('aria-label', label);
        element.title = label;
      } else {
        element.textContent = label;
      }
      element.addEventListener('click', () => this.onButton(button));
      return element;
    }));
  }
}
