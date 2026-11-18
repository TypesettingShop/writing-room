import type * as vscode from 'vscode';
import { Disposable } from './extHostTypes.js';
import type { ExtHostCommandsShape, MainThreadCommandsShape } from './extHost.protocol.js';

type Command = { callback: (...args: any[]) => unknown; thisArg: unknown };

export class ExtHostCommands implements ExtHostCommandsShape {
  private readonly commands = new Map<string, Map<string, Command>>();
  private readonly pending = new Map<string, Set<Promise<void>>>();

  constructor(
    private readonly proxy: MainThreadCommandsShape,
    private readonly isLive: (extension: string) => boolean,
  ) {}

  registerCommand(extension: string, id: string, callback: Command['callback'], thisArg?: unknown): vscode.Disposable {
    if (!id || typeof callback !== 'function') {
      throw new TypeError('A command needs an id and a handler.');
    }
    if (!this.isLive(extension)) {
      throw new Error(`Extension '${extension}' is no longer active.`);
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
      error => {
        operations.delete(operation);
        if (this.isLive(extension)) {
          console.error(`[${extension}] Command registration failed:`, error);
        }
      },
    );
  }

  async flush(extension: string): Promise<void> {
    await Promise.all(this.pending.get(extension) ?? []);
  }

  executeCommand<T>(extension: string, id: string, args: unknown[]): Promise<T> {
    if (!this.isLive(extension)) {
      return Promise.reject(new Error(`Extension '${extension}' is no longer active.`));
    }
    return (this.commands.get(extension)?.has(id)
      ? this.$executeContributedCommand(extension, id, args)
      : this.proxy.$executeCommand(extension, id, args)) as Promise<T>;
  }

  async $executeContributedCommand(extension: string, id: string, args: unknown[]): Promise<unknown> {
    if (!this.isLive(extension)) {
      throw new Error(`Extension '${extension}' is no longer active.`);
    }
    const command = this.commands.get(extension)?.get(id);
    if (!command) {
      throw new Error(`command '${id}' not found`);
    }
    try {
      return await command.callback.apply(command.thisArg, args);
    } catch (error) {
      console.error(`[${extension}] Command '${id}' failed:`, error);
      throw error;
    }
  }

  remove(extension: string): void {
    const commands = this.commands.get(extension);
    this.commands.delete(extension);
    this.pending.delete(extension);
    if (!commands) {
      return;
    }
    for (const id of commands.keys()) {
      void this.proxy.$unregisterCommand(extension, id).catch(() => {});
    }
    commands.clear();
  }
}
