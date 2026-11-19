import { ExtHostCustomers } from '../../services/extensions/common/extHostCustomers.js';
import type { ExtensionCustomerServices } from '../../services/extensions/common/extHostCustomers.js';
import type { ExtensionTreeViews } from './mainThreadTreeViews.js';

interface MainThreadCustomerServices extends ExtensionCustomerServices {
  readonly treeViews: ExtensionTreeViews;
}

export const mainThreadCustomers = new ExtHostCustomers<MainThreadCustomerServices>();
