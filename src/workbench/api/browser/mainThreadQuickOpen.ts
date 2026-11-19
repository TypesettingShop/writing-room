import './mainThreadOutputService.js';
import './mainThreadProgress.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { IQuickInputService, Severity } from '../../../platform/quickinput/common/quickInput.js';
import type {
  IInputBox, IQuickInputButton, IQuickPick, IQuickPickItem, IQuickPickSeparator,
} from '../../../platform/quickinput/common/quickInput.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { ExtHostQuickOpenProxy, MainThreadQuickOpenProxy, backButtonHandle } from '../common/extHost.protocol.windowUi.js';
import type {
  ExtHostQuickOpenShape, MainThreadQuickOpenShape, QuickInputButtonDto, QuickInputDto, QuickPickItemDto,
} from '../common/extHost.protocol.windowUi.js';

interface HandleItem extends IQuickPickItem {
  readonly handle: number;
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  alwaysShow?: boolean;
}

interface Session {
  readonly type: 'quickPick' | 'inputBox';
  readonly input: IQuickPick<HandleItem> | IInputBox;
  readonly store: DisposableStore;
  /** The last update in which the extension set each property; events carry it back. */
  readonly seq: { value: number; active: number; selection: number; visible: number };
  items: Map<number, HandleItem>;
  buttons: Map<IQuickInputButton, number>;
  /** While an update from the extension is applied, its own effects are not reported back. */
  applying: boolean;
  removed: boolean;
}

const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const handles = (value: unknown): number[] => Array.isArray(value) ? value.filter(Number.isSafeInteger) : [];

/**
 * Shows the quick picks and input boxes of extensions. Each belongs to the extension that created it;
 * removing an extension closes its quick inputs. The extension's values are checked before they are used.
 */
export class MainThreadQuickOpen implements MainThreadQuickOpenShape, IDisposable {
  private readonly sessions = new Map<string, Map<number, Session>>();

  constructor(
    private readonly proxy: ExtHostQuickOpenShape,
    private readonly quickInput: IQuickInputService,
    private readonly isRegistered: (extension: string) => boolean,
  ) {}

  async $createOrUpdate(extension: string, id: number, dto: QuickInputDto): Promise<void> {
    if (typeof extension !== 'string' || !this.isRegistered(extension) || !Number.isSafeInteger(id) || !dto || typeof dto !== 'object') {
      return;
    }
    const type = dto.type === 'inputBox' ? 'inputBox' : dto.type === 'quickPick' ? 'quickPick' : undefined;
    let sessions = this.sessions.get(extension);
    let session = sessions?.get(id);
    if (!session) {
      if (!type) {
        return;
      }
      sessions ??= new Map();
      this.sessions.set(extension, sessions);
      session = this.create(id, type);
      sessions.set(id, session);
    } else if (session.type !== type) {
      return;
    }
    const seq = count(dto.seq) ?? 0;
    session.applying = true;
    try {
      this.apply(session, dto, seq);
    } finally {
      session.applying = false;
    }
  }

  async $dispose(extension: string, id: number): Promise<void> {
    const session = this.sessions.get(extension)?.get(id);
    if (session) {
      this.sessions.get(extension)!.delete(id);
      this.close(session);
    }
  }

  private create(id: number, type: 'quickPick' | 'inputBox'): Session {
    const store = new DisposableStore();
    const input = type === 'quickPick' ? this.quickInput.createQuickPick<HandleItem>() : this.quickInput.createInputBox();
    store.add(input);
    const session: Session = {
      type, input, store, seq: { value: 0, active: 0, selection: 0, visible: 0 },
      items: new Map(), buttons: new Map(), applying: false, removed: false,
    };
    const send = (call: () => Promise<void>) => {
      if (!session.removed) {
        call().catch(() => {});
      }
    };
    store.add(input.onDidHide(() => {
      if (!session.applying) {
        send(() => this.proxy.$onDidHide(id, session.seq.visible));
      }
    }));
    store.add(input.onDidTriggerButton(button => {
      const handle = session.buttons.get(button);
      if (handle !== undefined) {
        send(() => this.proxy.$onDidTriggerButton(id, handle));
      }
    }));
    store.add(input.onDidChangeValue(value => {
      if (!session.applying) {
        send(() => this.proxy.$onDidChangeValue(id, value, session.seq.value));
      }
    }));
    store.add(input.onDidAccept(() => send(() => this.proxy.$onDidAccept(id))));
    if (type === 'quickPick') {
      const pick = input as IQuickPick<HandleItem>;
      // A highlight that moves because the items changed is reported: the extension did not choose it.
      store.add(pick.onDidChangeActive(items => send(() =>
        this.proxy.$onDidChangeActive(id, items.map(item => item.handle), session.seq.active))));
      store.add(pick.onDidChangeSelection(items => {
        if (!session.applying) {
          send(() => this.proxy.$onDidChangeSelection(id, items.map(item => item.handle), session.seq.selection));
        }
      }));
    }
    return session;
  }

  private apply(session: Session, dto: QuickInputDto, seq: number): void {
    const { input } = session;
    input.title = text(dto.title);
    input.step = count(dto.step);
    input.totalSteps = count(dto.totalSteps);
    input.enabled = dto.enabled !== false;
    input.busy = dto.busy === true;
    input.ignoreFocusOut = dto.ignoreFocusOut === true;
    input.buttons = this.buttons(session, dto.buttons);
    if (session.type === 'quickPick') {
      const pick = input as IQuickPick<HandleItem>;
      pick.placeholder = text(dto.placeholder);
      pick.prompt = text(dto.prompt);
      pick.canSelectMany = dto.canSelectMany === true;
      pick.matchOnDescription = dto.matchOnDescription === true;
      pick.matchOnDetail = dto.matchOnDetail === true;
      if (dto.items !== undefined) {
        pick.items = this.items(session, dto.items);
        session.seq.active = session.seq.selection = seq;
      }
      if (dto.value !== undefined) {
        pick.value = String(dto.value);
        session.seq.value = seq;
      }
      if (dto.activeItems !== undefined) {
        pick.activeItems = this.resolve(session, dto.activeItems);
        session.seq.active = seq;
      }
      if (dto.selectedItems !== undefined) {
        pick.selectedItems = this.resolve(session, dto.selectedItems);
        session.seq.selection = seq;
      }
    } else {
      const box = input as IInputBox;
      box.placeholder = text(dto.placeholder);
      box.prompt = text(dto.prompt);
      box.password = dto.password === true;
      const message = text(dto.validationMessage);
      box.validationMessage = message || undefined;
      box.severity = !message ? Severity.Ignore : dto.severity === 1 ? Severity.Info : dto.severity === 2 ? Severity.Warning : Severity.Error;
      if (dto.value !== undefined) {
        box.value = String(dto.value);
        session.seq.value = seq;
      }
      const selection = dto.valueSelection;
      if (Array.isArray(selection) && selection.length === 2 && selection.every(Number.isSafeInteger)) {
        box.valueSelection = [selection[0], selection[1]];
      }
    }
    if (dto.visible === true) {
      session.seq.visible = seq;
      input.show();
    } else if (dto.visible === false) {
      input.hide();
    }
  }

  private items(session: Session, dtos: readonly QuickPickItemDto[]): (HandleItem | IQuickPickSeparator)[] {
    const previous = session.items;
    const next = new Map<number, HandleItem>();
    const items: (HandleItem | IQuickPickSeparator)[] = [];
    for (const dto of Array.isArray(dtos) ? dtos : []) {
      if (!dto || typeof dto !== 'object' || !Number.isSafeInteger(dto.handle) || next.has(dto.handle)) {
        continue;
      }
      const label = typeof dto.label === 'string' ? dto.label : '';
      if (dto.kind === -1) {
        items.push({ type: 'separator', label });
        continue;
      }
      // The same item object across updates keeps the highlight on it.
      const item: HandleItem = previous.get(dto.handle) ?? { handle: dto.handle, label };
      item.label = label;
      item.description = text(dto.description);
      item.detail = text(dto.detail);
      item.picked = dto.picked === true;
      item.alwaysShow = dto.alwaysShow === true;
      next.set(dto.handle, item);
      items.push(item);
    }
    session.items = next;
    return items;
  }

  private resolve(session: Session, values: unknown): HandleItem[] {
    return handles(values).map(handle => session.items.get(handle)).filter(item => item !== undefined);
  }

  private buttons(session: Session, dtos: readonly QuickInputButtonDto[] | undefined): IQuickInputButton[] {
    const previous = new Map([...session.buttons].map(([button, handle]) => [handle, button]));
    const buttons = new Map<IQuickInputButton, number>();
    for (const dto of Array.isArray(dtos) ? dtos : []) {
      if (!dto || !Number.isSafeInteger(dto.handle) || [...buttons.values()].includes(dto.handle)) {
        continue;
      }
      const icon = text(dto.icon);
      const tooltip = text(dto.tooltip);
      let button = dto.handle === backButtonHandle ? this.quickInput.backButton : previous.get(dto.handle);
      if (!button || (button !== this.quickInput.backButton && (button.icon !== icon || button.tooltip !== tooltip))) {
        button = Object.freeze({ icon: icon && /^[a-z\d-]+(?:~spin)?$/i.test(icon) ? icon.split('~')[0] : undefined, tooltip });
      }
      buttons.set(button, dto.handle);
    }
    session.buttons = buttons;
    return [...buttons.keys()];
  }

  private close(session: Session): void {
    session.removed = true;
    session.store.dispose();
  }

  /** Closes the quick inputs of an extension that was removed or whose host stopped. */
  remove(extension: string): void {
    const sessions = this.sessions.get(extension);
    this.sessions.delete(extension);
    for (const session of sessions?.values() ?? []) {
      this.close(session);
    }
  }

  dispose(): void {
    for (const extension of [...this.sessions.keys()]) {
      this.remove(extension);
    }
  }
}

mainThreadCustomers.register('quickOpen', ({ rpc, instantiation, getExtension }) => {
  const quickInput = instantiation.invokeFunction(accessor => accessor.get(IQuickInputService));
  const quickOpen = new MainThreadQuickOpen(rpc.getProxy(ExtHostQuickOpenProxy), quickInput, key => Boolean(getExtension(key)));
  rpc.set(MainThreadQuickOpenProxy, quickOpen);
  return quickOpen;
});
