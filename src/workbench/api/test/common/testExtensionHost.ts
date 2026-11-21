import type * as vscode from 'vscode';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { ExtHostContext, MainContext } from '../../common/extHost.protocol.js';
import { ExtHostExtensionService } from '../../common/extHostExtensionService.js';
import type { ExtensionLoader } from '../../common/extHostExtensionActivator.js';

export function createTestRpcPair() {
  const { port1, port2 } = new MessageChannel();
  const main = new RPCProtocol(port1);
  const worker = new RPCProtocol(port2);
  return { main, worker, dispose: () => { main.dispose(); worker.dispose(); } };
}

const extension: HostExtensionDescription = {
  key: '1', id: 'test.api', location: 'https://example.test/',
  entry: 'https://example.test/extension.js', activationEvents: ['test'],
  manifest: { name: 'api', publisher: 'test', version: '1.0.0' },
};

export async function createTestExtensionApi(load?: ExtensionLoader) {
  const pair = createTestRpcPair();
  let api: typeof vscode | undefined;
  let context: vscode.ExtensionContext | undefined;
  let failure: string | undefined;
  pair.main.set(MainContext.MainThreadExtensionService, {
    async $setActivationStatus(_key, state) {
      if (state.state === 'failed') {
        failure = state.message;
      }
    },
  });
  const service = new ExtHostExtensionService(pair.worker, async (extension, vscode, signal) => {
    api = vscode;
    const module = await load?.(extension, vscode, signal);
    return {
      activate(value) {
        context = value;
        return module?.activate?.(value);
      },
      deactivate: module?.deactivate?.bind(module),
    };
  });
  const dispose = () => { service.dispose(); pair.dispose(); };
  const host = pair.main.getProxy(ExtHostContext.ExtHostExtensionService);
  try {
    await host.$deltaExtensions([extension], []);
    await host.$activateByEvent('test');
    if (!api || !context || failure) {
      throw new Error(failure ?? 'The test extension did not activate.');
    }
    return { api, context, ...pair, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
