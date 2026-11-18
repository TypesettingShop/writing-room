import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';
import type { ResolvedKeybinding } from '../../keybinding/common/keybinding.js';

export const IQuickInputService = createDecorator<IQuickInputService>('quickInputService');

export interface IQuickPickItem {
  readonly type?: 'item';
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly id?: string;
  readonly keybinding?: ResolvedKeybinding;
}

export interface IQuickPickSeparator {
  readonly type: 'separator';
  readonly label: string;
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
  pick<T extends IQuickPickItem>(items: readonly (T | IQuickPickSeparator)[], options?: IPickOptions): Promise<T | undefined>;
  input(options?: IInputOptions): Promise<string | undefined>;
}
