import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import {
  CharacterTemplateValidationError, isCharacterFieldId, normalizeCharacterTemplate,
  type CharacterFieldDefinition, type CharacterFieldKind,
} from '../../../../platform/characters/common/characterFields.js';
import { getDefaultCharacterTemplate } from '../../../../platform/characters/common/defaultCharacterTemplate.js';
import type { CharactersStore } from '../../../../platform/characters/common/charactersStore.js';
import { IDialogService, Severity, type IPromptHandle } from '../../../../platform/dialogs/common/dialogs.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { FieldInput } from '../../../browser/fieldCard/fieldInputs.js';

const kinds = new Map([['text', 'Text'], ['longText', 'Long Text'], ['choice', 'Choice']]);

export function newTemplateFieldId(used: ReadonlySet<string>, generate: () => string = () => globalThis.crypto.randomUUID()): string {
  const defaultIds = new Set(getDefaultCharacterTemplate().map(field => field.id));
  let id: string;
  do {
    id = generate();
  } while (!isCharacterFieldId(id) || used.has(id) || defaultIds.has(id));
  return id;
}

export async function readFieldValueCount(
  store: Pick<CharactersStore, 'getTree'>, workId: string, fieldId: string,
): Promise<number | undefined> {
  try {
    const { nodes } = await store.getTree(workId);
    return nodes.filter(node => node.kind === 'character' && !!node.values[fieldId]).length;
  } catch {
    return undefined;
  }
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  const result = [...items];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

function setMessage(element: HTMLElement, message: string): void {
  if (element.textContent !== message) {
    element.textContent = message;
  }
  if (element.hidden !== !message) {
    element.hidden = !message;
  }
}

interface DropTarget {
  readonly row: HTMLLIElement;
  readonly position: 'before' | 'after';
  readonly index: number;
}

interface FieldDrag {
  readonly id: string;
  readonly handle: HTMLElement;
  readonly pointerId: number;
  readonly startY: number;
  x: number;
  y: number;
}

export interface TemplateFieldListInput {
  readonly fields: readonly CharacterFieldDefinition[] | undefined;
  readonly onDidChangeState: Event<void>;
  setFields(fields: readonly CharacterFieldDefinition[]): void;
  beginComposition?(): IDisposable | undefined;
}

export interface TemplateFieldListHost {
  readonly reservedIds: () => Promise<ReadonlySet<string>>;
  readonly countValues: (fieldId: string) => Promise<number | undefined>;
  readonly defaultFields?: () => CharacterFieldDefinition[];
  readonly addedLabel: string;
  readonly addError: string;
  readonly deleteDetail: (count: number | undefined) => string;
  readonly validation?: () => readonly { fieldIndex?: number; detail: string }[];
}

export class CharacterTemplateFieldList extends Disposable {
  private readonly commands: HTMLDivElement;
  private readonly addButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement | undefined;
  private readonly summary: HTMLParagraphElement;
  private readonly list: HTMLUListElement;
  private readonly rows = new Map<string, TemplateFieldRow>();
  private composing = 0;
  private disposed = false;
  private adding = false;
  private checkingDelete = false;
  private prompt: IPromptHandle | undefined;
  private drag: FieldDrag | undefined;
  private marker: DropTarget | undefined;
  private scrollFrame: number | undefined;
  private renderedFields: readonly CharacterFieldDefinition[] | undefined;

  constructor(
    private readonly parent: HTMLElement,
    private readonly input: TemplateFieldListInput,
    private readonly host: TemplateFieldListHost,
    @IKeybindingService private readonly keybindings: IKeybindingService,
    @IDialogService private readonly dialogs: IDialogService,
    @INotificationService private readonly notifications: INotificationService,
  ) {
    super();
    this.commands = append(parent, $('div', { class: 'character-template-actions' }));
    this.addButton = this.button(this.commands, 'Add Field', () => void this.addField());
    if (host.defaultFields) {
      this.resetButton = this.button(this.commands, 'Reset to Default Template', () => void this.reset());
    }
    this.summary = append(parent, $('p', { class: 'character-template-problem', role: 'status', hidden: true }));
    this.list = append(parent, $('ul', { class: 'character-template-fields', 'aria-label': 'Template fields' }));

    this._register(input.onDidChangeState(() => this.render()));
    this._register(addDisposableListener(this.list, 'pointermove', event => this.hover(event)));
    this._register(addDisposableListener(this.list, 'pointerup', event => this.drop(event)));
    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      this._register(addDisposableListener(this.list, type, event => {
        if (event.pointerId === this.drag?.pointerId) {
          this.endDrag();
        }
      }));
    }
    this._register(addDisposableListener(this.list, 'keydown', event => {
      if (event.key === 'Escape' && this.drag) {
        this.endDrag();
      }
    }));
    this.render();
  }

  private button(parent: HTMLElement, label: string, run: () => void): HTMLButtonElement {
    const button = append(parent, $('button', { type: 'button' }, label));
    this._register(addDisposableListener(button, 'click', run));
    return button;
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    const fields = this.input.fields;
    this.commands.hidden = this.list.hidden = fields === undefined;
    this.addButton.disabled = this.composing > 0 || this.adding;
    if (this.resetButton) {
      this.resetButton.disabled = this.composing > 0;
    }
    if (this.composing || (!this.host.validation && fields === this.renderedFields)) {
      return;
    }
    this.renderedFields = fields;
    let validation: readonly { fieldIndex?: number; detail: string }[] = [];
    if (this.host.validation) {
      validation = this.host.validation();
    } else if (fields) {
      try {
        normalizeCharacterTemplate(fields);
      } catch (error) {
        if (!(error instanceof CharacterTemplateValidationError)) {
          throw error;
        }
        validation = [error];
      }
    }
    setMessage(this.summary, validation.find(problem => problem.fieldIndex === undefined)?.detail ?? '');
    const visibleFields = fields ?? [];
    const remaining = new Set(visibleFields.map(field => field.id));
    const active = this.parent.ownerDocument.activeElement;
    // Remove missing rows first so an existing row never has to move just to fill a removed slot.
    for (const [id, row] of this.rows) {
      if (!remaining.has(id)) {
        if (id === this.drag?.id) {
          this.endDrag();
        }
        this.rows.delete(id);
        row.dispose();
      }
    }
    let next = this.list.firstElementChild;
    for (const [index, field] of visibleFields.entries()) {
      let row = this.rows.get(field.id);
      if (!row) {
        row = this.createRow(field.id);
        this.rows.set(field.id, row);
      }
      row.update(field, index, visibleFields.length, validation.find(problem => problem.fieldIndex === index)?.detail ?? '');
      if (row.element === next) {
        next = next.nextElementSibling;
      } else if (this.list.isConnected && row.element.isConnected && this.list.moveBefore) {
        this.list.moveBefore(row.element, next);
      } else {
        this.list.insertBefore(row.element, next);
      }
    }
    if (active instanceof HTMLElement && this.list.contains(active) && this.parent.ownerDocument.activeElement !== active) {
      active.focus({ preventScroll: true });
    }
  }

  focusProblem(fieldId: string, option?: number | 'add'): void {
    const row = this.rows.get(fieldId);
    if (row) {
      row.focusProblem(option);
    } else {
      this.addButton.focus();
    }
  }

  private createRow(id: string): TemplateFieldRow {
    let composition: IDisposable | undefined;
    return new TemplateFieldRow(id, this.keybindings, {
      edit: change => {
        const fields = this.input.fields;
        if (fields?.some(field => field.id === id)) {
          this.input.setFields(fields.map(field => field.id === id ? change(field) : field));
        }
      },
      move: direction => {
        const index = this.input.fields?.findIndex(field => field.id === id) ?? -1;
        this.moveField(id, index + direction);
      },
      remove: () => void this.removeField(id),
      compositionStart: () => {
        this.composing++;
        composition = this.input.beginComposition?.();
        this.endDrag();
        this.render();
      },
      compositionEnd: () => {
        this.composing--;
        composition?.dispose();
        composition = undefined;
        this.render();
      },
      dragStart: (event, handle) => {
        if (this.composing || !event.isPrimary || event.button !== 0) {
          return;
        }
        this.endDrag();
        handle.setPointerCapture(event.pointerId);
        this.drag = { id, handle, pointerId: event.pointerId, startY: event.clientY, x: event.clientX, y: event.clientY };
      },
    });
  }

  private async addField(): Promise<void> {
    if (this.adding || this.composing || !this.input.fields) {
      return;
    }
    this.adding = true;
    this.render();
    try {
      const reserved = await this.host.reservedIds();
      const fields = this.input.fields;
      if (this.disposed || this.composing || !fields) {
        return;
      }
      const used = new Set([...reserved, ...fields.map(field => field.id)]);
      const id = newTemplateFieldId(used);
      this.input.setFields([...fields, { id, label: this.host.addedLabel, kind: 'text' }]);
      this.rows.get(id)?.focusLabel();
    } catch {
      if (!this.disposed) {
        this.notifications.error(this.host.addError);
      }
    } finally {
      this.adding = false;
      this.render();
    }
  }

  private async confirm(message: string, detail: string, action: string): Promise<boolean> {
    if (this.disposed || this.prompt || this.composing) {
      return false;
    }
    const prompt = this.prompt = this.dialogs.prompt({
      type: Severity.Warning, message, detail, buttons: ['Cancel', action], cancelButton: 0,
    });
    try {
      return await prompt.result === 1 && !this.disposed && !this.composing;
    } finally {
      this.prompt = undefined;
    }
  }

  private async reset(): Promise<void> {
    if (this.host.defaultFields && await this.confirm('Reset to Default Template?',
      'This replaces your template with the default fields. Saved values for those fields will be visible again after you save.',
      'Reset to Default Template')) {
      this.input.setFields(this.host.defaultFields());
    }
  }

  private async removeField(id: string): Promise<void> {
    if (this.checkingDelete || this.prompt || this.composing) {
      return;
    }
    this.checkingDelete = true;
    try {
      const count = await this.host.countValues(id);
      const field = this.input.fields?.find(field => field.id === id);
      if (!field || !await this.confirm(`Delete "${field.label || 'Untitled Field'}"?`,
        this.host.deleteDetail(count), 'Delete Field')) {
        return;
      }
    } finally {
      this.checkingDelete = false;
    }
    const fields = this.input.fields ?? [];
    const index = fields.findIndex(field => field.id === id);
    if (index >= 0) {
      this.input.setFields(fields.filter(field => field.id !== id));
      const adjacent = fields[index + 1] ?? fields[index - 1];
      (this.rows.get(adjacent?.id)?.element ?? this.addButton).focus({ preventScroll: true });
    }
  }

  private moveField(id: string, index: number): void {
    const fields = this.input.fields;
    const from = fields?.findIndex(field => field.id === id) ?? -1;
    if (this.composing || !fields || from < 0 || index < 0 || index >= fields.length || index === from) {
      return;
    }
    this.input.setFields(move(fields, from, index));
  }

  private target(drag: FieldDrag): DropTarget | undefined {
    const row = this.parent.ownerDocument.elementFromPoint(drag.x, drag.y)?.closest<HTMLLIElement>('[data-template-field]');
    const id = row?.dataset.templateField;
    const fields = this.input.fields;
    if (!row || !this.list.contains(row) || !id || !fields || id === drag.id) {
      return;
    }
    const bounds = row.getBoundingClientRect();
    const position = drag.y < bounds.top + bounds.height / 2 ? 'before' : 'after';
    const from = fields.findIndex(field => field.id === drag.id);
    const rowIndex = fields.findIndex(field => field.id === id);
    const boundary = rowIndex + Number(position === 'after');
    const index = boundary - Number(from < boundary);
    return from >= 0 && rowIndex >= 0 && from !== index ? { row, position, index } : undefined;
  }

  private hover(event: PointerEvent): void {
    const drag = this.drag;
    if (drag && event.pointerId === drag.pointerId) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.updateDrop(drag);
    }
  }

  private updateDrop(drag: FieldDrag): void {
    this.markDrop(this.target(drag));
    const scrollable = this.parent.closest<HTMLElement>('.character-template');
    if (!scrollable || Math.abs(drag.y - drag.startY) < 4 || this.scrollFrame !== undefined) {
      return;
    }
    const bounds = scrollable.getBoundingClientRect();
    const edge = 32;
    const speed = drag.y < bounds.top + edge ? -12 : drag.y > bounds.bottom - edge ? 12 : 0;
    if (speed && drag.x >= bounds.left && drag.x <= bounds.right) {
      const window = this.parent.ownerDocument.defaultView!;
      this.scrollFrame = window.requestAnimationFrame(() => {
        this.scrollFrame = undefined;
        if (this.drag === drag) {
          const before = scrollable.scrollTop;
          scrollable.scrollTop += speed;
          if (scrollable.scrollTop !== before) {
            this.updateDrop(drag);
          }
        }
      });
    }
  }

  private drop(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    const target = this.target(drag);
    this.endDrag();
    if (target) {
      this.moveField(drag.id, target.index);
      this.rows.get(drag.id)?.element.focus({ preventScroll: true });
    }
  }

  private markDrop(target: DropTarget | undefined): void {
    if (this.marker?.row === target?.row && this.marker?.position === target?.position) {
      this.marker = target;
      return;
    }
    if (this.marker) {
      delete this.marker.row.dataset.templateDrop;
    }
    this.marker = target;
    if (target) {
      target.row.dataset.templateDrop = target.position;
    }
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (drag?.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
    if (this.scrollFrame !== undefined) {
      this.parent.ownerDocument.defaultView!.cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = undefined;
    }
    this.markDrop(undefined);
  }

  override dispose(): void {
    this.disposed = true;
    this.prompt?.close();
    this.endDrag();
    for (const row of this.rows.values()) {
      row.dispose();
    }
    this.rows.clear();
    this.parent.replaceChildren();
    super.dispose();
  }
}

interface RowEvents {
  edit(change: (field: CharacterFieldDefinition) => CharacterFieldDefinition): void;
  move(direction: -1 | 1): void;
  remove(): void;
  compositionStart(): void;
  compositionEnd(): void;
  dragStart(event: PointerEvent, handle: HTMLElement): void;
}

class TemplateFieldRow extends Disposable {
  readonly element: HTMLLIElement;
  private readonly label: FieldInput;
  private readonly kind: FieldInput;
  private readonly section: FieldInput;
  private readonly placeholder: FieldInput;
  private readonly optionGroup: HTMLDivElement;
  private readonly addOption: HTMLButtonElement;
  private readonly options: HTMLDivElement;
  private readonly optionRows: TemplateOptionRow[] = [];
  private readonly up: HTMLButtonElement;
  private readonly down: HTMLButtonElement;
  private readonly error: HTMLParagraphElement;
  private shownField: CharacterFieldDefinition | undefined;

  constructor(id: string, private readonly keybindings: IKeybindingService, private readonly events: RowEvents) {
    super();
    this.element = $('li', { 'data-template-field': id, tabindex: 0 });
    const actions = append(this.element, $('div', { class: 'character-template-actions' }));
    const drag = append(actions, $('button', {
      type: 'button', class: 'character-template-drag', tabindex: -1,
      'aria-label': 'Drag Field to Reorder', title: 'Drag Field to Reorder',
    }, $('span.codicon.codicon-gripper', { 'aria-hidden': true })));
    this._register(addDisposableListener(drag, 'pointerdown', event => events.dragStart(event, drag)));
    this.up = this.button(actions, 'Move Up', () => events.move(-1));
    this.down = this.button(actions, 'Move Down', () => events.move(1));
    this.button(actions, 'Delete Field', events.remove);
    this._register(addDisposableListener(this.element, 'keydown', event => {
      if (event.target === this.element && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && !event.isComposing && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        event.stopPropagation();
        events.move(event.key === 'ArrowUp' ? -1 : 1);
      }
    }));

    const controls = append(this.element, $('div', { class: 'character-template-controls' }));
    this.label = this.field(controls, 'text', 'Label', value => events.edit(field => ({ ...field, label: value })));
    this.kind = this.field(controls, 'choice', 'Kind', value => {
      for (const [kind, title] of kinds) {
        if (title === value) {
          events.edit(field => {
            if (field.kind === kind) {
              return field;
            }
            const { options: _options, ...rest } = field;
            return { ...rest, kind, ...(kind === 'choice' ? { options: [] } : {}) };
          });
          return;
        }
      }
      // The shared select uses an empty option. A field always has a kind.
      this.kind.control.value = this.kind.control.dataset.currentKind ?? '';
    });
    this.section = this.field(controls, 'text', 'Section', value => events.edit(field => ({ ...field, section: value })));
    this.placeholder = this.field(controls, 'longText', 'Placeholder', value =>
      events.edit(field => ({ ...field, placeholder: value })));
    this.optionGroup = append(this.element, $('div', { class: 'character-template-option-group', role: 'group', 'aria-label': 'Options' }));
    this.options = append(this.optionGroup, $('div', { class: 'character-template-options' }));
    const optionActions = append(this.optionGroup, $('div', { class: 'character-template-actions' }));
    this.addOption = this.button(optionActions, 'Add Option', () => {
      events.edit(field => ({ ...field, options: [...field.options ?? [], ''] }));
      this.optionRows.at(-1)?.input.control.focus();
    });
    this.error = append(this.element, $('p', { class: 'character-template-problem', role: 'status', hidden: true }));
    this.error.id = this.label.control.id + '-error';
    this.element.setAttribute('aria-describedby', this.error.id);
  }

  focusLabel(): void {
    this.label.control.focus();
    (this.label.control as HTMLInputElement).select();
  }

  /** Focuses the option at that index, or Add Option for `'add'`. Any other problem starts at the label. */
  focusProblem(option?: number | 'add'): void {
    const control = option === 'add' ? this.addOption : option === undefined ? undefined : this.optionRows[option]?.input.control;
    if (control) {
      control.focus();
    } else {
      this.focusLabel();
    }
  }

  update(field: CharacterFieldDefinition, index: number, count: number, error: string): void {
    const active = this.element.ownerDocument.activeElement;
    const first = index === 0;
    const last = index === count - 1;
    if (this.up.disabled !== first) {
      this.up.disabled = first;
    }
    if (this.down.disabled !== last) {
      this.down.disabled = last;
    }
    if ((this.up.disabled && active === this.up) || (this.down.disabled && active === this.down)) {
      this.element.focus({ preventScroll: true });
    }
    setMessage(this.error, error);
    if (this.shownField === field) {
      return;
    }
    this.shownField = field;
    this.element.setAttribute('aria-label', field.label || 'Untitled Field');
    this.label.setValue(field.label);
    const unknown = !kinds.has(field.kind);
    const kindLabel = unknown ? `Unknown Kind (${field.kind})` : kinds.get(field.kind)!;
    this.kind.update({ label: 'Kind', options: [...kinds.values(), ...(unknown ? [kindLabel] : [])] });
    this.kind.setValue(kindLabel);
    this.kind.control.dataset.currentKind = kindLabel;
    if (this.kind.control instanceof HTMLSelectElement) {
      this.kind.control.options[0].hidden = true;
    }
    this.section.setValue(field.section ?? '');
    this.placeholder.setValue(field.placeholder ?? '');
    this.optionGroup.hidden = field.kind !== 'choice';
    this.updateOptions(field.kind === 'choice' ? field.options ?? [] : []);
  }

  private field(parent: HTMLElement, kind: CharacterFieldKind, label: string, change: (value: string) => void): FieldInput {
    const input = this._register(new FieldInput(parent.ownerDocument, kind, {
      change, compositionStart: this.events.compositionStart, compositionEnd: this.events.compositionEnd,
    }, this.keybindings));
    input.update({ label });
    parent.append(input.element);
    return input;
  }

  private button(parent: HTMLElement, label: string, run: () => void): HTMLButtonElement {
    const button = append(parent, $('button', { type: 'button' }, label));
    this._register(addDisposableListener(button, 'click', run));
    return button;
  }

  private updateOptions(values: readonly string[]): void {
    while (this.optionRows.length > values.length) {
      this.optionRows.pop()!.dispose();
    }
    for (const [index, value] of values.entries()) {
      let row = this.optionRows[index];
      if (!row) {
        row = new TemplateOptionRow(this.options, index, this.keybindings, this.events);
        this.optionRows.push(row);
      }
      row.update(value, index === 0, index === values.length - 1);
    }
  }

  override dispose(): void {
    for (const option of this.optionRows) {
      option.dispose();
    }
    this.element.remove();
    super.dispose();
  }
}

class TemplateOptionRow extends Disposable {
  readonly input: FieldInput;
  private readonly element: HTMLDivElement;
  private readonly up: HTMLButtonElement;
  private readonly down: HTMLButtonElement;

  constructor(parent: HTMLElement, index: number, keybindings: IKeybindingService, events: RowEvents) {
    super();
    this.element = append(parent, $('div', { class: 'character-template-option' }));
    const edit = (change: (options: readonly string[]) => string[]) => events.edit(field =>
      field.kind === 'choice' && index < (field.options?.length ?? 0) ? { ...field, options: change(field.options!) } : field);
    this.input = this._register(new FieldInput(parent.ownerDocument, 'text', {
      change: value => edit(options => options.map((option, position) => position === index ? value : option)),
      compositionStart: events.compositionStart, compositionEnd: events.compositionEnd,
    }, keybindings));
    this.input.update({ label: `Option ${index + 1}` });
    this.element.append(this.input.element);
    const actions = append(this.element, $('div', { class: 'character-template-actions' }));
    const button = (label: string, change: (options: readonly string[]) => string[]) => {
      const control = append(actions, $('button', { type: 'button' }, label));
      this._register(addDisposableListener(control, 'click', () => edit(change)));
      return control;
    };
    this.up = button('Move Option Up', options => index > 0 ? move(options, index, index - 1) : [...options]);
    this.down = button('Move Option Down', options => index < options.length - 1 ? move(options, index, index + 1) : [...options]);
    button('Delete Option', options => options.filter((_, position) => position !== index));
  }

  update(value: string, first: boolean, last: boolean): void {
    this.input.setValue(value);
    this.up.disabled = first;
    this.down.disabled = last;
  }

  override dispose(): void {
    super.dispose();
    this.element.remove();
  }
}
