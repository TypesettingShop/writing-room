import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import type { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { ExtHostCommandsShape, MainThreadCommandsShape } from '../common/extHost.protocol.js';

export interface CommandHostAccess {
  extensionId(key: string): string | undefined;
  commandOwner(command: string): string | undefined;
  activate(event: string, origin: string): Promise<void>;
}

export class MainThreadCommands extends Disposable implements MainThreadCommandsShape {
  private readonly registrations = this._register(new DisposableStore());
  private readonly commands = new Map<string, { keys: Set<string>; disposable: IDisposable }>();

  constructor(
    private readonly proxy: ExtHostCommandsShape,
    private readonly host: CommandHostAccess,
    private readonly instantiation: IInstantiationService,
  ) {
    super();
  }

  async $registerCommand(extension: string, id: string): Promise<void> {
    if (!this.host.extensionId(extension)) {
      throw new Error('The extension is no longer registered.');
    }
    let command = this.commands.get(id);
    if (!command) {
      if (CommandsRegistry.getCommand(id)) {
        throw new Error(`command '${id}' already exists`);
      }
      const keys = new Set<string>();
      const disposable = this.registrations.add(CommandsRegistry.registerCommand(id, (_accessor, ...args) => {
        const owner = this.host.commandOwner(id);
        const selected = owner ? [...keys].find(key => this.host.extensionId(key) === owner) : [...keys].at(-1);
        if (!selected) {
          throw new Error(`command '${id}' not found`);
        }
        return this.proxy.$executeContributedCommand(selected, id, args);
      }));
      command = { keys, disposable };
      this.commands.set(id, command);
    }
    command.keys.add(extension);
  }

  async $unregisterCommand(extension: string, id: string): Promise<void> {
    const command = this.commands.get(id);
    if (command?.keys.delete(extension) && command.keys.size === 0) {
      this.registrations.delete(command.disposable);
      this.commands.delete(id);
    }
  }

  async $executeCommand(extension: string, id: string, args: unknown[]): Promise<unknown> {
    if (!this.host.extensionId(extension)) {
      throw new Error('The extension is no longer registered.');
    }
    await this.host.activate('onCommand:' + id, extension);
    const command = CommandsRegistry.getCommand(id);
    if (!command) {
      throw new Error(`command '${id}' not found`);
    }
    return this.instantiation.invokeFunction(command.handler, ...args);
  }

  remove(extension: string): void {
    for (const id of this.commands.keys()) {
      void this.$unregisterCommand(extension, id);
    }
  }

  override dispose(): void {
    super.dispose();
    this.commands.clear();
  }
}
