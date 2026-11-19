import './extensionHost.contribution.js';
import type { ExtensionTreeViews } from './mainThreadTreeViews.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { runCustomerCleanup } from '../../services/extensions/common/extHostCustomers.js';
import type { ExtensionCustomerServices, ExtHostCustomer } from '../../services/extensions/common/extHostCustomers.js';
import type { ExtensionHostStatus } from '../../services/extensions/common/extensionHostProtocol.js';
import type { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';
import { MainContext } from '../common/extHost.protocol.js';
import type { MainThreadExtensionServiceShape } from '../common/extHost.protocol.js';

export interface MainThreadExtensionAccess extends Omit<ExtensionCustomerServices, 'rpc' | 'instantiation'> {
  setStatus(key: string, status: ExtensionHostStatus): void;
}

export class MainThreadExtensionService extends Disposable implements MainThreadExtensionServiceShape {
  private readonly customers: readonly ExtHostCustomer[];

  constructor(
    rpc: RPCProtocol,
    private readonly host: MainThreadExtensionAccess,
    treeViews: ExtensionTreeViews,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
    this.customers = mainThreadCustomers.create({ ...host, rpc, instantiation, treeViews });
    this._register(toDisposable(() => runCustomerCleanup(this.customers, customer => customer.dispose?.())));
    rpc.set(MainContext.MainThreadExtensionService, this);
  }

  async $setActivationStatus(extension: string, status: ExtensionHostStatus): Promise<void> {
    this.host.setStatus(extension, status);
  }

  remove(extension: string): void {
    runCustomerCleanup(this.customers, customer => customer.remove?.(extension));
  }
}
