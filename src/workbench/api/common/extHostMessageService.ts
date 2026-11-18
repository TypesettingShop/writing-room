import type * as vscode from 'vscode';
import type { MainThreadMessageServiceShape, MessageSeverity } from './extHost.protocol.js';

export class ExtHostMessageService {
  constructor(private readonly proxy: MainThreadMessageServiceShape) {}

  async showMessage<T extends string | vscode.MessageItem>(
    extension: string, severity: MessageSeverity, message: string, items: readonly T[],
  ): Promise<T | undefined> {
    const index = await this.proxy.$showMessage(extension, severity, message,
      items.map(item => typeof item === 'string' ? item : item.title));
    return index === undefined ? undefined : items[index];
  }
}
