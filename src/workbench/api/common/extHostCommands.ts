import { extensionActivation } from './extHostExtensionActivator.js';
import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { MainThreadCommandsProxy, ExtHostCommandsProxy } from './extHost.protocol.commands.js';
import type * as vscode from 'vscode';
import { Disposable, EventEmitter } from './extHostTypes.js';
import type { ExtHostCommandsShape, MainThreadCommandsShape } from './extHost.protocol.js';

type Command = { callback: (...args: any[]) => unknown; thisArg: unknown };

/** A command the extension host itself answers for every extension, as VS Code's `vscode.execute*` commands. */
export type ApiCommandHandler = (extension: string, args: unknown[]) => Promise<unknown>;

export class ExtHostCommands implements ExtHostCommandsShape {
  private readonly identifiers = new Map<string, string>();
  private readonly commands = new Map<string, Map<string, Command>>();
  private readonly pending = new Map<string, Set<Promise<void>>>();
  private readonly apiCommands = new Map<string, ApiCommandHandler>();

  constructor(
    private readonly proxy: MainThreadCommandsShape,
    private readonly isLive: (extension: string) => boolean,
    private readonly resolveArgument: (extension: string, argument: unknown) => unknown,
  ) {}

  setExtensionIdentifier(key: string, id: string): void {
    this.identifiers.set(key, id);
  }

  private extensionId(key: string): string {
    return this.identifiers.get(key) ?? 'unknown extension';
  }

  registerCommand(extension: string, id: string, callback: Command['callback'], thisArg?: unknown): vscode.Disposable {
    if (!id || typeof callback !== 'function') {
      throw new TypeError('A command needs an id and a handler.');
    }
    if (!this.isLive(extension)) {
      throw new Error(`Extension '${this.extensionId(extension)}' is no longer active.`);
    }
    const commands = this.commands.get(extension) ?? new Map<string, Command>();
    if (commands.has(id)) {
      throw new Error(`command '${id}' already exists`);
    }
    const command = { callback, thisArg };
    commands.set(id, command);
    this.commands.set(extension, commands);
    const registered = this.proxy.$registerCommand(extension, id);
    this.track(extension, registered);
    void registered.catch(() => {
      if (commands.get(id) === command) {
        commands.delete(id);
      }
    });
    return new Disposable(() => {
      if (commands.get(id) === command) {
        commands.delete(id);
        this.track(extension, this.proxy.$unregisterCommand(extension, id));
      }
    });
  }

  private track(extension: string, operation: Promise<void>): void {
    const operations = this.pending.get(extension) ?? new Set();
    operations.add(operation);
    this.pending.set(extension, operations);
    void operation.then(
      () => operations.delete(operation),
      // A rejected registration stays pending so that flush() fails activation however early it settled.
      error => {
        if (this.isLive(extension)) {
          console.error(`[${this.extensionId(extension)}] Command registration failed:`, error);
        }
      },
    );
  }

  async flush(extension: string): Promise<void> {
    await Promise.all(this.pending.get(extension) ?? []);
  }

  /**
   * Registers an API command: `executeCommand` runs it on the extension host, before the extension's
   * own commands and the workbench's, with the calling extension's key. An id is registered once.
   */
  registerApiCommand(id: string, handler: ApiCommandHandler): { dispose(): void } {
    if (!id || typeof handler !== 'function') {
      throw new TypeError('An API command needs an id and a handler.');
    }
    if (this.apiCommands.has(id)) {
      throw new Error(`API command '${id}' already exists`);
    }
    this.apiCommands.set(id, handler);
    return new Disposable(() => {
      if (this.apiCommands.get(id) === handler) {
        this.apiCommands.delete(id);
      }
    });
  }

  executeCommand<T>(extension: string, id: string, args: unknown[]): Promise<T> {
    if (!this.isLive(extension)) {
      return Promise.reject(new Error(`Extension '${this.extensionId(extension)}' is no longer active.`));
    }
    const api = this.apiCommands.get(id);
    if (api) {
      return api(extension, args) as Promise<T>;
    }
    return (this.commands.get(extension)?.has(id)
      ? this.$executeContributedCommand(extension, id, args)
      : this.proxy.$executeCommand(extension, id, args)) as Promise<T>;
  }

  async $executeContributedCommand(extension: string, id: string, args: unknown[]): Promise<unknown> {
    if (!this.isLive(extension)) {
      throw new Error(`Extension '${this.extensionId(extension)}' is no longer active.`);
    }
    const command = this.commands.get(extension)?.get(id);
    if (!command) {
      throw new Error(`command '${id}' not found`);
    }
    try {
      return await command.callback.apply(command.thisArg, args.map(argument => this.resolveArgument(extension, argument)));
    } catch (error) {
      console.error(`[${this.extensionId(extension)}] Command '${id}' failed:`, error);
      throw error;
    }
  }

  remove(extension: string): void {
    const commands = this.commands.get(extension);
    this.commands.delete(extension);
    this.pending.delete(extension);
    this.identifiers.delete(extension);
    if (!commands) {
      return;
    }
    for (const id of commands.keys()) {
      void this.proxy.$unregisterCommand(extension, id).catch(() => {});
    }
    commands.clear();
  }
}

extHostApiRegistry.register('commands', services => {
  const commands = new ExtHostCommands(
    services.rpc.getProxy(MainThreadCommandsProxy), services.isLive, services.resolveCommandArgument,
  );
  services.rpc.set(ExtHostCommandsProxy, commands);
  return {
    service: commands,
    create: extension => {
      const { id, key } = extension;
      const registered = extensionActivation.get(extension)?.commands;
      commands.setExtensionIdentifier(key, id);
      return {
        types: { Disposable, EventEmitter },
        namespaces: {
          commands: {
            registerCommand: (command, callback, thisArg) => {
              const registration = commands.registerCommand(key, command, callback, thisArg);
              registered?.add(command);
              return new Disposable(() => {
                registered?.delete(command);
                registration.dispose();
              });
            },
            executeCommand: promiseApiMethod(<T>(command: string, ...args: unknown[]) => commands.executeCommand<T>(key, command, args)),
          } satisfies Pick<typeof vscode.commands, 'registerCommand' | 'executeCommand'>,
        },
      };
    },
    flush: key => commands.flush(key),
    release: key => commands.remove(key),
  };
});
