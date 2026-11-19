// @vitest-environment node
import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { createExtensionApi } from '../../common/extHost.api.impl.js';
import { ExtHostContext, MainContext } from '../../common/extHost.protocol.js';
import { ExtHostApiRegistry, extHostApiRegistry, promiseApiMethod } from '../../common/extHostApiRegistry.js';
import { ExtHostExtensionService } from '../../common/extHostExtensionService.js';
import { createTestRpcPair } from './testExtensionHost.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';

const extension: HostExtensionDescription = {
  id: 'writer.test', key: '1', location: 'https://example.com/',
  entry: 'https://example.com/main.js', activationEvents: ['test'],
  manifest: { publisher: 'writer', name: 'test', version: '1.0.0' },
};

test('joins an area’s window, type and context, guards methods and isolates cleanup', async () => {
  const events: string[] = [];
  let current = 0;
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const first = extHostApiRegistry.register('test.first', () => ({
    create: () => ({
      namespaces: { window: {
        sync: () => 42,
        async: promiseApiMethod(async () => 27),
        get current() { return current; },
      } },
      types: { TestType: class {} },
      context: { belongsToFirst: 1 },
    }),
    release: () => { events.push('first'); throw new Error('test error'); },
  }));
  const second = extHostApiRegistry.register('test.second', () => ({
    release: () => events.push('second'),
    dispose: () => events.push('dispose'),
  }));
  const channel = new MessageChannel();
  const main = new RPCProtocol(channel.port1);
  const worker = new RPCProtocol(channel.port2);
  main.set(MainContext.MainThreadExtensionService, { async $setActivationStatus() {} });
  let showInformationMessage!: typeof vscode.window.showInformationMessage;
  let windowApi!: { sync(): number; async(): Promise<number>; readonly current: number };
  const service = new ExtHostExtensionService(worker, async (_extension, api) => {
    showInformationMessage = api.window.showInformationMessage;
    windowApi = api.window as unknown as typeof windowApi;
    expect(api).toHaveProperty('TestType');
    return {
      async activate(context) {
        expect(context).toHaveProperty('belongsToFirst', 1);
        expect(windowApi.sync()).toBe(42);
        expect(windowApi.current).toBe(0);
        current = 1;
        expect(windowApi.current).toBe(1);
        expect(await windowApi.async()).toBe(27);
        context.subscriptions.push({ dispose: () => events.push('subscription') });
      },
    };
  });
  try {
    const proxy = main.getProxy(ExtHostContext.ExtHostExtensionService);
    await proxy.$deltaExtensions([extension], []);
    await proxy.$activateByEvent('test');
    await proxy.$deltaExtensions([], [extension.key]);
    expect(events).toEqual(['subscription', 'first', 'second']);
    expect(() => windowApi.sync()).toThrow('no longer active');
    expect(() => windowApi.current).toThrow('no longer active');
    await expect(windowApi.async()).rejects.toThrow('no longer active');
    await expect(showInformationMessage('Inactive')).rejects.toThrow('no longer active');
    service.dispose();
    expect(events.at(-1)).toBe('dispose');
  } finally {
    first.dispose();
    second.dispose();
    main.dispose();
    worker.dispose();
    errorLog.mockRestore();
  }
});

test('reports both areas when contributions claim the same API property', () => {
  const create = () => ({ namespaces: { window: { duplicate: true } } });
  const contributions = new Map([['test.left', { create }], ['test.right', { create }]]);
  expect(() => createExtensionApi(contributions, extension, () => true, {} as vscode.ExtensionContext))
    .toThrow(/window\.duplicate.*test\.left.*test\.right/);
});

test('resolves area services even for later registrations and gives each host its own instance', () => {
  const registry = new ExtHostApiRegistry();
  const pair = createTestRpcPair();
  const create = (rpc: RPCProtocol) => registry.create({
    rpc, isLive: () => true, getViews: () => [], resolveCommandArgument: (_key, argument) => argument,
  });
  const provider = vi.fn(() => ({ service: { documentCount: 1 } }));
  registry.register('languageFeatures', services => ({
    service: { documents: services.getService<{ documentCount: number }>('documents') },
  }));
  registry.register('documents', provider);
  try {
    const worker = create(pair.worker);
    const second = create(pair.main);
    expect([...worker.keys()]).toEqual(['languageFeatures', 'documents']);
    expect(worker.get('languageFeatures')?.service).toEqual({ documents: worker.get('documents')?.service });
    expect(second.get('documents')?.service).not.toBe(worker.get('documents')?.service);
    expect(provider).toHaveBeenCalledTimes(2);
  } finally {
    pair.dispose();
  }
});

test('reports a dependency cycle and disposes initialized contributions on failure', () => {
  const registry = new ExtHostApiRegistry();
  const pair = createTestRpcPair();
  const dispose = vi.fn();
  registry.register('created', () => ({ dispose }));
  registry.register('documents', services => ({ service: services.getService('diagnostics') }));
  registry.register('diagnostics', services => ({ service: services.getService('documents') }));
  try {
    expect(() => registry.create({
      rpc: pair.worker, isLive: () => true, getViews: () => [], resolveCommandArgument: (_key, argument) => argument,
    })).toThrow('documents -> diagnostics -> documents');
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    pair.dispose();
  }
});
