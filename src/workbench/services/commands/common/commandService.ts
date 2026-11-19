import { MenuCommandContext, menuContextHandlers } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtensionService } from '../../extensions/common/extensions.js';

export class CommandService implements ICommandService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IExtensionService private readonly extensionService: IExtensionService,
  ) {}

  async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    await this.extensionService.activateByEvent('onCommand:' + id);
    const command = CommandsRegistry.getCommand(id);
    if (!command) {
      throw new Error(`command '${id}' not found`);
    }
    // The activation above can have registered a handler since the menu action was made.
    const forwarded = args[0] instanceof MenuCommandContext && !menuContextHandlers.has(command.handler)
      ? args.slice(1) : args;
    return this.instantiationService.invokeFunction(command.handler, ...forwarded) as T;
  }
}

registerSingleton(ICommandService, CommandService);
