import { $, addDisposableListener } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Severity } from '../common/quickInput.js';
import type { IInputBox, IQuickInput, IQuickInputButton, IQuickPick, IQuickPickItem, IQuickPickSeparator } from '../common/quickInput.js';
import { QuickInputBox } from './quickInputBox.js';
import { QuickInputList } from './quickInputList.js';

/** What a quick input hands its controller when it is shown. */
export interface IQuickInputWidget {
  readonly element: HTMLElement;
  readonly field: HTMLInputElement;
  /** Puts the caret where it belongs once the field has focus. */
  focused(): void;
}

export interface IQuickInputHost {
  show(input: QuickInput): void;
  hide(input: QuickInput): void;
}

let nextId = 0;

export function handleKey(event: KeyboardEvent, handler: (key: string) => boolean): void {
  if (event.isComposing || event.keyCode === 229 || !handler(event.key)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

/** Selects `selection` of the field's text, clamped to it, or the whole text without one. */
function applySelection(input: HTMLInputElement, selection: readonly [number, number] | undefined): void {
  if (selection) {
    const length = input.value.length;
    const start = Math.max(0, Math.min(length, selection[0]));
    input.setSelectionRange(start, Math.max(start, Math.min(length, selection[1])));
  } else {
    input.select();
  }
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * The state of one quick input. Its widget exists only while it is shown; setting a property while it
 * is shown updates the widget in place.
 */
export abstract class QuickInput extends Disposable implements IQuickInput {
  private _title: string | undefined;
  private _step: number | undefined;
  private _totalSteps: number | undefined;
  private _enabled = true;
  private _busy = false;
  private _ignoreFocusOut = false;
  protected _buttons: readonly IQuickInputButton[] = [];
  private shown: DisposableStore | undefined;
  private disposed = false;

  private readonly didHide = this._register(new Emitter<void>());
  readonly onDidHide = this.didHide.event;
  protected readonly didTriggerButton = this._register(new Emitter<IQuickInputButton>());
  readonly onDidTriggerButton = this.didTriggerButton.event;

  constructor(private readonly host: IQuickInputHost) {
    super();
  }

  get title() { return this._title; }
  set title(value) { this._title = value; this.update(); }
  get step() { return this._step; }
  set step(value) { this._step = value; this.update(); }
  get totalSteps() { return this._totalSteps; }
  set totalSteps(value) { this._totalSteps = value; this.update(); }
  get enabled() { return this._enabled; }
  set enabled(value) { this._enabled = value; this.update(); }
  get busy() { return this._busy; }
  set busy(value) { this._busy = value; this.update(); }
  get ignoreFocusOut() { return this._ignoreFocusOut; }
  set ignoreFocusOut(value) { this._ignoreFocusOut = value; }
  get buttons() { return this._buttons; }
  set buttons(value) { this._buttons = [...value]; this.update(); }
  get visible() { return this.shown !== undefined; }

  show(): void {
    if (!this.visible && !this.disposed) {
      this.host.show(this);
    }
  }

  hide(): void {
    if (this.visible) {
      this.host.hide(this);
    }
  }

  /** Builds the widget; the store lives until the controller closes it. */
  open(store: DisposableStore): IQuickInputWidget {
    this.shown = store;
    const widget = this.createWidget(store);
    this.updateWidget(true);
    return widget;
  }

  /** The controller removed the widget. */
  closed(): void {
    this.shown = undefined;
    this.didHide.fire();
  }

  protected abstract createWidget(store: DisposableStore): IQuickInputWidget;

  /** Applies the state to the widget; `all` the first time, and afterwards what changed. */
  protected abstract updateWidget(all: boolean): void;

  protected update(): void {
    if (this.visible) {
      this.updateWidget(false);
    }
  }

  protected boxState(box: { validationMessage?: string; severity?: Severity; password?: boolean }) {
    return {
      title: this._title, step: this._step, totalSteps: this._totalSteps, enabled: this._enabled, busy: this._busy,
      buttons: this._buttons, validationMessage: box.validationMessage, severity: box.severity ?? Severity.Ignore,
      password: box.password ?? false,
    };
  }

  override dispose(): void {
    this.hide();
    this.disposed = true;
    super.dispose();
  }
}

export class QuickPick<T extends IQuickPickItem> extends QuickInput implements IQuickPick<T> {
  private _value = '';
  private _valueSelection: readonly [number, number] | undefined;
  private _filterValue = (value: string) => value;
  private _placeholder: string | undefined;
  private _prompt: string | undefined;
  private _items: readonly (T | IQuickPickSeparator)[] = [];
  private _canSelectMany = false;
  private _matchOnDescription = false;
  private _matchOnDetail = false;
  private _activeItems: readonly T[] = [];
  private _selectedItems: readonly T[] = [];
  private dirty = { value: false, items: false, filter: false, active: false, selection: false, many: false };
  private widget: { box: QuickInputBox; list: QuickInputList<T>; ok: HTMLButtonElement } | undefined;
  /** The active item being applied from a property, whose change is not reported back. */
  private applyingActive: T | undefined | null = null;

  private readonly didChangeValue = this._register(new Emitter<string>());
  readonly onDidChangeValue = this.didChangeValue.event;
  private readonly didAccept = this._register(new Emitter<void>());
  readonly onDidAccept = this.didAccept.event;
  private readonly didChangeActive = this._register(new Emitter<readonly T[]>());
  readonly onDidChangeActive = this.didChangeActive.event;
  private readonly didChangeSelection = this._register(new Emitter<readonly T[]>());
  readonly onDidChangeSelection = this.didChangeSelection.event;

  get value() { return this._value; }
  set value(value) {
    if (this._value !== value) {
      this._value = value;
      this.dirty.value = this.dirty.filter = true;
      this.update();
      this.didChangeValue.fire(value);
    }
  }

  get valueSelection() { return this._valueSelection; }
  set valueSelection(value) {
    this._valueSelection = value && [value[0], value[1]];
    if (value && this.widget) {
      applySelection(this.widget.box.input, this._valueSelection);
    }
  }

  get filterValue() { return this._filterValue; }
  set filterValue(value) {
    this._filterValue = value;
    this.dirty.filter = true;
    this.update();
  }

  get placeholder() { return this._placeholder; }
  set placeholder(value) { this._placeholder = value; this.update(); }
  get prompt() { return this._prompt; }
  set prompt(value) { this._prompt = value; this.update(); }

  get items() { return this._items; }
  set items(value) {
    this._items = [...value];
    this.dirty.items = this.dirty.filter = true;
    if (this._canSelectMany) {
      this.select(this.pickedItems());
    }
    this.update();
  }

  get canSelectMany() { return this._canSelectMany; }
  set canSelectMany(value) {
    if (this._canSelectMany !== value) {
      this._canSelectMany = value;
      this.dirty.many = true;
      this.select(value ? this.pickedItems() : []);
      this.update();
    }
  }

  get matchOnDescription() { return this._matchOnDescription; }
  set matchOnDescription(value) {
    if (this._matchOnDescription !== value) {
      this._matchOnDescription = value;
      this.dirty.filter = true;
      this.update();
    }
  }

  get matchOnDetail() { return this._matchOnDetail; }
  set matchOnDetail(value) {
    if (this._matchOnDetail !== value) {
      this._matchOnDetail = value;
      this.dirty.filter = true;
      this.update();
    }
  }

  get activeItems() { return this._activeItems; }
  set activeItems(value) {
    this._activeItems = value.slice(0, 1);
    this.dirty.active = true;
    this.update();
  }

  get selectedItems() { return this._selectedItems; }
  set selectedItems(value) {
    this.dirty.selection = true;
    this.select(this._canSelectMany ? [...value] : value.slice(0, 1));
    this.update();
  }

  private pickedItems(): T[] {
    return this._items.filter((item): item is T => item.type !== 'separator' && item.picked === true);
  }

  private select(items: readonly T[]): void {
    if (!sameItems(items, this._selectedItems)) {
      this._selectedItems = items;
      this.dirty.selection = true;
      this.didChangeSelection.fire(items);
    }
  }

  protected createWidget(store: DisposableStore): IQuickInputWidget {
    const id = 'wr-quick-input-' + ++nextId;
    const listId = id + '-list';
    const box = new QuickInputBox(id, 'Choose an item', button => this.didTriggerButton.fire(button), listId);
    const list = store.add(new QuickInputList<T>(listId, box.input));
    const ok = $('button', { class: 'wr-quick-input-ok', type: 'button', tabindex: '-1' }, 'OK');
    box.element.append(ok);
    const element = $('div.wr-quick-input', null, box.element, list.element);
    this.widget = { box, list, ok };
    store.add({ dispose: () => { this.widget = undefined; } });

    store.add(list.onDidChangeActive(item => {
      this._activeItems = item === undefined ? [] : [item];
      if (this.applyingActive !== item) {
        this.didChangeActive.fire(this._activeItems);
      }
    }));
    store.add(list.onDidPress(item => {
      if (!this.enabled) {
        return;
      }
      if (this._canSelectMany) {
        this.toggle(item);
      } else {
        list.activate(item);
        this.accept(item);
      }
    }));
    store.add(addDisposableListener(ok, 'click', () => this.accept()));
    store.add(addDisposableListener(box.input, 'input', () => {
      if (!this.enabled) {
        box.setValue(this._value);
        return;
      }
      this._value = box.input.value;
      // Typing highlights the first match, as the command palette always has.
      this.filter(undefined);
      this.didChangeValue.fire(this._value);
    }));
    store.add(addDisposableListener(box.input, 'keydown', event => handleKey(event, key => {
      switch (key) {
        case 'ArrowUp': list.move(-1); return true;
        case 'ArrowDown': list.move(1); return true;
        case 'PageUp': list.move(-10); return true;
        case 'PageDown': list.move(10); return true;
        case 'Enter': this.accept(); return true;
        case ' ':
          if ((event.ctrlKey || event.metaKey) && this._canSelectMany) {
            const active = list.activeItem;
            if (active !== undefined && this.enabled) {
              this.toggle(active);
            }
            return true;
          }
          return false;
        default: return false;
      }
    })));
    return {
      element, field: box.input, focused: () => applySelection(box.input, this._valueSelection),
    };
  }

  private filter(preferred: T | undefined): void {
    this.widget?.list.filter(this._filterValue(this._value), { matchOnDescription: this._matchOnDescription, matchOnDetail: this._matchOnDetail },
      preferred);
  }

  private toggle(item: T): void {
    this.widget?.list.toggle(item);
    this.select(this.widget?.list.checkedItems ?? []);
    this.dirty.selection = false;
  }

  private accept(item?: T): void {
    if (!this.enabled) {
      return;
    }
    if (!this._canSelectMany) {
      const active = item ?? this.widget?.list.activeItem;
      this.select(active === undefined ? [] : [active]);
      this.dirty.selection = false;
    }
    this.didAccept.fire();
  }

  protected updateWidget(all: boolean): void {
    const widget = this.widget;
    if (!widget) {
      return;
    }
    const { box, list, ok } = widget;
    const dirty = all ? { value: true, items: true, filter: true, active: true, selection: true, many: true } : this.dirty;
    this.dirty = { value: false, items: false, filter: false, active: false, selection: false, many: false };
    box.update({ ...this.boxState({}), placeholder: this._placeholder, prompt: this._prompt });
    ok.hidden = !this._canSelectMany;
    if (dirty.value) {
      box.setValue(this._value);
    }
    if (dirty.many) {
      list.setCanSelectMany(this._canSelectMany);
    }
    if (dirty.items) {
      list.setItems(this._items);
    }
    if (dirty.selection || dirty.items) {
      list.setChecked(this._canSelectMany ? this._selectedItems : []);
    }
    const preferred = dirty.active ? this._activeItems[0] : list.activeItem;
    this.applyingActive = dirty.active ? preferred : null;
    try {
      if (dirty.filter || dirty.items || dirty.many) {
        this.filter(preferred);
      } else if (dirty.active) {
        list.activate(preferred);
      }
    } finally {
      this.applyingActive = null;
    }
    // An active item that is not shown leaves the highlight elsewhere: report where it really is.
    if (dirty.active && this._activeItems[0] !== list.activeItem) {
      this._activeItems = list.activeItem === undefined ? [] : [list.activeItem];
      this.didChangeActive.fire(this._activeItems);
    }
  }
}

export class InputBox extends QuickInput implements IInputBox {
  private _value = '';
  private _valueSelection: readonly [number, number] | undefined;
  private _placeholder: string | undefined;
  private _prompt: string | undefined;
  private _password = false;
  private _validationMessage: string | undefined;
  private _severity = Severity.Ignore;
  private widget: QuickInputBox | undefined;

  private readonly didChangeValue = this._register(new Emitter<string>());
  readonly onDidChangeValue = this.didChangeValue.event;
  private readonly didAccept = this._register(new Emitter<void>());
  readonly onDidAccept = this.didAccept.event;

  get value() { return this._value; }
  set value(value) {
    if (this._value !== value) {
      this._value = value;
      this.widget?.setValue(value);
      this.didChangeValue.fire(value);
    }
  }

  get valueSelection() { return this._valueSelection; }
  set valueSelection(value) {
    this._valueSelection = value && [value[0], value[1]];
    if (value && this.widget) {
      this.applySelection();
    }
  }

  get placeholder() { return this._placeholder; }
  set placeholder(value) { this._placeholder = value; this.update(); }
  get prompt() { return this._prompt; }
  set prompt(value) { this._prompt = value; this.update(); }
  get password() { return this._password; }
  set password(value) { this._password = value; this.update(); }
  get validationMessage() { return this._validationMessage; }
  set validationMessage(value) { this._validationMessage = value; this.update(); }
  get severity() { return this._severity; }
  set severity(value) { this._severity = value; this.update(); }

  protected createWidget(store: DisposableStore): IQuickInputWidget {
    const id = 'wr-quick-input-' + ++nextId;
    const box = new QuickInputBox(id, 'Enter text', button => this.didTriggerButton.fire(button));
    this.widget = box;
    store.add({ dispose: () => { this.widget = undefined; } });
    store.add(addDisposableListener(box.input, 'input', () => {
      if (!this.enabled) {
        box.setValue(this._value);
        return;
      }
      this._value = box.input.value;
      this.didChangeValue.fire(this._value);
    }));
    store.add(addDisposableListener(box.input, 'keydown', event => handleKey(event, key => {
      if (key !== 'Enter') {
        return false;
      }
      if (this.enabled) {
        this.didAccept.fire();
      }
      return true;
    })));
    return { element: $('div.wr-quick-input', null, box.element), field: box.input, focused: () => this.applySelection() };
  }

  private applySelection(): void {
    if (this.widget) {
      applySelection(this.widget.input, this._valueSelection);
    }
  }

  protected updateWidget(all: boolean): void {
    const box = this.widget;
    if (!box) {
      return;
    }
    box.update({
      ...this.boxState({ validationMessage: this._validationMessage, severity: this._severity, password: this._password }),
      placeholder: this._placeholder, prompt: this._prompt,
    });
    if (all) {
      box.setValue(this._value);
    }
  }
}
