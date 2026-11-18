// @vitest-environment node
import { expect, test, vi } from 'vitest';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { ExtHostContext, MainContext } from '../../common/extHost.protocol.js';
import { ExtHostExtensionService } from '../../common/extHostExtensionService.js';

function description(id: string): HostExtensionDescription {
  const location = 'https://example.com/' + id + '/';
  return { id, key: id, location, entry: location + 'main.js', manifest: { name: id, publisher: 'test', version: '1.0.0' },
    activationEvents: ['onCommand:test', 'onView:test'] };
}

test('coalesces activation, isolates failures, runs own command during activation and cleans up on removal', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const channel = new MessageChannel();
  const main = new RPCProtocol(channel.port1);
  const worker = new RPCProtocol(channel.port2);
  const events: string[] = [];
  const apis = new Set<unknown>();
  main.set(MainContext.MainThreadCommands, {
    async $registerCommand(ext, id) { events.push(ext + ':+' + id); },
    async $unregisterCommand(ext, id) { events.push(ext + ':-' + id); },
    async $executeCommand() { throw new Error('own command went to main thread'); },
  });
  main.set(MainContext.MainThreadExtensionService, {
    async $setActivationStatus(ext, status) { events.push(ext + ':' + status.state); },
  });
  const service = new ExtHostExtensionService(worker, async (ext, vscode) => {
    apis.add(vscode);
    return {
      async activate(ctx) {
        if (ext.id === 'bad') {
          throw new Error('expected failure');
        }
        const registration = vscode.commands.registerCommand('test', function (this: { prefix: string }, x: string) {
          return this.prefix + x;
        }, { prefix: ctx.extension.id + ':' });
        expect(() => vscode.commands.registerCommand('test', () => {})).toThrow("command 'test' already exists");
        expect(await vscode.commands.executeCommand('test', 'during activation')).toBe('ok:during activation');
        ctx.subscriptions.push(registration, { dispose: () => events.push('ok:disposed') });
      },
      deactivate() { events.push('ok:deactivated'); },
    };
  });
  try {
    const extensions = main.getProxy(ExtHostContext.ExtHostExtensionService);
    const commands = main.getProxy(ExtHostContext.ExtHostCommands);
    await extensions.$deltaExtensions([description('bad'), description('ok')], []);
    await Promise.all([extensions.$activateByEvent('onCommand:test'), extensions.$activateByEvent('onView:test')]);
    await extensions.$activateByEvent('onCommand:test');
    expect(events.filter(event => event === 'bad:activating')).toHaveLength(1);
    expect(events.filter(event => event === 'ok:activating')).toHaveLength(1);
    expect(events).toContain('bad:failed');
    expect(events).toContain('ok:active');
    expect(apis.size).toBe(2);
    expect(await commands.$executeContributedCommand('ok', 'test', ['after'])).toBe('ok:after');
    await extensions.$deltaExtensions([], ['ok']);
    expect(events).toEqual(expect.arrayContaining(['ok:-test', 'ok:deactivated', 'ok:disposed']));
    await expect(commands.$executeContributedCommand('ok', 'test', [])).rejects.toThrow('no longer active');
  } finally {
    service.dispose();
    main.dispose();
    worker.dispose();
    errorLog.mockRestore();
  }
});

test('fails activation when a command registration is rejected before activate returns', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const channel = new MessageChannel();
  const main = new RPCProtocol(channel.port1);
  const worker = new RPCProtocol(channel.port2);
  const states: string[] = [];
  main.set(MainContext.MainThreadCommands, {
    async $registerCommand(_ext, id) { throw new Error(`command '${id}' already exists`); },
    async $unregisterCommand() {},
    async $executeCommand() {},
  });
  main.set(MainContext.MainThreadExtensionService, {
    async $setActivationStatus(_ext, status) { states.push(status.state); },
  });
  const service = new ExtHostExtensionService(worker, async (_ext, vscode) => ({
    async activate() {
      vscode.commands.registerCommand('test', () => {});
      // The rejection settles while activation still waits for other work.
      await new Promise(resolve => setTimeout(resolve, 20));
    },
  }));
  try {
    const extensions = main.getProxy(ExtHostContext.ExtHostExtensionService);
    await extensions.$deltaExtensions([description('late')], []);
    await extensions.$activateByEvent('onCommand:test');
    await vi.waitFor(() => expect(states).toEqual(['activating', 'failed']));
  } finally {
    service.dispose();
    main.dispose();
    worker.dispose();
    errorLog.mockRestore();
  }
});
