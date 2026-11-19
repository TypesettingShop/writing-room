import { expect, test, vi } from 'vitest';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { MenuCommandContext, MenuId } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { MainThreadCommands } from '../../browser/mainThreadCommands.js';

test('resolves the menu group and strips workbench tab contexts for missing resources', async () => {
  const scope = () => ({ contextMatchesRules: () => true, onDidChangeContext: Event.None });
  const firstResource = URI.parse('untitled:first');
  const secondResource = URI.parse('untitled:second');
  const firstMenu = scope();
  const first = {
    titleMenuContext: firstMenu,
    activeEditor: { resource: firstResource },
    getEditorByIndex: (index: number) => index === 0 ? { resource: secondResource } : undefined,
  };
  const active = { titleMenuContext: scope(), activeEditor: { resource: secondResource } };
  const lookup = { groups: [first, active], activeGroup: active, getGroup: (id: number) => id === 1 ? first : undefined };
  const instantiation = new InstantiationService(new ServiceCollection([IEditorGroupsService, lookup as unknown as IEditorGroupsService]));
  const execute = vi.fn(async (_key: string, _command: string, args: unknown[]) => args);
  const commands = new MainThreadCommands({ $executeContributedCommand: execute }, {
    extensionId: () => 'test.extension', commandOwner: () => 'test.extension', activate: async () => {},
  }, instantiation);
  const command = 'test.menuResource';
  try {
    await commands.$registerCommand('1', command);
    const handler = CommandsRegistry.getCommand(command)!.handler;
    const title = new MenuCommandContext(MenuId.EditorTitle, firstMenu);
    const context = new MenuCommandContext(MenuId.EditorTitleContext, scope());
    await expect(instantiation.invokeFunction(handler, title)).resolves.toEqual([firstResource]);
    await expect(instantiation.invokeFunction(handler, context, { groupId: 1 }, 'arg')).resolves.toEqual([firstResource, 'arg']);
    await expect(instantiation.invokeFunction(handler, context, { groupId: 1, editorIndex: 0 })).resolves.toEqual([secondResource]);
    await expect(instantiation.invokeFunction(handler, context, { groupId: 1, editorIndex: 6 }, 'arg')).resolves.toEqual(['arg']);
    await expect(instantiation.invokeFunction(handler, context, { groupId: 99 })).resolves.toEqual([]);
  } finally {
    commands.dispose();
  }
});
