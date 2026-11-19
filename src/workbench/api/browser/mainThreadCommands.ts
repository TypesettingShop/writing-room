import { URI } from '../../../base/common/uri.js';
import { MenuCommandContext, MenuId, menuContextHandlers } from '../../../platform/actions/common/actions.js';
import { IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { isEditorCommandsContext } from '../../common/editor.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadCommandsProxy, ExtHostCommandsProxy } from '../common/extHost.protocol.commands.js';
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

function resolveCommandArguments(accessor: ServicesAccessor, args: unknown[]): unknown[] {
  const [context, ...forwarded] = args;
  if (!(context instanceof MenuCommandContext)) {
    return args;
  }
  const [target, ...rest] = forwarded;
  if (URI.isUri(target)) {
    return forwarded;
  }
  if (target && typeof target === 'object' && 'resource' in target && URI.isUri(target.resource)) {
    return [target.resource, ...rest];
  }
  if (context.menu === MenuId.ExplorerContext) {
    return forwarded;
  }
  const editors = accessor.get(IEditorGroupsService);
  if (isEditorCommandsContext(target)) {
    // The workbench's own tab context names the editor; the extension gets its resource, not the context.
    const group = editors.getGroup(target.groupId);
    const editor = target.editorIndex === undefined ? group?.activeEditor : group?.getEditorByIndex(target.editorIndex);
    return editor?.resource ? [editor.resource, ...rest] : rest;
  }
  const group = editors.groups.find(group => group.scopedContextKeyService === context.scope) ?? editors.activeGroup;
  const resource = group.activeEditor?.resource;
  return resource ? [resource, ...forwarded] : forwarded;
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
      const handler = (accessor: ServicesAccessor, ...args: unknown[]) => {
        const owner = this.host.commandOwner(id);
        const selected = owner ? [...keys].find(key => this.host.extensionId(key) === owner) : [...keys].at(-1);
        if (!selected) {
          throw new Error(`command '${id}' not found`);
        }
        return this.proxy.$executeContributedCommand(selected, id, resolveCommandArguments(accessor, args));
      };
      menuContextHandlers.add(handler);
      const disposable = this.registrations.add(CommandsRegistry.registerCommand(id, handler));
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

mainThreadCustomers.register('commands', ({ rpc, getExtension, commandOwner, activate, instantiation }) => {
  const commands = new MainThreadCommands(rpc.getProxy(ExtHostCommandsProxy), {
    extensionId: key => getExtension(key)?.id,
    commandOwner,
    activate,
  }, instantiation);
  rpc.set(MainThreadCommandsProxy, commands);
  return commands;
});
