import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Severity } from '../../../base/common/severity.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';
import type { ResolvedKeybinding } from '../../keybinding/common/keybinding.js';
import type { IQuickAccessController } from './quickAccess.js';

export const IQuickInputService = createDecorator<IQuickInputService>('quickInputService');

export interface IQuickPickItem {
  readonly type?: 'item';
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly id?: string;
  readonly keybinding?: ResolvedKeybinding;
  /** Checked when the items are set on a pick that selects many. */
  readonly picked?: boolean;
  /** Shown whatever the filter is. */
  readonly alwaysShow?: boolean;
}

export interface IQuickPickSeparator {
  readonly type: 'separator';
  readonly label: string;
}

export interface IQuickInputButton {
  /** A codicon name, such as `arrow-left`. Without one the tooltip is the button's text. */
  readonly icon?: string;
  readonly tooltip?: string;
}

export { Severity };

export interface IQuickInput extends IDisposable {
  title: string | undefined;
  step: number | undefined;
  totalSteps: number | undefined;
  /** A disabled quick input keeps its focus but ignores typing, presses and acceptance. */
  enabled: boolean;
  busy: boolean;
  /** Stays open when focus or a click goes elsewhere. */
  ignoreFocusOut: boolean;
  readonly visible: boolean;
  readonly onDidHide: Event<void>;
  /** Shows this quick input; the one showing now hides first. */
  show(): void;
  hide(): void;
}

export interface IQuickPick<T extends IQuickPickItem> extends IQuickInput {
  value: string;
  /**
   * The part of the value that is selected when the pick shows, as `[start, end]`; without one the
   * whole value is selected.
   */
  valueSelection: readonly [number, number] | undefined;
  /** Turns the value into the text the items are filtered with. By default it is the value as is. */
  filterValue: (value: string) => string;
  placeholder: string | undefined;
  prompt: string | undefined;
  items: readonly (T | IQuickPickSeparator)[];
  canSelectMany: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  /** The highlighted item. It stays across item updates while it is still in the items. */
  activeItems: readonly T[];
  /** The accepted item of a single pick, or the checked items of a pick that selects many. */
  selectedItems: readonly T[];
  buttons: readonly IQuickInputButton[];
  readonly onDidChangeValue: Event<string>;
  readonly onDidAccept: Event<void>;
  readonly onDidChangeActive: Event<readonly T[]>;
  readonly onDidChangeSelection: Event<readonly T[]>;
  readonly onDidTriggerButton: Event<IQuickInputButton>;
}

export interface IInputBox extends IQuickInput {
  value: string;
  valueSelection: readonly [number, number] | undefined;
  placeholder: string | undefined;
  prompt: string | undefined;
  password: boolean;
  validationMessage: string | undefined;
  /** How the validation message is shown; only an error marks the value invalid. */
  severity: Severity;
  buttons: readonly IQuickInputButton[];
  readonly onDidChangeValue: Event<string>;
  readonly onDidAccept: Event<void>;
  readonly onDidTriggerButton: Event<IQuickInputButton>;
}

export interface IPickOptions {
  readonly title?: string;
  readonly placeHolder?: string;
  readonly value?: string;
}

export interface IInputOptions extends IPickOptions {
  readonly prompt?: string;
  readonly validateInput?: (value: string) => string | null | undefined | PromiseLike<string | null | undefined>;
}

export interface IQuickInputService extends BrandedService {
  /** The button that goes back one step, as `QuickInputButtons.Back`. */
  readonly backButton: IQuickInputButton;
  /** Resolves to the accepted item, or `undefined` when the pick hides first. Matches labels and descriptions. */
  pick<T extends IQuickPickItem>(items: readonly (T | IQuickPickSeparator)[], options?: IPickOptions): Promise<T | undefined>;
  input(options?: IInputOptions): Promise<string | undefined>;
  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T>;
  createInputBox(): IInputBox;
  /** Opens the quick pick whose provider is chosen by the prefix of its value. */
  readonly quickAccess: IQuickAccessController;
}
