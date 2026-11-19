import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { MainThreadMessageServiceProxy } from './extHost.protocol.messages.js';
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

extHostApiRegistry.register('messages', ({ rpc }) => {
  const messages = new ExtHostMessageService(rpc.getProxy(MainThreadMessageServiceProxy));
  return {
    service: messages,
    create: ({ key }) => {
      const show = (severity: MessageSeverity) => promiseApiMethod(
        <T extends string | vscode.MessageItem>(message: string, ...items: T[]) =>
          messages.showMessage(key, severity, message, items),
      );
      return {
        namespaces: {
          window: {
            showInformationMessage: show('info'),
            showWarningMessage: show('warning'),
            showErrorMessage: show('error'),
          } satisfies Pick<typeof vscode.window, 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage'>,
        },
      };
    },
  };
});
