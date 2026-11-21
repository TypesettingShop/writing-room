import './extHostOutput.js';
import './extHostProgress.js';
import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { ExtHostQuickOpenProxy, MainThreadQuickOpenProxy, backButtonHandle } from './extHost.protocol.windowUi.js';
import type {
  ExtHostQuickOpenShape, MainThreadQuickOpenShape, QuickInputButtonDto, QuickInputDto, QuickPickItemDto,
} from './extHost.protocol.windowUi.js';
import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { ThemeIcon } from './extHostTypes.js';

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export enum InputBoxValidationSeverity {
  Info = 1,
  Warning = 2,
  Error = 3,
}

export class QuickInputButtons {
  static readonly Back: vscode.QuickInputButton = Object.freeze({ iconPath: new ThemeIcon('arrow-left') });

  private constructor() {}
}

type Kind = 'value' | 'active' | 'selection' | 'visible';
type QuickInputEvent =
  | { readonly kind: 'value'; readonly value: string; readonly seq: number }
  | { readonly kind: 'active' | 'selection'; readonly handles: readonly number[]; readonly seq: number }
  | { readonly kind: 'hide'; readonly seq: number }
  | { readonly kind: 'accept' }
  | { readonly kind: 'button'; readonly handle: number };

const deliver = Symbol('deliver');
const whenClosed = Symbol('whenClosed');

function iconName(button: vscode.QuickInputButton): string | undefined {
  const path = button?.iconPath as unknown;
  return path instanceof ThemeIcon || (path && typeof path === 'object' && typeof (path as ThemeIcon).id === 'string'
    && !('scheme' in path) && !('light' in path)) ? (path as ThemeIcon).id : undefined;
}

/**
 * The state of a quick input lives here and goes to the workbench in one update per task. What the user
 * does comes back as events, each tagged with the last update of that property the workbench applied: an
 * event older than the extension's own later change is dropped, so a late event never undoes it.
 */
abstract class ExtHostQuickInput implements vscode.QuickInput {
  readonly #id: number;
  readonly #extension: string;
  readonly #proxy: MainThreadQuickOpenShape;
  readonly #onDispose: () => void;
  #title: string | undefined;
  #step: number | undefined;
  #totalSteps: number | undefined;
  #enabled = true;
  #busy = false;
  #ignoreFocusOut = false;
  #buttons: readonly vscode.QuickInputButton[] = [];
  #buttonHandles = new Map<vscode.QuickInputButton, number>();
  #nextButton = 0;
  #visible = false;
  #sentVisible = false;
  #created = false;
  #disposed = false;
  #scheduled = false;
  #seq = 0;
  #closed: Promise<void> = Promise.resolve();
  readonly #sent: Record<Kind, number> = { value: 0, active: 0, selection: 0, visible: 0 };
  protected readonly changed = new Set<Kind | 'items' | 'valueSelection'>();

  protected readonly onDidHideEmitter = new Emitter<void>();
  readonly onDidHide = this.onDidHideEmitter.event;
  protected readonly onDidTriggerButtonEmitter = new Emitter<vscode.QuickInputButton>();
  readonly onDidTriggerButton = this.onDidTriggerButtonEmitter.event;

  constructor(id: number, extension: string, proxy: MainThreadQuickOpenShape, onDispose: () => void) {
    this.#id = id;
    this.#extension = extension;
    this.#proxy = proxy;
    this.#onDispose = onDispose;
  }

  get title() { return this.#title; }
  set title(value) { this.#title = value; this.update(); }
  get step() { return this.#step; }
  set step(value) { this.#step = value; this.update(); }
  get totalSteps() { return this.#totalSteps; }
  set totalSteps(value) { this.#totalSteps = value; this.update(); }
  get enabled() { return this.#enabled; }
  set enabled(value) { this.#enabled = value; this.update(); }
  get busy() { return this.#busy; }
  set busy(value) { this.#busy = value; this.update(); }
  get ignoreFocusOut() { return this.#ignoreFocusOut; }
  set ignoreFocusOut(value) { this.#ignoreFocusOut = value; this.update(); }
  get buttons() { return this.#buttons; }
  set buttons(value) { this.#buttons = [...value ?? []]; this.update(); }

  get disposed() { return this.#disposed; }

  show(): void {
    if (!this.#disposed && !this.#visible) {
      this.#visible = true;
      this.update();
    }
  }

  hide(): void {
    if (this.#visible) {
      this.#visible = false;
      this.update();
      this.onDidHideEmitter.fire();
    }
  }

  protected update(): void {
    if (this.#disposed || this.#scheduled || (!this.#visible && !this.#created)) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (!this.#disposed && (this.#visible || this.#created)) {
        this.#flush();
      }
    });
  }

  #flush(): void {
    const seq = ++this.#seq;
    const visible = this.#visible !== this.#sentVisible ? this.#visible : undefined;
    if (visible !== undefined) {
      this.#sentVisible = this.#visible;
      this.changed.add('visible');
    }
    const buttons: QuickInputButtonDto[] = [];
    const handles = new Map<vscode.QuickInputButton, number>();
    for (const button of this.#buttons) {
      if (handles.has(button)) {
        // The same button twice is one button, with one handle.
        continue;
      }
      const handle = button === QuickInputButtons.Back ? backButtonHandle
        : this.#buttonHandles.get(button) ?? ++this.#nextButton;
      handles.set(button, handle);
      buttons.push({ handle, icon: iconName(button), tooltip: typeof button?.tooltip === 'string' ? button.tooltip : undefined });
    }
    this.#buttonHandles = handles;
    const dto: QuickInputDto = {
      seq, ...this.dto(), visible, title: this.#title, step: this.#step, totalSteps: this.#totalSteps,
      enabled: this.#enabled !== false, busy: this.#busy === true, ignoreFocusOut: this.#ignoreFocusOut === true, buttons,
    };
    for (const kind of ['value', 'active', 'selection', 'visible'] as const) {
      if (this.changed.has(kind)) {
        this.#sent[kind] = seq;
      }
    }
    if (this.changed.has('items')) {
      // New items move the highlight and the picked defaults: events about the old ones are stale.
      this.#sent.active = this.#sent.selection = seq;
    }
    this.changed.clear();
    this.#created = true;
    this.#proxy.$createOrUpdate(this.#extension, this.#id, dto).catch(error => {
      if (!this.#disposed) {
        console.error(error);
      }
    });
  }

  /** The fields of this kind of quick input, and only the changed ones of those the user can also change. */
  protected abstract dto(): QuickInputDto;

  protected abstract handle(event: QuickInputEvent): void;

  [deliver](event: QuickInputEvent): void {
    if (this.#disposed) {
      return;
    }
    switch (event.kind) {
      case 'hide':
        if (event.seq === this.#sent.visible && this.#visible) {
          this.#visible = this.#sentVisible = false;
          this.onDidHideEmitter.fire();
        }
        return;
      case 'button': {
        const button = event.handle === backButtonHandle ? QuickInputButtons.Back
          : [...this.#buttonHandles].find(([, handle]) => handle === event.handle)?.[0];
        if (button && this.#buttons.includes(button)) {
          this.onDidTriggerButtonEmitter.fire(button);
        }
        return;
      }
      case 'value':
      case 'active':
      case 'selection':
        if (event.seq !== this.#sent[event.kind]) {
          return;
        }
    }
    this.handle(event);
  }

  /** Settles once the workbench has removed the widget and given focus back. */
  [whenClosed](): Promise<void> {
    return this.#closed;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    const visible = this.#visible;
    this.#disposed = true;
    this.#visible = false;
    if (this.#created) {
      this.#closed = this.#proxy.$dispose(this.#extension, this.#id).catch(() => {});
    }
    if (visible) {
      this.onDidHideEmitter.fire();
    }
    this.disposeEmitters();
    this.#onDispose();
  }

  protected disposeEmitters(): void {
    this.onDidHideEmitter.dispose();
    this.onDidTriggerButtonEmitter.dispose();
  }
}

class ExtHostQuickPick<T extends vscode.QuickPickItem> extends ExtHostQuickInput implements vscode.QuickPick<T> {
  #value = '';
  #placeholder: string | undefined;
  #prompt: string | undefined;
  #items: readonly T[] = [];
  #handles = new Map<T, number>();
  #byHandle = new Map<number, T>();
  #nextHandle = 0;
  #canSelectMany = false;
  #matchOnDescription = false;
  #matchOnDetail = false;
  #activeItems: readonly T[] = [];
  #selectedItems: readonly T[] = [];

  readonly #onDidChangeValue = new Emitter<string>();
  readonly onDidChangeValue = this.#onDidChangeValue.event;
  readonly #onDidAccept = new Emitter<void>();
  readonly onDidAccept = this.#onDidAccept.event;
  readonly #onDidChangeActive = new Emitter<readonly T[]>();
  readonly onDidChangeActive = this.#onDidChangeActive.event;
  readonly #onDidChangeSelection = new Emitter<readonly T[]>();
  readonly onDidChangeSelection = this.#onDidChangeSelection.event;

  get value() { return this.#value; }
  set value(value) { this.#value = String(value ?? ''); this.changed.add('value'); this.update(); }
  get placeholder() { return this.#placeholder; }
  set placeholder(value) { this.#placeholder = value; this.update(); }
  get prompt() { return this.#prompt; }
  set prompt(value) { this.#prompt = value; this.update(); }

  get items() { return this.#items; }
  set items(value) {
    this.#items = [...value ?? []];
    const handles = new Map<T, number>();
    for (const item of this.#items) {
      if (item && !handles.has(item)) {
        handles.set(item, this.#handles.get(item) ?? ++this.#nextHandle);
      }
    }
    this.#handles = handles;
    this.#byHandle = new Map([...handles].map(([item, handle]) => [handle, item]));
    this.#activeItems = this.#activeItems.filter(item => handles.has(item));
    this.#selectedItems = this.#canSelectMany ? this.#picked() : this.#selectedItems.filter(item => handles.has(item));
    this.changed.add('items');
    this.update();
  }

  get canSelectMany() { return this.#canSelectMany; }
  set canSelectMany(value) {
    if (this.#canSelectMany !== !!value) {
      this.#canSelectMany = !!value;
      this.#selectedItems = this.#canSelectMany ? this.#picked() : [];
      // The selection starts over, so a choice the user made under the old mode is stale.
      this.changed.add('selection');
      this.update();
    }
  }

  get matchOnDescription() { return this.#matchOnDescription; }
  set matchOnDescription(value) { this.#matchOnDescription = !!value; this.update(); }
  get matchOnDetail() { return this.#matchOnDetail; }
  set matchOnDetail(value) { this.#matchOnDetail = !!value; this.update(); }

  get activeItems() { return this.#activeItems; }
  set activeItems(value) {
    this.#activeItems = [...value ?? []]
      .filter(item => this.#handles.has(item) && item.kind !== QuickPickItemKind.Separator).slice(0, 1);
    this.changed.add('active');
    this.update();
  }

  get selectedItems() { return this.#selectedItems; }
  set selectedItems(value) {
    const items = [...value ?? []].filter(item => this.#handles.has(item) && item.kind !== QuickPickItemKind.Separator);
    this.#selectedItems = this.#canSelectMany ? items : items.slice(0, 1);
    this.changed.add('selection');
    this.update();
  }

  #picked(): T[] {
    return this.#items.filter(item => item?.picked === true && item.kind !== QuickPickItemKind.Separator);
  }

  protected dto(): QuickInputDto {
    const dto: { -readonly [K in keyof QuickInputDto]: QuickInputDto[K] } = {
      type: 'quickPick', visible: false, enabled: true, busy: false, ignoreFocusOut: false, buttons: [],
      placeholder: this.#placeholder, prompt: this.#prompt, canSelectMany: this.#canSelectMany,
      matchOnDescription: this.#matchOnDescription, matchOnDetail: this.#matchOnDetail,
    };
    if (this.changed.has('value')) {
      dto.value = this.#value;
    }
    if (this.changed.has('items')) {
      dto.items = this.#items.flatMap((item): QuickPickItemDto[] => {
        const handle = this.#handles.get(item);
        if (!item || handle === undefined) {
          return [];
        }
        const text = (value: unknown) => typeof value === 'string' ? value : undefined;
        return [item.kind === QuickPickItemKind.Separator
          ? { handle, kind: QuickPickItemKind.Separator, label: String(item.label ?? '') }
          : {
            handle, label: String(item.label ?? ''), description: text(item.description), detail: text(item.detail),
            picked: item.picked === true, alwaysShow: item.alwaysShow === true,
          }];
      });
    }
    if (this.changed.has('active')) {
      dto.activeItems = this.#activeItems.map(item => this.#handles.get(item)!);
    }
    if (this.changed.has('selection')) {
      dto.selectedItems = this.#selectedItems.map(item => this.#handles.get(item)!);
    }
    return dto;
  }

  protected handle(event: QuickInputEvent): void {
    switch (event.kind) {
      case 'value':
        this.#value = event.value;
        this.#onDidChangeValue.fire(event.value);
        return;
      case 'accept':
        this.#onDidAccept.fire();
        return;
      case 'active':
      case 'selection': {
        const items = event.handles.map(handle => this.#byHandle.get(handle)).filter(item => item !== undefined);
        if (event.kind === 'active') {
          this.#activeItems = items;
          this.#onDidChangeActive.fire(items);
        } else {
          this.#selectedItems = items;
          this.#onDidChangeSelection.fire(items);
        }
      }
    }
  }

  protected override disposeEmitters(): void {
    super.disposeEmitters();
    this.#onDidChangeValue.dispose();
    this.#onDidAccept.dispose();
    this.#onDidChangeActive.dispose();
    this.#onDidChangeSelection.dispose();
  }
}

class ExtHostInputBox extends ExtHostQuickInput implements vscode.InputBox {
  #value = '';
  #valueSelection: readonly [number, number] | undefined;
  #placeholder: string | undefined;
  #prompt: string | undefined;
  #password = false;
  #validationMessage: string | vscode.InputBoxValidationMessage | undefined;

  readonly #onDidChangeValue = new Emitter<string>();
  readonly onDidChangeValue = this.#onDidChangeValue.event;
  readonly #onDidAccept = new Emitter<void>();
  readonly onDidAccept = this.#onDidAccept.event;

  get value() { return this.#value; }
  set value(value) { this.#value = String(value ?? ''); this.changed.add('value'); this.update(); }
  get valueSelection() { return this.#valueSelection; }
  set valueSelection(value) {
    this.#valueSelection = value ? [Number(value[0]), Number(value[1])] : undefined;
    this.changed.add('valueSelection');
    this.update();
  }

  get placeholder() { return this.#placeholder; }
  set placeholder(value) { this.#placeholder = value; this.update(); }
  get prompt() { return this.#prompt; }
  set prompt(value) { this.#prompt = value; this.update(); }
  get password() { return this.#password; }
  set password(value) { this.#password = !!value; this.update(); }
  get validationMessage() { return this.#validationMessage; }
  set validationMessage(value) { this.#validationMessage = value; this.update(); }

  protected dto(): QuickInputDto {
    const message = this.#validationMessage;
    const text = typeof message === 'string' ? message : typeof message?.message === 'string' ? message.message : undefined;
    const severity = typeof message === 'string' ? InputBoxValidationSeverity.Error : message?.severity;
    const dto: { -readonly [K in keyof QuickInputDto]: QuickInputDto[K] } = {
      type: 'inputBox', visible: false, enabled: true, busy: false, ignoreFocusOut: false, buttons: [],
      placeholder: this.#placeholder, prompt: this.#prompt, password: this.#password,
      validationMessage: text || undefined, severity: text ? severity ?? InputBoxValidationSeverity.Error : undefined,
    };
    if (this.changed.has('value')) {
      dto.value = this.#value;
    }
    if (this.changed.has('valueSelection') && this.#valueSelection) {
      dto.valueSelection = this.#valueSelection;
    }
    return dto;
  }

  protected handle(event: QuickInputEvent): void {
    if (event.kind === 'value') {
      this.#value = event.value;
      this.#onDidChangeValue.fire(event.value);
    } else if (event.kind === 'accept') {
      this.#onDidAccept.fire();
    }
  }

  protected override disposeEmitters(): void {
    super.disposeEmitters();
    this.#onDidChangeValue.dispose();
    this.#onDidAccept.dispose();
  }
}

type QuickPickSource = readonly (vscode.QuickPickItem | string)[] | Thenable<readonly (vscode.QuickPickItem | string)[]>;
type Validation = string | vscode.InputBoxValidationMessage | undefined | null;

function blocks(result: Validation): boolean {
  return typeof result === 'string' ? result.length > 0
    : !!result && typeof result === 'object' && result.severity === InputBoxValidationSeverity.Error && !!result.message;
}

export class ExtHostQuickOpen implements ExtHostQuickOpenShape {
  private nextId = 0;
  private readonly sessions = new Map<number, ExtHostQuickInput>();
  private readonly byExtension = new Map<string, Set<ExtHostQuickInput>>();

  constructor(private readonly proxy: MainThreadQuickOpenShape) {}

  private track<T extends ExtHostQuickInput>(extension: string, create: (id: number, onDispose: () => void) => T): T {
    const id = ++this.nextId;
    const set = this.byExtension.get(extension) ?? new Set();
    this.byExtension.set(extension, set);
    const input = create(id, () => {
      this.sessions.delete(id);
      set.delete(input);
    });
    this.sessions.set(id, input);
    set.add(input);
    return input;
  }

  createQuickPick<T extends vscode.QuickPickItem>(extension: string): vscode.QuickPick<T> {
    return this.track(extension, (id, onDispose) => new ExtHostQuickPick<T>(id, extension, this.proxy, onDispose));
  }

  createInputBox(extension: string): vscode.InputBox {
    return this.track(extension, (id, onDispose) => new ExtHostInputBox(id, extension, this.proxy, onDispose));
  }

  showQuickPick<T extends vscode.QuickPickItem>(
    extension: string, items: readonly (T | string)[] | Thenable<readonly (T | string)[]>,
    options: vscode.QuickPickOptions | undefined, token: vscode.CancellationToken = CancellationToken.None,
  ): Promise<T | string | (T | string)[] | undefined> {
    if (token.isCancellationRequested) {
      return Promise.resolve(undefined);
    }
    const pick = this.createQuickPick<vscode.QuickPickItem>(extension);
    const original = new Map<vscode.QuickPickItem, T | string>();
    const many = options?.canPickMany === true;
    pick.title = options?.title;
    pick.placeholder = options?.placeHolder;
    pick.prompt = options?.prompt;
    pick.matchOnDescription = options?.matchOnDescription === true;
    pick.matchOnDetail = options?.matchOnDetail === true;
    pick.ignoreFocusOut = options?.ignoreFocusOut === true;
    pick.canSelectMany = many;
    const toOriginal = (item: vscode.QuickPickItem) => original.get(item)!;
    const setItems = (list: readonly (T | string)[]) => {
      pick.items = [...list].map(entry => {
        const item = typeof entry === 'string' ? { label: entry } : entry;
        original.set(item, entry);
        return item;
      });
    };

    return new Promise((resolve, reject) => {
      const subscriptions: IDisposable[] = [];
      let settled = false;
      const settle = (result: T | string | (T | string)[] | undefined, failure?: { readonly error: unknown }) => {
        if (settled) {
          return;
        }
        settled = true;
        for (const subscription of subscriptions) {
          subscription.dispose();
        }
        pick.dispose();
        // The caller goes on once focus is back where it was, so what it focuses next keeps the focus.
        void (pick as unknown as ExtHostQuickInput)[whenClosed]().then(() => failure ? reject(failure.error) : resolve(result));
      };
      subscriptions.push(token.onCancellationRequested(() => settle(undefined)));
      pick.onDidChangeActive(active => {
        const item = active[0];
        if (item && options?.onDidSelectItem) {
          try {
            options.onDidSelectItem(toOriginal(item) as vscode.QuickPickItem | string);
          } catch (error) {
            console.error(error);
          }
        }
      });
      pick.onDidAccept(() => {
        if (many) {
          settle(pick.selectedItems.map(toOriginal));
        } else if (pick.selectedItems[0]) {
          settle(toOriginal(pick.selectedItems[0]));
        }
      });
      pick.onDidHide(() => settle(undefined));
      if (Array.isArray(items)) {
        setItems(items);
        pick.show();
      } else {
        // The list arrives later; a pick hidden before then ends with undefined and the list is not applied.
        pick.busy = true;
        pick.show();
        Promise.resolve(items as Thenable<readonly (T | string)[]>).then(list => {
          if (!settled) {
            setItems(Array.isArray(list) ? list : []);
            pick.busy = false;
          }
        }, (error: unknown) => settle(undefined, { error }));
      }
    });
  }

  showInputBox(extension: string, options: vscode.InputBoxOptions | undefined, token: vscode.CancellationToken = CancellationToken.None):
  Promise<string | undefined> {
    if (token.isCancellationRequested) {
      return Promise.resolve(undefined);
    }
    const box = this.createInputBox(extension);
    box.title = options?.title;
    box.value = options?.value ?? '';
    if (options?.valueSelection) {
      box.valueSelection = options.valueSelection;
    }
    box.prompt = options?.prompt;
    box.placeholder = options?.placeHolder;
    box.password = options?.password === true;
    box.ignoreFocusOut = options?.ignoreFocusOut === true;
    const validateInput = options?.validateInput?.bind(options);

    return new Promise(resolve => {
      let settled = false;
      const subscriptions: IDisposable[] = [];
      const settle = (result: string | undefined) => {
        if (!settled) {
          settled = true;
          for (const subscription of subscriptions) {
            subscription.dispose();
          }
          box.dispose();
          void (box as unknown as ExtHostQuickInput)[whenClosed]().then(() => resolve(result));
        }
      };
      // The latest validation; a result for an older value is never shown nor used to accept.
      let latest: { readonly value: string; readonly result: Promise<Validation> } | undefined;
      const validate = (value: string): Promise<Validation> => {
        if (latest?.value === value) {
          return latest.result;
        }
        const result = Promise.resolve().then(() => validateInput!(value)).then(message => message, error => {
          console.error(error);
          return 'Could not validate this input.';
        });
        const current = { value, result };
        latest = current;
        void result.then(message => {
          if (latest === current && !settled) {
            box.validationMessage = message ?? undefined;
          }
        });
        return result;
      };
      subscriptions.push(token.onCancellationRequested(() => settle(undefined)));
      if (validateInput) {
        box.onDidChangeValue(validate);
        validate(box.value);
      }
      box.onDidAccept(async () => {
        const value = box.value;
        if (validateInput) {
          const pending = validate(value);
          const message = await pending;
          if (settled || latest?.result !== pending || box.value !== value || blocks(message)) {
            return;
          }
        }
        settle(value);
      });
      box.onDidHide(() => settle(undefined));
      box.show();
    });
  }

  private deliver(id: number, event: QuickInputEvent): void {
    this.sessions.get(id)?.[deliver](event);
  }

  async $onDidChangeValue(id: number, value: string, seq?: number): Promise<void> {
    if (typeof value === 'string') {
      this.deliver(id, { kind: 'value', value, seq: Number(seq) });
    }
  }

  async $onDidAccept(id: number): Promise<void> {
    this.deliver(id, { kind: 'accept' });
  }

  async $onDidChangeActive(id: number, handles: readonly number[], seq?: number): Promise<void> {
    this.deliver(id, { kind: 'active', handles: Array.isArray(handles) ? handles : [], seq: Number(seq) });
  }

  async $onDidChangeSelection(id: number, handles: readonly number[], seq?: number): Promise<void> {
    this.deliver(id, { kind: 'selection', handles: Array.isArray(handles) ? handles : [], seq: Number(seq) });
  }

  async $onDidTriggerButton(id: number, handle: number): Promise<void> {
    this.deliver(id, { kind: 'button', handle });
  }

  async $onDidHide(id: number, seq?: number): Promise<void> {
    this.deliver(id, { kind: 'hide', seq: Number(seq) });
  }

  /** Closes the quick inputs of an extension that was deactivated or removed. */
  release(extension: string): void {
    for (const input of [...this.byExtension.get(extension) ?? []]) {
      input.dispose();
    }
    this.byExtension.delete(extension);
  }

  dispose(): void {
    for (const extension of [...this.byExtension.keys()]) {
      this.release(extension);
    }
  }
}

extHostApiRegistry.register('quickOpen', ({ rpc }) => {
  const quickOpen = new ExtHostQuickOpen(rpc.getProxy(MainThreadQuickOpenProxy));
  rpc.set(ExtHostQuickOpenProxy, quickOpen);
  return {
    service: quickOpen,
    create: ({ key }) => ({
      types: { QuickPickItemKind, InputBoxValidationSeverity, QuickInputButtons },
      namespaces: {
        window: {
          showQuickPick: promiseApiMethod((items: QuickPickSource, options?: vscode.QuickPickOptions, token?: vscode.CancellationToken) =>
            quickOpen.showQuickPick(key, items, options, token)) as typeof vscode.window.showQuickPick,
          showInputBox: promiseApiMethod((options?: vscode.InputBoxOptions, token?: vscode.CancellationToken) =>
            quickOpen.showInputBox(key, options, token)),
          createQuickPick: <T extends vscode.QuickPickItem>() => quickOpen.createQuickPick<T>(key),
          createInputBox: () => quickOpen.createInputBox(key),
        } satisfies Pick<typeof vscode.window, 'showQuickPick' | 'showInputBox' | 'createQuickPick' | 'createInputBox'>,
      },
    }),
    release: key => quickOpen.release(key),
    dispose: () => quickOpen.dispose(),
  };
});
