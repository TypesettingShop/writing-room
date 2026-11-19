// @vitest-environment node
import { expect, test, vi } from 'vitest';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { ExtHostContext, MainContext } from '../../common/extHost.protocol.js';
import { ExtHostExtensionService } from '../../common/extHostExtensionService.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

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
    await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining(['ok:-test', 'ok:deactivated', 'ok:disposed'])));
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

test('activates dependencies first and propagates failed, missing and cyclic dependencies', async () => {
  const channel = new MessageChannel();
  const main = new RPCProtocol(channel.port1);
  const worker = new RPCProtocol(channel.port2);
  const started: string[] = [];
  const failed = new Map<string, string>();
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  main.set(MainContext.MainThreadExtensionService, {
    async $setActivationStatus(id, status) {
      if (status.state === 'failed') {
        failed.set(id, status.message);
      }
    },
  });
  const service = new ExtHostExtensionService(worker, async extension => ({
    activate() {
      started.push(extension.id);
      if (extension.id === 'broken') {
        throw new Error('broken');
      }
    },
  }));
  const depends = (id: string, activationEvents: string[], ...extensionDependencies: string[]) => {
    const extension = description(id);
    return { ...extension, activationEvents, manifest: { ...extension.manifest, extensionDependencies } };
  };
  try {
    const host = main.getProxy(ExtHostContext.ExtHostExtensionService);
    await host.$deltaExtensions([
      depends('ok', ['test'], 'MIDDLE'), depends('middle', [], 'base'), depends('base', []),
      depends('missing', ['test'], 'absent'), depends('broken', []), depends('dependent', ['test'], 'broken'),
      depends('cycle-a', ['test'], 'cycle-b'), depends('cycle-b', ['parallel'], 'cycle-a'),
    ], []);
    await Promise.all([host.$activateByEvent('test'), host.$activateByEvent('parallel')]);
    expect(started.filter(id => id !== 'broken')).toEqual(['base', 'middle', 'ok']);
    expect(failed.get('missing')).toContain("'absent'");
    expect(failed.get('dependent')).toContain("'broken'");
    expect(failed.get('cycle-a')).toContain("'cycle-b'");
    expect(failed.get('cycle-b')).toContain("'cycle-a'");
  } finally {
    service.dispose();
    main.dispose();
    worker.dispose();
    errorLog.mockRestore();
  }
});

test('waits for another pending activation and breaks the closing command edge of a cycle', async () => {
  const channel = new MessageChannel();
  const main = new RPCProtocol(channel.port1);
  const worker = new RPCProtocol(channel.port2);
  const host = main.getProxy(ExtHostContext.ExtHostExtensionService);
  const commands = main.getProxy(ExtHostContext.ExtHostCommands);
  const owners = new Map<string, string>();
  const steps: string[] = [];
  const firstCall = deferred();
  main.set(MainContext.MainThreadExtensionService, { async $setActivationStatus() {} });
  main.set(MainContext.MainThreadCommands, {
    async $registerCommand(key, id) { owners.set(id, key); },
    async $unregisterCommand(_key, id) { owners.delete(id); },
    async $executeCommand(key, id, args) {
      const activated = host.$activateByEvent('onCommand:' + id, key);
      if (key === 'a') {
        firstCall.resolve();
      }
      await activated;
      const owner = owners.get(id);
      if (!owner) {
        throw new Error(`command '${id}' not found`);
      }
      return commands.$executeContributedCommand(owner, id, args);
    },
  });
  const service = new ExtHostExtensionService(worker, async (extension, api) => ({
    async activate() {
      if (extension.id === 'a') {
        api.commands.registerCommand('a', () => 'A');
        expect(await api.commands.executeCommand('b')).toBe('B');
        steps.push('a');
      } else {
        // B is already activating before A asks for B's command.
        await firstCall.promise;
        expect(await api.commands.executeCommand('a')).toBe('A');
        api.commands.registerCommand('b', () => 'B');
        steps.push('b');
      }
    },
  }));
  try {
    await host.$deltaExtensions(['a', 'b'].map(id => ({
      ...description(id), activationEvents: ['onCommand:' + id],
    })), []);
    await Promise.all([host.$activateByEvent('onCommand:b'), host.$activateByEvent('onCommand:a')]);
    expect(steps).toEqual(['b', 'a']);
  } finally {
    service.dispose();
    main.dispose();
    worker.dispose();
  }
});

test('keeps the API and registrations until asynchronous deactivation finishes', async () => {
  const channel = new MessageChannel();
  const main = new RPCProtocol(channel.port1);
  const worker = new RPCProtocol(channel.port2);
  const steps: string[] = [];
  const inside = deferred();
  const continueDeactivating = deferred();
  const removed = deferred();
  main.set(MainContext.MainThreadExtensionService, {
    async $setActivationStatus(_id, status) {
      if (status.state === 'inactive') {
        steps.push('removed');
        removed.resolve();
      }
    },
  });
  main.set(MainContext.MainThreadCommands, {
    async $registerCommand(_key, command) { steps.push(command + ':registered'); },
    async $unregisterCommand(_key, command) { steps.push(command + ':unregistered'); },
    async $executeCommand() { throw new Error('own command went to main thread'); },
  });
  const service = new ExtHostExtensionService(worker, async (_extension, api) => ({
    activate(context) {
      context.subscriptions.push({ dispose: () => steps.push('disposed') });
      api.commands.registerCommand('during', () => steps.push('called'));
    },
    async deactivate() {
      inside.resolve();
      await continueDeactivating.promise;
      await api.commands.executeCommand('during');
      api.commands.registerCommand('late', () => {});
    },
  }));
  try {
    const host = main.getProxy(ExtHostContext.ExtHostExtensionService);
    await host.$deltaExtensions([description('deactivate')], []);
    await host.$activateByEvent('onCommand:test');
    await host.$deltaExtensions([], ['deactivate']);
    await inside.promise;
    expect(steps).toEqual(['during:registered']);
    continueDeactivating.resolve();
    await removed.promise;
    expect(steps).toEqual([
      'during:registered', 'called', 'disposed', 'late:registered', 'during:unregistered', 'late:unregistered', 'removed',
    ]);
  } finally {
    service.dispose();
    main.dispose();
    worker.dispose();
  }
});

test('stops waiting for deactivation after five seconds and releases its API', async () => {
  const channel = new MessageChannel();
  const main = new RPCProtocol(channel.port1);
  const worker = new RPCProtocol(channel.port2);
  const removed = deferred();
  const inside = deferred();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const disposed = vi.fn();
  main.set(MainContext.MainThreadExtensionService, {
    async $setActivationStatus(_id, status) {
      if (status.state === 'inactive') {
        removed.resolve();
      }
    },
  });
  const service = new ExtHostExtensionService(worker, async (_extension, api) => ({
    activate(context) {
      context.subscriptions.push({ dispose: disposed });
    },
    async deactivate() {
      inside.resolve();
      await new Promise(() => {});
      await api.commands.executeCommand('never');
    },
  }));
  try {
    const host = main.getProxy(ExtHostContext.ExtHostExtensionService);
    await host.$deltaExtensions([description('timeout')], []);
    await host.$activateByEvent('onCommand:test');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await host.$deltaExtensions([], ['timeout']);
    await inside.promise;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(disposed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await removed.promise;
    expect(disposed).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('[timeout] Deactivation timed out after 5 seconds.');
  } finally {
    vi.useRealTimers();
    service.dispose();
    main.dispose();
    worker.dispose();
    warning.mockRestore();
  }
});
