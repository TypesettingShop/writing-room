import type * as vscode from 'vscode';
import type { ExtHostCommands } from './extHostCommands.js';
import { Disposable, EventEmitter } from './extHostTypes.js';

export function createApiFactory(commands: ExtHostCommands): (id: string, isLive: () => boolean) => typeof vscode {
  return (id, isLive) => {
    const checkLive = () => {
      if (!isLive()) {
        throw new Error(`Extension '${id}' is no longer active.`);
      }
    };
    const api = {
      Disposable,
      EventEmitter,
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
