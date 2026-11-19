import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { dispose } from '../../../base/common/lifecycle.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadMessageServiceProxy } from '../common/extHost.protocol.messages.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { NotificationsToasts } from '../../browser/parts/notifications/notificationsToasts.js';
import type { MainThreadMessageServiceShape, MessageSeverity } from '../common/extHost.protocol.js';

export class MainThreadMessageService implements MainThreadMessageServiceShape, IDisposable {
  private readonly messages = new Map<string, Set<IDisposable>>();

  constructor(
    private readonly toasts: NotificationsToasts,
    private readonly isRegistered: (key: string) => boolean,
  ) {}

  async $showMessage(extension: string, severity: MessageSeverity, message: string, actions: string[]): Promise<number | undefined> {
    if (!this.isRegistered(extension)) {
      return undefined;
    }
    const entries = this.messages.get(extension) ?? new Set();
    this.messages.set(extension, entries);
    return new Promise(resolve => {
      const entry = this.toasts.show(severity, message, actions, index => {
        entries.delete(entry);
        resolve(index);
      });
      entries.add(entry);
    });
  }

  remove(extension: string): void {
    const entries = this.messages.get(extension);
    this.messages.delete(extension);
    for (const entry of entries ?? []) {
      entry.dispose();
    }
  }

  dispose(): void {
    for (const extension of this.messages.keys()) {
      this.remove(extension);
    }
  }
}

mainThreadCustomers.register('messages', ({ rpc, instantiation, getExtension }) => {
  const layout = instantiation.invokeFunction(accessor => accessor.get(ILayoutService));
  const toasts = new NotificationsToasts(layout.mainContainer);
  const messages = new MainThreadMessageService(toasts, key => Boolean(getExtension(key)));
  rpc.set(MainThreadMessageServiceProxy, messages);
  return {
    remove: key => messages.remove(key),
    dispose: () => dispose([toasts, messages]),
  };
});
