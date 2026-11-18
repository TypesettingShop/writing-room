import { toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService, ServicesAccessor } from '../../instantiation/common/instantiation.js';

export const ICommandService = createDecorator<ICommandService>('commandService');

export interface ICommandService extends BrandedService {
  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
}

export type ICommandHandler<Args extends unknown[] = any[]> =
  (accessor: ServicesAccessor, ...args: Args) => unknown;

export interface ICommand<Args extends unknown[] = any[]> {
  readonly id: string;
  readonly handler: ICommandHandler<Args>;
}

class CommandRegistry {
  private readonly commands = new Map<string, ICommand[]>();

  registerCommand<Args extends unknown[]>(id: string, handler: ICommandHandler<Args>): IDisposable;
  registerCommand<Args extends unknown[]>(command: ICommand<Args>): IDisposable;
  registerCommand(id: string | ICommand, handler?: ICommandHandler): IDisposable {
    const command = typeof id === 'string' ? { id, handler } : id;
    if (!command.id || typeof command.handler !== 'function') {
      throw new Error('A command needs an id and a handler.');
    }

    const entry = { id: command.id, handler: command.handler };
    const entries = this.commands.get(entry.id) ?? [];
    this.commands.set(entry.id, entries);
    entries.push(entry);
    return toDisposable(() => {
      entries.splice(entries.indexOf(entry), 1);
      if (entries.length === 0) {
        this.commands.delete(entry.id);
      }
    });
  }

  getCommand(id: string): ICommand | undefined {
    return this.commands.get(id)?.at(-1);
  }

  getCommands(): Map<string, ICommand> {
    return new Map([...this.commands].map(([id, entries]) => [id, entries[entries.length - 1]]));
  }
}

export const CommandsRegistry = new CommandRegistry();
