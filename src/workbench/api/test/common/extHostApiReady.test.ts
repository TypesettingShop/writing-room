// @vitest-environment node
import { expect, test, vi } from 'vitest';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { ExtHostContext, MainContext } from '../../common/extHost.protocol.js';
import { extHostApiRegistry } from '../../common/extHostApiRegistry.js';
import { ExtHostExtensionService } from '../../common/extHostExtensionService.js';

const location = 'https://example.com/gated/';
const gated: HostExtensionDescription = {
  id: 'gated', key: 'gated', location, entry: location + 'main.js',
  manifest: { name: 'gated', publisher: 'test', version: '1.0.0' }, activationEvents: ['onCommand:test'],
};

test('waits for every API area to be ready before activating an extension', async () => {
  let open!: () => void;
  const area = extHostApiRegistry.register('test.ready', () => ({ ready: new Promise<void>(resolve => { open = resolve; }) }));
  const channel = new MessageChannel();
  const main = new RPCProtocol(channel.port1);
  const worker = new RPCProtocol(channel.port2);
  const states: string[] = [];
  main.set(MainContext.MainThreadCommands, {
    async $registerCommand() {},
    async $unregisterCommand() {},
    async $executeCommand() {},
  });
  main.set(MainContext.MainThreadExtensionService, {
    async $setActivationStatus(_ext, status) { states.push(status.state); },
  });
  const service = new ExtHostExtensionService(worker, async () => ({ activate() {} }));
  try {
    const extensions = main.getProxy(ExtHostContext.ExtHostExtensionService);
    await extensions.$deltaExtensions([gated], []);
    const activation = extensions.$activateByEvent('onCommand:test');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(states).toEqual([]);
    open();
    await activation;
    await vi.waitFor(() => expect(states).toEqual(['activating', 'active']));
  } finally {
    service.dispose();
    main.dispose();
    worker.dispose();
    area.dispose();
  }
});
