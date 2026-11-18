import { Disposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { ExtensionHostStatus } from '../../services/extensions/common/extensionHostProtocol.js';
import type { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';
import { ExtHostContext, MainContext } from '../common/extHost.protocol.js';
import type { MainThreadExtensionServiceShape } from '../common/extHost.protocol.js';
import { MainThreadCommands } from './mainThreadCommands.js';
import type { CommandHostAccess } from './mainThreadCommands.js';

export interface MainThreadExtensionAccess extends CommandHostAccess {
  setStatus(key: string, status: ExtensionHostStatus): void;
}

export class MainThreadExtensionService extends Disposable implements MainThreadExtensionServiceShape {
  private readonly commands: MainThreadCommands;

  constructor(
    rpc: RPCProtocol,
    private readonly host: MainThreadExtensionAccess,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
    this.commands = this._register(new MainThreadCommands(rpc.getProxy(ExtHostContext.ExtHostCommands), host, instantiation));
    rpc.set(MainContext.MainThreadCommands, this.commands);
    rpc.set(MainContext.MainThreadExtensionService, this);
  }

  async $setActivationStatus(extension: string, status: ExtensionHostStatus): Promise<void> {
    this.host.setStatus(extension, status);
  }

  remove(extension: string): void {
    this.commands.remove(extension);
  }
}
