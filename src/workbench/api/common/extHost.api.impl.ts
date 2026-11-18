import type * as vscode from 'vscode';
import type { ExtHostCommands } from './extHostCommands.js';
import type { ExtHostTreeViews } from './extHostTreeViews.js';
import type { ExtHostStatusBar } from './extHostStatusBar.js';
import type { ExtHostMessageService } from './extHostMessageService.js';
import type { MessageSeverity } from './extHost.protocol.js';
import { Disposable, EventEmitter, TreeItem, TreeItemCollapsibleState, StatusBarAlignment } from './extHostTypes.js';

export function createApiFactory(
  commands: ExtHostCommands, trees: ExtHostTreeViews, status: ExtHostStatusBar, messages: ExtHostMessageService,
): (id: string, isLive: () => boolean) => typeof vscode {
  return (id, isLive) => {
    const checkLive = () => {
      if (!isLive()) {
        throw new Error(`Extension '${id}' is no longer active.`);
      }
    };
    const show = (severity: MessageSeverity) =>
      <T extends string | vscode.MessageItem>(message: string, ...items: T[]) => {
        checkLive();
        return messages.showMessage(id, severity, message, items);
      };
    const api = {
      Disposable,
      EventEmitter,
      TreeItem,
      TreeItemCollapsibleState,
      StatusBarAlignment,
      window: Object.freeze({
        registerTreeDataProvider: (view, provider) => {
          checkLive();
          return trees.createTreeView(id, view, provider);
        },
        createTreeView: (view, options) => {
          checkLive();
          return trees.createTreeView(id, view, options.treeDataProvider);
        },
        createStatusBarItem: (alignment, priority) => {
          checkLive();
          return status.createStatusBarItem(id, alignment, priority);
        },
        showInformationMessage: show('info'),
        showWarningMessage: show('warning'),
        showErrorMessage: show('error'),
      } satisfies typeof vscode.window),
      commands: Object.freeze({
        registerCommand: (command, callback, thisArg) => {
          checkLive();
          return commands.registerCommand(id, command, callback, thisArg);
        },
        executeCommand: <T>(command: string, ...args: unknown[]) => {
          if (!isLive()) {
            return Promise.reject(new Error(`Extension '${id}' is no longer active.`));
          }
          return commands.executeCommand<T>(id, command, args);
        },
      } satisfies typeof vscode.commands),
    } satisfies typeof vscode;
    return Object.freeze(api);
  };
}
