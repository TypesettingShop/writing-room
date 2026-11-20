// @vitest-environment node
import { expect, test, vi } from 'vitest';
import type { MainThreadCommandsShape } from '../../common/extHost.protocol.js';
import { ExtHostCommands } from '../../common/extHostCommands.js';

/*
 * The API commands of `ExtHostCommands` (wr-c9d8): the language feature tests run a stand-in of it, so
 * the order `executeCommand` takes is checked here on the real class.
 */

function setup() {
  const live = new Set(['1', '2']);
  const proxy = {
    $registerCommand: vi.fn(async () => {}),
    $unregisterCommand: vi.fn(async () => {}),
    $executeCommand: vi.fn(async () => 'workbench'),
  };
  const commands = new ExtHostCommands(proxy as unknown as MainThreadCommandsShape, key => live.has(key), (_extension, argument) => argument);
  return { commands, proxy, live };
}

test('an API command answers before the extension\'s own command and the workbench, with the caller\'s key', async () => {
  const { commands, proxy } = setup();
  const own = vi.fn(() => 'own');
  commands.registerCommand('1', 'vscode.executeTest', own);
  const handler = vi.fn(async (extension: string, args: unknown[]) => ({ extension, args }));
  const registration = commands.registerApiCommand('vscode.executeTest', handler);
  await expect(commands.executeCommand('1', 'vscode.executeTest', [1])).resolves.toEqual({ extension: '1', args: [1] });
  await expect(commands.executeCommand('2', 'vscode.executeTest', [])).resolves.toEqual({ extension: '2', args: [] });
  expect(own).not.toHaveBeenCalled();
  expect(proxy.$executeCommand).not.toHaveBeenCalled();
  // Gone, the id is the extension's own again, and the workbench's for the other extension.
  registration.dispose();
  await expect(commands.executeCommand('1', 'vscode.executeTest', [])).resolves.toBe('own');
  await expect(commands.executeCommand('2', 'vscode.executeTest', [])).resolves.toBe('workbench');
});

test('an API command id is registered once, and a released extension cannot run one', async () => {
  const { commands, live } = setup();
  const first = commands.registerApiCommand('vscode.executeTest', async () => 'first');
  expect(() => commands.registerApiCommand('vscode.executeTest', async () => 'second')).toThrow('already exists');
  // Disposing the first twice, or after another took the id, does not take the other's.
  first.dispose();
  const second = commands.registerApiCommand('vscode.executeTest', async () => 'second');
  first.dispose();
  await expect(commands.executeCommand('1', 'vscode.executeTest', [])).resolves.toBe('second');
  live.delete('1');
  await expect(commands.executeCommand('1', 'vscode.executeTest', [])).rejects.toThrow('no longer active');
  second.dispose();
});
