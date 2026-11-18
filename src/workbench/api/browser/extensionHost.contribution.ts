import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';

registerAction2(class extends Action2 {
  constructor() {
    super({ id: 'workbench.action.restartExtensionHost', title: 'Restart Extension Host', f1: true });
  }

  run(accessor: ServicesAccessor): Promise<void> | undefined {
    return accessor.get(IExtensionService).restartExtensionHost?.();
  }
});
