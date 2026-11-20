import { dispose } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../platform/notification/common/notification.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { extensionName } from './mainThreadProgress.js';
import { MainThreadMessageServiceProxy } from '../common/extHost.protocol.messages.js';
import type { MainThreadMessageServiceShape, MessageSeverity } from '../common/extHost.protocol.js';
import type { MainThreadMessageOptionsShape, MessageItemDto, MessageOptionsDto } from '../common/extHost.protocol.windowUi.js';
import '../../../platform/dialogs/browser/dialogService.js';
import '../../browser/parts/notifications/notificationsToasts.js';

const severities: Record<MessageSeverity, Severity> = { info: Severity.Info, warning: Severity.Warning, error: Severity.Error };

/**
 * Extension messages: a toast whose buttons are the items, or with `modal` a dialog. A toast closed
 * without a choice, and a dialog dismissed without a close item, answer `undefined`.
 */
export class MainThreadMessageService implements MainThreadMessageServiceShape, MainThreadMessageOptionsShape, IDisposable {
  private readonly messages = new Map<string, Set<IDisposable>>();

  constructor(
    private readonly notifications: INotificationService,
    private readonly dialogs: IDialogService,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
  ) {}

  $showMessage(extension: string, severity: MessageSeverity, message: string, actions: string[]): Promise<number | undefined> {
    return this.$showMessageWithOptions(extension, severity, message, {},
      Array.isArray(actions) ? actions.map(title => ({ title })) : []);
  }

  async $showMessageWithOptions(
    extension: string, severity: MessageSeverity, message: string, options: MessageOptionsDto, items: readonly MessageItemDto[],
  ): Promise<number | undefined> {
    const description = typeof extension === 'string' ? this.getExtension(extension) : undefined;
    if (!description) {
      return undefined;
    }
    const type = severities[severity] ?? Severity.Info;
    const text = typeof message === 'string' ? message : String(message);
    const list = (Array.isArray(items) ? items : []).map(item => ({
      title: typeof item?.title === 'string' ? item.title : '', isCloseAffordance: item?.isCloseAffordance === true,
    }));
    const source = extensionName(description);
    const entries = this.messages.get(extension) ?? new Set();
    this.messages.set(extension, entries);
    if (options?.modal === true) {
      return this.showModal(entries, type, text, typeof options.detail === 'string' ? options.detail : undefined, list, source);
    }
    return new Promise(resolve => {
      let chosen: number | undefined;
      const handle = this.notifications.prompt(type, text, list.map((item, index) => ({
        label: item.title, run: () => { chosen = index; },
      })), { source });
      if (handle.closed) {
        // The queue may drop it before prompt returns.
        resolve(undefined);
        return;
      }
      const entry = { dispose: () => handle.close() };
      entries.add(entry);
      handle.onDidClose(() => {
        entries.delete(entry);
        resolve(chosen);
      });
    });
  }

  /** As in VS Code: the first close item is the cancel button, last; without one, a Cancel (or OK) button is. */
  private async showModal(
    entries: Set<IDisposable>, type: Severity, message: string, detail: string | undefined,
    items: readonly { title: string; isCloseAffordance: boolean }[], source: string | undefined,
  ): Promise<number | undefined> {
    const cancelItem = items.findIndex(item => item.isCloseAffordance);
    const order = items.map((_, index) => index).filter(index => index !== cancelItem);
    const labels = order.map(index => items[index].title);
    labels.push(cancelItem !== -1 ? items[cancelItem].title : order.length ? 'Cancel' : 'OK');
    const handle = this.dialogs.prompt({ type, message, detail, source, buttons: labels, cancelButton: labels.length - 1 });
    const entry = { dispose: () => handle.close() };
    entries.add(entry);
    const button = await handle.result;
    entries.delete(entry);
    if (button === undefined) {
      return undefined;
    }
    return button < order.length ? order[button] : cancelItem !== -1 ? cancelItem : undefined;
  }

  remove(extension: string): void {
    const entries = this.messages.get(extension);
    this.messages.delete(extension);
    dispose([...entries ?? []]);
  }

  dispose(): void {
    for (const extension of [...this.messages.keys()]) {
      this.remove(extension);
    }
  }
}

mainThreadCustomers.register('messages', ({ rpc, instantiation, getExtension }) => {
  const { notifications, dialogs } = instantiation.invokeFunction(accessor => ({
    notifications: accessor.get(INotificationService), dialogs: accessor.get(IDialogService),
  }));
  const messages = new MainThreadMessageService(notifications, dialogs, getExtension);
  rpc.set(MainThreadMessageServiceProxy, messages);
  return messages;
});
