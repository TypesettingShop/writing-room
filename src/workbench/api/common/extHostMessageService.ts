import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { MainThreadMessageServiceProxy } from './extHost.protocol.messages.js';
import type * as vscode from 'vscode';
import type { MessageSeverity } from './extHost.protocol.js';
import type { MainThreadMessageOptionsShape, MessageItemDto } from './extHost.protocol.windowUi.js';

function isMessageItem(value: unknown): value is vscode.MessageItem {
  return !!value && typeof value === 'object' && typeof (value as vscode.MessageItem).title === 'string';
}

export class ExtHostMessageService {
  constructor(private readonly proxy: MainThreadMessageOptionsShape) {}

  /**
   * As in VS Code, the first argument after the message is the options unless it is a string or an item.
   * Only the items' titles cross; the chosen item comes back as the very object that was passed.
   */
  async showMessage<T extends string | vscode.MessageItem>(
    extension: string, severity: MessageSeverity, message: string, optionsOrFirstItem?: vscode.MessageOptions | T, ...rest: T[]
  ): Promise<T | undefined> {
    let options: vscode.MessageOptions = {};
    let items: T[];
    if (typeof optionsOrFirstItem === 'string' || isMessageItem(optionsOrFirstItem)) {
      items = [optionsOrFirstItem as T, ...rest];
    } else {
      options = optionsOrFirstItem && typeof optionsOrFirstItem === 'object' ? optionsOrFirstItem : {};
      items = rest;
    }
    const entries = items.flatMap((item, index): { item: T; dto: MessageItemDto; index: number }[] =>
      typeof item === 'string' ? [{ item, index, dto: { title: item } }]
        : isMessageItem(item) ? [{ item, index, dto: { title: item.title, isCloseAffordance: item.isCloseAffordance === true } }]
          : []);
    const chosen = await this.proxy.$showMessageWithOptions(extension, severity, String(message), {
      modal: options.modal === true,
      detail: typeof options.detail === 'string' ? options.detail : undefined,
    }, entries.map(entry => entry.dto));
    return typeof chosen === 'number' ? entries[chosen]?.item : undefined;
  }
}

extHostApiRegistry.register('messages', ({ rpc }) => {
  const messages = new ExtHostMessageService(
    rpc.getProxy(MainThreadMessageServiceProxy) as unknown as MainThreadMessageOptionsShape);
  return {
    service: messages,
    create: ({ key }) => {
      const show = (severity: MessageSeverity) => promiseApiMethod(
        <T extends string | vscode.MessageItem>(message: string, optionsOrFirstItem?: vscode.MessageOptions | T, ...items: T[]) =>
          messages.showMessage(key, severity, message, optionsOrFirstItem, ...items),
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
