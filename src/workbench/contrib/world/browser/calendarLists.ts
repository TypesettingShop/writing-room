import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IDialogService, Severity } from '../../../../platform/dialogs/common/dialogs.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { getGregorianCalendar, type Calendar, type CalendarEra, type CalendarMonth } from '../../../../platform/world/common/calendar.js';
import { FieldInput } from '../../../browser/fieldCard/fieldInputs.js';
import { parseIntegerInput } from '../../../browser/time/integerInput.js';
import type { CalendarModel } from './calendarModel.js';

function showProblem(element: HTMLElement, message: string): void {
  if (element.textContent !== message) {
    element.textContent = message;
  }
  element.hidden = !message;
}

function showNumber(input: FieldInput, value?: number): void {
  if (!Object.is(parseIntegerInput(input.control.value), value)) {
    input.setValue(value === undefined || Number.isNaN(value) ? '' : String(value));
  }
}

type Row = CalendarEra | CalendarMonth;
const gregorian = getGregorianCalendar();

export class CalendarLists extends Disposable {
  private readonly presetPrompt = this._register(new MutableDisposable());
  private readonly subscriptions = this._register(new DisposableStore());
  private readonly eras: CalendarRows<CalendarEra>;
  private readonly months: CalendarRows<CalendarMonth>;
  private readonly hours: FieldInput;
  private readonly problem: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly model: CalendarModel,
    @IKeybindingService private readonly keybindings: IKeybindingService,
    @IDialogService private readonly dialogs: IDialogService,
  ) {
    super();
    const card = model.card!;
    const preset = append(parent, $('button', { type: 'button' }, 'Use Gregorian Calendar'));
    this._register(addDisposableListener(preset, 'click', () => { void this.useGregorian(); }));
    this.eras = this._register(new CalendarRows(parent, 'Era', model, keybindings, () => card.draft.eras,
      eras => card.edit({ ...card.draft, eras }), id => ({ id, name: '', countsDown: false, startYear: 1 })));
    this.months = this._register(new CalendarRows(parent, 'Month', model, keybindings, () => card.draft.months,
      months => card.edit({ ...card.draft, months }), id => ({ id, name: '', days: 30 })));
    const time = append(parent, $('section.calendar-list'));
    append(time, $('h2', undefined, 'Time'));
    this.hours = this._register(createField('Hours per Day', model, keybindings,
      value => card.edit({ ...card.draft, hoursPerDay: parseIntegerInput(value) ?? NaN }), true));
    time.appendChild(this.hours.element);
    this.problem = append(time, $('p.calendar-problem', { id: this.hours.control.id + '-problem', hidden: true }));
    this.hours.control.setAttribute('aria-describedby', this.problem.id);

    this.subscriptions.add(card.onDidChange(() => this.render()));
    this.subscriptions.add(card.onDidRequestSaveBlockFocus(block => {
      if (block.kind === 'validation' && parent.isConnected && parent.closest('.calendar-editor')?.contains(parent.ownerDocument.activeElement)) {
        this.focusProblem(block.problems[0]?.fieldId);
      }
    }));
    this.render();
  }

  private focusProblem(fieldId: string | undefined): void {
    if (!fieldId || fieldId === 'calendar') {
      this.hours.control.focus();
    } else if (fieldId === 'eras' || fieldId === 'months') {
      (fieldId === 'eras' ? this.eras : this.months).focusAdd();
    } else {
      const [kind, index] = fieldId.split('-');
      (kind === 'era' ? this.eras : this.months).focusRow(Number(index));
    }
  }

  private render(): void {
    const card = this.model.card!;
    const { saveBlock, draft } = card;
    const problems = saveBlock?.kind === 'validation' ? saveBlock.problems : [];
    this.eras.render(problems);
    this.months.render(problems);
    showNumber(this.hours, draft.hoursPerDay);
    const message = problems.find(problem => problem.fieldId === 'calendar')?.message ?? '';
    showProblem(this.problem, message);
    this.hours.control.setAttribute('aria-invalid', String(!!message));
  }

  private async useGregorian(): Promise<void> {
    const { card, saved } = this.model;
    if (!card || this.model.composing || this.presetPrompt.value) {
      return;
    }
    const draft = card.draft;
    if (JSON.stringify(saved) !== JSON.stringify(gregorian) || card.dirty) {
      const prompt = this.dialogs.prompt({
        type: Severity.Warning,
        message: 'Replace this calendar draft with the Gregorian calendar?',
        buttons: ['Use Gregorian Calendar', 'Cancel'],
        cancelButton: 1,
      });
      this.presetPrompt.value = toDisposable(() => prompt.close());
      const choice = await prompt.result;
      this.presetPrompt.clear();
      if (choice !== 0 || card.draft !== draft || this.model.composing) {
        return;
      }
    }
    card.edit(getGregorianCalendar());
  }
}

function createField(
  label: string, model: CalendarModel, keybindings: IKeybindingService, change: (value: string) => void, numeric = false,
): FieldInput {
  const composition = new MutableDisposable();
  const field = new FieldInput(document, 'text', {
    change,
    compositionStart: () => { composition.value = model.beginComposition(); },
    compositionEnd: () => composition.clear(),
  }, keybindings);
  field.update({ label });
  if (numeric) {
    field.control.inputMode = 'numeric';
  }
  return field;
}

class CalendarRows<T extends Row> extends Disposable {
  private readonly list: HTMLOListElement;
  private readonly add: HTMLButtonElement;
  private readonly problem: HTMLElement;
  private readonly nodes = new Map<string, CalendarRow<T>>();
  private dragging?: string;

  constructor(
    parent: HTMLElement,
    private readonly kind: 'Era' | 'Month',
    private readonly model: CalendarModel,
    private readonly keybindings: IKeybindingService,
    private readonly read: () => readonly T[],
    private readonly edit: (rows: T[]) => void,
    private readonly create: (id: string) => T,
  ) {
    super();
    const section = append(parent, $('section.calendar-list'));
    append(section, $('h2', undefined, kind === 'Era' ? 'Eras' : 'Months'));
    this.list = append(section, $('ol', { 'aria-label': kind === 'Era' ? 'Eras' : 'Months' }));
    this.add = append(section, $('button', { type: 'button' }, `Add ${kind}`));
    this.problem = append(section, $('p.calendar-problem', { hidden: true }));
    this._register(addDisposableListener(this.add, 'click', () => {
      const id = this.model.newRowId();
      this.edit([...this.read(), this.create(id)]);
      this.nodes.get(id)?.name.control.focus();
    }));
  }

  render(problems: readonly { fieldId: string; message: string }[]): void {
    const rows = this.read();
    const kind = this.kind.toLowerCase();
    showProblem(this.problem, problems.find(problem => problem.fieldId === `${kind}s`)?.message ?? '');
    const ids = new Set(rows.map(row => row.id));
    for (const [id, node] of this.nodes) {
      if (!ids.has(id)) {
        this.nodes.delete(id);
        node.dispose();
      }
    }
    const focused = this.list.ownerDocument.activeElement;
    let next: HTMLElement | null = null;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      const node = this.nodes.get(row.id) ?? this.createRow(row.id);
      node.render(row, index, rows.length);
      node.showProblem(problems.find(problem => problem.fieldId === `${kind}-${index}`)?.message ?? '');
      // Move siblings around the focused row so its native composition survives reorder.
      if (node.element.nextSibling !== next || node.element.parentElement !== this.list) {
        if (!node.element.contains(focused)) {
          this.list.insertBefore(node.element, next);
        }
      }
      next = node.element;
    }
  }

  focusAdd(): void {
    this.add.focus();
  }

  focusRow(index: number): void {
    const row = this.read()[index];
    if (row) {
      this.nodes.get(row.id)?.name.control.focus();
    }
  }

  private createRow(id: string): CalendarRow<T> {
    const node = new CalendarRow<T>(this.kind, this.model, this.keybindings,
      update => this.edit(this.read().map(row => row.id === id ? update(row) : row)),
      delta => this.move(id, this.read().findIndex(row => row.id === id) + delta),
      () => {
        const index = this.read().findIndex(row => row.id === id);
        this.edit(this.read().filter(row => row.id !== id));
        if (this.read().length) {
          this.focusRow(Math.min(index, this.read().length - 1));
        } else {
          this.add.focus();
        }
      });
    this.nodes.set(id, node);
    node.listen(node.grip, 'dragstart', event => {
      this.dragging = id;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', id);
      }
    });
    node.listen(node.grip, 'dragend', () => { this.dragging = undefined; });
    node.listen(node.element, 'dragover', event => {
      if (this.dragging && this.dragging !== id) {
        event.preventDefault();
      }
    });
    node.listen(node.element, 'drop', event => {
      if (this.dragging && this.dragging !== id) {
        event.preventDefault();
        this.move(this.dragging, this.read().findIndex(row => row.id === id));
        this.dragging = undefined;
      }
    });
    return node;
  }

  private move(id: string, destination: number): void {
    const rows = [...this.read()];
    const source = rows.findIndex(row => row.id === id);
    if (source < 0 || destination < 0 || destination >= rows.length || source === destination) {
      return;
    }
    const [row] = rows.splice(source, 1);
    rows.splice(destination, 0, row);
    this.edit(rows);
  }

  override dispose(): void {
    for (const node of this.nodes.values()) {
      node.dispose();
    }
    this.nodes.clear();
    super.dispose();
  }
}

class CalendarRow<T extends Row> extends Disposable {
  readonly element = $('li.calendar-row');
  readonly name: FieldInput;
  readonly grip: HTMLElement;
  private readonly up: HTMLButtonElement;
  private readonly down: HTMLButtonElement;
  private readonly problem: HTMLElement;
  private countsDown?: HTMLInputElement;
  private start?: FieldInput;
  private end?: FieldInput;
  private days?: FieldInput;

  constructor(
    kind: 'Era' | 'Month', model: CalendarModel, keybindings: IKeybindingService,
    edit: (update: (row: T) => T) => void, move: (delta: number) => void, remove: () => void,
  ) {
    super();
    const fields = append(this.element, $('.calendar-row-fields'));
    this.name = this._register(createField('Name', model, keybindings, name => edit(row => ({ ...row, name }))));
    fields.appendChild(this.name.element);
    if (kind === 'Era') {
      const label = append(fields, $('label.calendar-counts-down'));
      const checkbox = this.countsDown = append(label, $('input', { type: 'checkbox' }));
      label.append('Counts Down');
      this.listen(checkbox, 'change', () => edit(row => {
        const { id, name } = row;
        return (checkbox.checked ? { id, name, countsDown: true } : { id, name, countsDown: false, startYear: 1 }) as T;
      }));
      this.start = this._register(createField('Start Year', model, keybindings,
        value => edit(row => ({ ...row, startYear: parseIntegerInput(value) ?? NaN })), true));
      this.end = this._register(createField('End Year', model, keybindings,
        value => edit(row => ({ ...row, endYear: parseIntegerInput(value) })), true));
      fields.append(this.start.element, this.end.element);
    } else {
      this.days = this._register(createField('Days', model, keybindings,
        value => edit(row => ({ ...row, days: parseIntegerInput(value) ?? NaN })), true));
      fields.appendChild(this.days.element);
    }
    const actions = append(this.element, $('.calendar-actions'));
    this.grip = append(actions, $('span.calendar-grip', { draggable: true, title: 'Drag to reorder', 'aria-hidden': true }, '⋮⋮'));
    this.up = append(actions, $('button', { type: 'button' }, 'Move Up'));
    this.down = append(actions, $('button', { type: 'button' }, 'Move Down'));
    const del = append(actions, $('button', { type: 'button' }, 'Delete'));
    this.listen(this.up, 'click', () => move(-1));
    this.listen(this.down, 'click', () => move(1));
    this.listen(del, 'click', () => { if (!model.composing) { remove(); } });
    this.listen(this.element, 'keydown', event => {
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        move(event.key === 'ArrowUp' ? -1 : 1);
      }
    });
    this.problem = append(this.element, $('p.calendar-problem', { id: this.name.control.id + '-problem', hidden: true }));
    for (const field of [this.name, this.start, this.end, this.days]) {
      field?.control.setAttribute('aria-describedby', this.problem.id);
    }
  }

  listen<K extends keyof HTMLElementEventMap>(element: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void): void {
    this._register(addDisposableListener(element, type, listener));
  }

  render(row: Row, index: number, total: number): void {
    this.name.setValue(row.name);
    if ('countsDown' in row && this.countsDown && this.start && this.end) {
      this.countsDown.checked = row.countsDown;
      for (const field of [this.start, this.end]) {
        (field.control as HTMLInputElement).disabled = row.countsDown;
      }
      showNumber(this.start, row.startYear);
      showNumber(this.end, row.endYear);
    }
    if ('days' in row && this.days) {
      showNumber(this.days, row.days);
    }
    // Retain keyboard focus when a move puts the current button at a list boundary.
    this.up.setAttribute('aria-disabled', String(index === 0));
    this.down.setAttribute('aria-disabled', String(index === total - 1));
  }

  showProblem(message: string): void {
    showProblem(this.problem, message);
    for (const field of [this.name, this.start, this.end, this.days]) {
      field?.control.setAttribute('aria-invalid', String(!!message));
    }
  }

  override dispose(): void {
    super.dispose();
    this.element.remove();
  }
}
