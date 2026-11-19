import './extHost.contribution.js';
import { createExtensionApi } from './extHost.api.impl.js';
import { ExtHostContext, MainContext } from './extHost.protocol.js';
import type { ExtHostExtensionServiceShape } from './extHost.protocol.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import type { ExtHostApiContribution } from './extHostApiRegistry.js';
import { ExtensionsActivator } from './extHostExtensionActivator.js';
import type { ExtensionLoader } from './extHostExtensionActivator.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';

export class ExtHostExtensionService implements ExtHostExtensionServiceShape {
  private readonly activator: ExtensionsActivator;
  private readonly contributions: ReadonlyMap<string, ExtHostApiContribution>;

  constructor(rpc: RPCProtocol, load: ExtensionLoader) {
    this.contributions = extHostApiRegistry.create({
      rpc,
      isLive: key => this.activator.isLive(key),
      getViews: key => this.activator.getViews(key),
      resolveCommandArgument: (key, argument) => {
        let result = argument;
        for (const contribution of this.contributions.values()) {
          if (contribution.convertCommandArgument) {
            result = contribution.convertCommandArgument(key, result);
          }
        }
        return result;
      },
    });
    this.activator = new ExtensionsActivator(
      rpc.getProxy(MainContext.MainThreadExtensionService),
      load,
      (description, isLive, context) => createExtensionApi(this.contributions, description, isLive, context),
      async key => {
        for (const contribution of this.contributions.values()) {
          await contribution.flush?.(key);
        }
      },
      key => this.runCleanup(contribution => contribution.release?.(key)),
    );
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
    this.runCleanup(contribution => contribution.dispose?.());
  }

  private runCleanup(cleanup: (contribution: ExtHostApiContribution) => void): void {
    for (const [area, contribution] of this.contributions) {
      try {
        cleanup(contribution);
      } catch (error) {
        console.error(`[${area}] Extension API cleanup failed:`, error);
      }
    }
  }
}
