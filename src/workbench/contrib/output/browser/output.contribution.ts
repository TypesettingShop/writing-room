import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewContext } from '../../../common/contextkeys.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import type { IViewDescriptor } from '../../../common/views.js';
import { IOutputService, OUTPUT_VIEW_ID } from '../../../services/output/common/output.js';
import './outputServices.js';
import { OutputView } from './outputView.js';

/**
 * Puts the Output view in place of the placeholder, under the same container and view id, so a saved
 * layout (the panel's active container, a container moved to the side bar) still holds. The workbench
 * starts contributions in the task that creates its parts, so the placeholder is never painted.
 */
export class OutputViewContribution {
  static readonly ID = 'workbench.contrib.outputView';

  constructor(@IInstantiationService instantiation: IInstantiationService) {
    const container = viewContainersRegistry.get(OUTPUT_VIEW_ID);
    if (!container) {
      return;
    }
    const placeholder = viewsRegistry.getViews(container).find(view => view.id === OUTPUT_VIEW_ID);
    if (placeholder) {
      viewsRegistry.deregisterViews([placeholder], container);
    }
    const view: IViewDescriptor = {
      id: OUTPUT_VIEW_ID,
      name: 'Output',
      renderBody: parent => instantiation.createInstance(OutputView, parent),
    };
    viewsRegistry.registerViews([view], container);
  }
}

registerWorkbenchContribution2(OutputViewContribution.ID, OutputViewContribution);

registerAction2(class ClearOutputAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.output.action.clearOutput',
      title: 'Clear Output',
      category: 'View',
      icon: { id: 'clear-all' },
      f1: true,
      menu: { id: MenuId.ViewTitle, when: ViewContext.isEqualTo(OUTPUT_VIEW_ID), group: 'navigation', order: 2 },
    });
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IOutputService).getActiveChannel()?.clear();
  }
});
