import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { HostExtensionDescription } from './extensionHostProtocol.js';
import type { RPCProtocol } from './rpcProtocol.js';

export interface ExtensionCustomerServices {
  readonly rpc: RPCProtocol;
  readonly instantiation: IInstantiationService;
  getExtension(key: string): HostExtensionDescription | undefined;
  commandOwner(id: string): string | undefined;
  activate(event: string, origin: string): Promise<void>;
}

export interface ExtHostCustomer extends Partial<IDisposable> {
  remove?(key: string): void;
}

export class ExtHostCustomers<T extends ExtensionCustomerServices = ExtensionCustomerServices> {
  private readonly factories = new Map<string, (services: T) => ExtHostCustomer>();

  register(area: string, factory: (services: T) => ExtHostCustomer): IDisposable {
    if (this.factories.has(area)) {
      throw new Error(`Extension customer '${area}' already exists.`);
    }
    this.factories.set(area, factory);
    return toDisposable(() => {
      if (this.factories.get(area) === factory) {
        this.factories.delete(area);
      }
    });
  }

  create(services: T): readonly ExtHostCustomer[] {
    const customers: ExtHostCustomer[] = [];
    try {
      for (const factory of this.factories.values()) {
        customers.push(factory(services));
      }
      return customers;
    } catch (error) {
      runCustomerCleanup(customers, customer => customer.dispose?.());
      throw error;
    }
  }
}

export function runCustomerCleanup(customers: readonly ExtHostCustomer[], cleanup: (customer: ExtHostCustomer) => void): void {
  for (const customer of customers) {
    try {
      cleanup(customer);
    } catch (error) {
      console.error('Extension customer cleanup failed:', error);
    }
  }
}
