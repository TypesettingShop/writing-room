import { Severity } from '../../../base/common/severity.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';

export { Severity };

export const IDialogService = createDecorator<IDialogService>('dialogService');

export interface IPrompt {
  readonly type: Severity;
  /** Plain text, as is `detail`: neither is read as markup. */
  readonly message: string;
  readonly detail?: string;
  readonly source?: string;
  /** The buttons in order; the first is the default. */
  readonly buttons: readonly string[];
  /** The button that Escape chooses. Without one Escape closes the dialog with no choice. */
  readonly cancelButton?: number;
}

export interface IPromptHandle {
  /** The chosen button's index, or `undefined` when the dialog closed with no choice. */
  readonly result: Promise<number | undefined>;
  /** Closes the dialog with no choice; a dialog still waiting for its turn never shows. */
  close(): void;
}

/**
 * Modal dialogs: while one is open, the workbench behind it takes no focus and no clicks. One shows at a
 * time; the others wait in order. The workbench asks with a quick pick; this is for extensions' modal
 * messages.
 */
export interface IDialogService extends BrandedService {
  prompt(prompt: IPrompt): IPromptHandle;
}
