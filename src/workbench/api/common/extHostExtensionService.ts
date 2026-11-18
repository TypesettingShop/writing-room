import { createApiFactory } from './extHost.api.impl.js';
import { ExtHostContext, MainContext } from './extHost.protocol.js';
import type { ExtHostExtensionServiceShape } from './extHost.protocol.js';
import { ExtHostCommands } from './extHostCommands.js';
import { ExtensionsActivator } from './extHostExtensionActivator.js';
import type { ExtensionLoader } from './extHostExtensionActivator.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';

export class ExtHostExtensionService implements ExtHostExtensionServiceShape {
  private readonly activator: ExtensionsActivator;

  constructor(rpc: RPCProtocol, load: ExtensionLoader) {
    const commands = new ExtHostCommands(rpc.getProxy(MainContext.MainThreadCommands), key => this.activator.isLive(key));
    this.activator = new ExtensionsActivator(
      rpc.getProxy(MainContext.MainThreadExtensionService),
      load,
      createApiFactory(commands),
      key => commands.flush(key),
      key => commands.remove(key),
    );
    rpc.set(ExtHostContext.ExtHostCommands, commands);
    rpc.set(ExtHostContext.ExtHostExtensionService, this);
  }

  async $activateByEvent(event: string, origin?: string): Promise<void> {
    await this.activator.activateByEvent(event, origin);
  }

  async $deltaExtensions(added: HostExtensionDescription[], removed: string[]): Promise<void> {
    this.activator.deltaExtensions(added, removed);
  }

  dispose(): void {
    this.activator.dispose();
  }
}
