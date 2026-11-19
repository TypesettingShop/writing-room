import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';
import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { MainThreadDialogsProxy } from './extHost.protocol.dialogs.js';
import type { MainThreadDialogOpenOptions, MainThreadDialogSaveOptions, MainThreadDialogsShape } from './extHost.protocol.dialogs.js';

/** Only the fields the dialogs read cross; the main thread checks their types. */
function pick<T extends object>(options: unknown, keys: readonly (keyof T)[]): T | undefined {
  if (options === undefined || options === null || typeof options !== 'object') {
    return options as T | undefined;
  }
  const result: Partial<T> = {};
  for (const key of keys) {
    const value = (options as T)[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

const OPEN_KEYS = ['defaultUri', 'openLabel', 'canSelectFiles', 'canSelectFolders', 'canSelectMany', 'filters', 'title'] as const;
const SAVE_KEYS = ['defaultUri', 'saveLabel', 'filters', 'title'] as const;

/** `window.showOpenDialog` and `window.showSaveDialog`: the main thread asks, checks and answers. */
export class ExtHostDialogs {
  constructor(private readonly proxy: MainThreadDialogsShape) {}

  async showOpenDialog(extension: string, options?: vscode.OpenDialogOptions): Promise<vscode.Uri[] | undefined> {
    const result = await this.proxy.$showOpenDialog(extension, pick<MainThreadDialogOpenOptions>(options, OPEN_KEYS));
    return Array.isArray(result) ? result.filter(URI.isUri) as vscode.Uri[] : undefined;
  }

  async showSaveDialog(extension: string, options?: vscode.SaveDialogOptions): Promise<vscode.Uri | undefined> {
    const result = await this.proxy.$showSaveDialog(extension, pick<MainThreadDialogSaveOptions>(options, SAVE_KEYS));
    return URI.isUri(result) ? result as vscode.Uri : undefined;
  }
}

extHostApiRegistry.register('dialogs', ({ rpc }) => {
  const dialogs = new ExtHostDialogs(rpc.getProxy(MainThreadDialogsProxy));
  return {
    service: dialogs,
    create: ({ key }) => ({
      namespaces: {
        window: {
          showOpenDialog: promiseApiMethod((options?: vscode.OpenDialogOptions) => dialogs.showOpenDialog(key, options)),
          showSaveDialog: promiseApiMethod((options?: vscode.SaveDialogOptions) => dialogs.showSaveDialog(key, options)),
        } satisfies Pick<typeof vscode.window, 'showOpenDialog' | 'showSaveDialog'>,
      },
    }),
  };
});
