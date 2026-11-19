import { expect, test, vi } from 'vitest';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IExtensionService } from '../../../extensions/common/extensions.js';
import '../../common/commandService.js';

test('executes the newest handler and restores shadowed handlers on disposal', async () => {
  const commands = new InstantiationService().invokeFunction(accessor => accessor.get(ICommandService));
  const first = CommandsRegistry.registerCommand('test.shadow', () => 'first');
  const second = CommandsRegistry.registerCommand('test.shadow', () => 'second');
  const third = CommandsRegistry.registerCommand('test.shadow', () => 'third');
  try {
    expect(await commands.executeCommand('test.shadow')).toBe('third');
    second.dispose();
    expect(await commands.executeCommand('test.shadow')).toBe('third');
    third.dispose();
    expect(await commands.executeCommand('test.shadow')).toBe('first');
  } finally {
    first.dispose();
    second.dispose();
    third.dispose();
  }
  await expect(commands.executeCommand('test.shadow')).rejects.toThrow(/^command 'test.shadow' not found$/);
});

test('waits for extension activation before looking up the handler and passes accessor and arguments', async () => {
  const services = new ServiceCollection();
  let register!: () => void;
  const activateByEvent = vi.fn(() => new Promise<void>(resolve => { register = resolve; }));
  const extension: IExtensionService = {
    _serviceBrand: undefined,
    activateByEvent,
    activationEventIsDone: () => false,
    whenInstalledExtensionsRegistered: async () => true,
  };
  services.set(IExtensionService, extension);
  const commands = new InstantiationService(services).invokeFunction(accessor => accessor.get(ICommandService));
  const result = commands.executeCommand('test.activation', 'value', 7);
  expect(activateByEvent).toHaveBeenCalledExactlyOnceWith('onCommand:test.activation');
  const handle = CommandsRegistry.registerCommand('test.activation', (accessor, ...args) =>
    [accessor.get(IExtensionService) === extension, ...args]);
  try {
    register();
    await expect(result).resolves.toEqual([true, 'value', 7]);
  } finally {
    handle.dispose();
  }
});
