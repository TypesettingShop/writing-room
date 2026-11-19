import type { Event } from '../../../base/common/event.js';
import { Severity } from '../../../base/common/severity.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';

export { Severity };

export const INotificationService = createDecorator<INotificationService>('notificationService');

export interface INotificationAction {
  readonly label: string;
  /** Runs the action; the notification closes afterwards unless `keepOpen` is set. */
  run(): void;
  readonly keepOpen?: boolean;
  /** A disabled action keeps its button, which does nothing. */
  readonly enabled?: boolean;
}

export interface INotificationProgressState {
  /** Shows a running bar without an amount. */
  readonly infinite?: boolean;
  /** Percent done, 0 to 100. */
  readonly worked?: number;
}

export interface INotification {
  readonly severity: Severity;
  /** Plain text: it is never read as markup. */
  readonly message: string;
  /** Who sent it, such as an extension's name. */
  readonly source?: string;
  readonly actions?: readonly INotificationAction[];
  readonly progress?: INotificationProgressState;
}

export interface INotificationHandle {
  /** Fires once, when the notification closes for any reason. */
  readonly onDidClose: Event<void>;
  readonly closed: boolean;
  updateMessage(message: string): void;
  updateProgress(progress: INotificationProgressState | undefined): void;
  updateActions(actions: readonly INotificationAction[]): void;
  close(): void;
}

export interface IPromptChoice {
  readonly label: string;
  run(): void;
}

export interface IPromptOptions {
  readonly source?: string;
  /** Runs when the notification closes without a choice. */
  onCancel?(): void;
}

/**
 * Shows notifications as toasts at the bottom right. At most three are visible; the rest wait in order,
 * and when one source floods the queue its oldest waiting notifications are dropped.
 */
export interface INotificationService extends BrandedService {
  notify(notification: INotification): INotificationHandle;
  info(message: string): INotificationHandle;
  warn(message: string): INotificationHandle;
  error(message: string): INotificationHandle;
  /** A notification whose buttons are the choices. */
  prompt(severity: Severity, message: string, choices: readonly IPromptChoice[], options?: IPromptOptions): INotificationHandle;
}
