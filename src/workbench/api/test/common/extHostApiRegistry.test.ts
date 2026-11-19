// @vitest-environment node
import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { createExtensionApi } from '../../common/extHost.api.impl.js';
import { ExtHostContext, MainContext } from '../../common/extHost.protocol.js';
import { extHostApiRegistry, promiseApiMethod } from '../../common/extHostApiRegistry.js';
import { ExtHostExtensionService } from '../../common/extHostExtensionService.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';

const extension: HostExtensionDescription = {
  id: 'writer.test', key: '1', location: 'https://example.com/',
  entry: 'https://example.com/main.js', activationEvents: ['test'],
  manifest: { publisher: 'writer', name: 'test', version: '1.0.0' },
};

test('joins an area’s window, type and context, guards methods and isolates cleanup', async () => {
  const events: string[] = [];
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const first = extHostApiRegistry.register('test.first', () => ({
    create: () => ({
      namespaces: { window: { sync: () => 42, async: promiseApiMethod(async () => 27) } },
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
  let windowApi!: { sync(): number; async(): Promise<number> };
  const service = new ExtHostExtensionService(worker, async (_extension, api) => {
    showInformationMessage = api.window.showInformationMessage;
    windowApi = api.window as unknown as typeof windowApi;
    expect(api).toHaveProperty('TestType');
    return {
      async activate(context) {
        expect(context).toHaveProperty('belongsToFirst', 1);
        expect(windowApi.sync()).toBe(42);
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
    expect(events).toEqual(['first', 'second', 'subscription']);
    expect(() => windowApi.sync()).toThrow('no longer active');
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
