import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';
import type { MessageSeverity } from './extHost.protocol.messages.js';

// Quick pick and input box. The items stay in the extension host; the workbench gets their text and a
// handle, and reports which handles were highlighted, chosen or accepted.

export interface QuickPickItemDto {
  readonly handle: number;
  /** `-1` is a separator, which cannot be chosen. */
  readonly kind?: number;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly picked?: boolean;
  readonly alwaysShow?: boolean;
}

export interface QuickInputButtonDto {
  readonly handle: number;
  /** A codicon name. */
  readonly icon?: string;
  readonly tooltip?: string;
}

/** The handle of `QuickInputButtons.Back`. */
export const backButtonHandle = -1;

/**
 * One update of a quick input. The other fields are always the whole state; `value`, `valueSelection`,
 * `items`, `activeItems` and `selectedItems` are present only when the extension set them since the last
 * update, so an update never takes back what the user typed or chose meanwhile.
 */
export interface QuickInputDto {
  readonly type: 'quickPick' | 'inputBox';
  /** Counts the updates of one quick input; events name the last update of their property they saw. */
  readonly seq?: number;
  /** Present when the extension called `show` or `hide` since the last update. */
  readonly visible?: boolean;
  readonly title?: string;
  readonly step?: number;
  readonly totalSteps?: number;
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly ignoreFocusOut: boolean;
  readonly value?: string;
  readonly placeholder?: string;
  readonly prompt?: string;
  readonly buttons: readonly QuickInputButtonDto[];
  // Quick pick
  readonly items?: readonly QuickPickItemDto[];
  readonly activeItems?: readonly number[];
  readonly selectedItems?: readonly number[];
  readonly canSelectMany?: boolean;
  readonly matchOnDescription?: boolean;
  readonly matchOnDetail?: boolean;
  // Input box
  readonly valueSelection?: readonly [number, number];
  readonly password?: boolean;
  readonly validationMessage?: string;
  /** `InputBoxValidationSeverity`: 1 information, 2 warning, 3 error. */
  readonly severity?: number;
}

export interface MainThreadQuickOpenShape {
  /** Creates the quick input on its first update. */
  $createOrUpdate(extension: string, id: number, input: QuickInputDto): Promise<void>;
  $dispose(extension: string, id: number): Promise<void>;
}

/**
 * What the user did. `seq` is the last update in which the extension set that property (for a hide, the
 * last `show`); the host drops an event whose `seq` is older than its own latest change of the property.
 */
export interface ExtHostQuickOpenShape {
  $onDidChangeValue(id: number, value: string, seq: number): Promise<void>;
  $onDidAccept(id: number): Promise<void>;
  $onDidChangeActive(id: number, handles: readonly number[], seq: number): Promise<void>;
  $onDidChangeSelection(id: number, handles: readonly number[], seq: number): Promise<void>;
  $onDidTriggerButton(id: number, handle: number): Promise<void>;
  $onDidHide(id: number, seq: number): Promise<void>;
}

export const MainThreadQuickOpenProxy = createProxyIdentifier<MainThreadQuickOpenShape>('MainThreadQuickOpen');
export const ExtHostQuickOpenProxy = createProxyIdentifier<ExtHostQuickOpenShape>('ExtHostQuickOpen');

// Output channels. The extension host numbers its channels; the workbench keys them by extension and
// number, so one extension cannot reach another's channel.

export interface MainThreadOutputServiceShape {
  $register(extension: string, handle: number, label: string): Promise<void>;
  /** Text written since the last call, in order. */
  $append(extension: string, handle: number, text: string): Promise<void>;
  $replace(extension: string, handle: number, text: string): Promise<void>;
  $clear(extension: string, handle: number): Promise<void>;
  $reveal(extension: string, handle: number, preserveFocus: boolean): Promise<void>;
  $close(extension: string, handle: number): Promise<void>;
  $dispose(extension: string, handle: number): Promise<void>;
}

export const MainThreadOutputServiceProxy = createProxyIdentifier<MainThreadOutputServiceShape>('MainThreadOutputService');

// Message options, progress and status bar messages (wr-x0vf.hyt).

export interface MessageOptionsDto {
  readonly modal?: boolean;
  readonly detail?: string;
}

export interface MessageItemDto {
  readonly title: string;
  readonly isCloseAffordance?: boolean;
}

/**
 * More methods of the `MainThreadMessageService` proxy of `extHost.protocol.messages.ts`: the one handler
 * answers both shapes.
 */
export interface MainThreadMessageOptionsShape {
  /** Resolves to the index of the chosen item, or `undefined` when the message closed without one. */
  $showMessageWithOptions(
    extension: string, severity: MessageSeverity, message: string, options: MessageOptionsDto, items: readonly MessageItemDto[],
  ): Promise<number | undefined>;
}

export interface ProgressOptionsDto {
  /** `ProgressLocation`: 1 source control, 10 window, 15 notification; a view is `{ viewId }`. */
  readonly location: number | { readonly viewId: string };
  readonly title?: string;
  readonly cancellable?: boolean;
}

export interface ProgressStepDto {
  readonly message?: string;
  readonly increment?: number;
}

export interface MainThreadProgressShape {
  $startProgress(extension: string, handle: number, options: ProgressOptionsDto): Promise<void>;
  $progressReport(extension: string, handle: number, step: ProgressStepDto): Promise<void>;
  $progressEnd(extension: string, handle: number): Promise<void>;
  $setStatusBarMessage(extension: string, id: number, text: string): Promise<void>;
  $disposeStatusBarMessage(extension: string, id: number): Promise<void>;
}

export interface ExtHostProgressShape {
  $acceptProgressCanceled(handle: number): Promise<void>;
}

export const MainThreadProgressProxy = createProxyIdentifier<MainThreadProgressShape>('MainThreadProgress');
export const ExtHostProgressProxy = createProxyIdentifier<ExtHostProgressShape>('ExtHostProgress');
