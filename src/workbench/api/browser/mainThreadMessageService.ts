import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { NotificationsToasts } from '../../browser/parts/notifications/notificationsToasts.js';
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
