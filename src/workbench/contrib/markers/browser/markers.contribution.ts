import { Disposable } from '../../../../base/common/lifecycle.js';
import '../../../../platform/markers/common/markerService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { MarkersModelBridge, MonacoModelMarkerSink } from './markersModelBridge.js';
import { FOCUS_PROBLEMS_COMMAND, ProblemsStatus } from './markersStatus.js';
import {
  MARKERS_CONTAINER_ID, MARKERS_VIEW_ID, focusMarkersView, markersViewDescriptor, provideMarkersViewServices,
} from './markersView.js';

class MarkersModelBridgeContribution extends MarkersModelBridge {
  constructor(@IMarkerService markers: IMarkerService, @IModelService models: IModelService) {
    super(new MonacoModelMarkerSink(), markers, models);
  }
}

class MarkersViewContribution extends Disposable {
  constructor(@IMarkerService markers: IMarkerService, @IEditorService editors: IEditorService) {
    super();
    this._register(provideMarkersViewServices({ markers, editors }));
  }
}

class ProblemsStatusContribution extends ProblemsStatus {
  constructor(@IMarkerService markers: IMarkerService, @IStatusbarService statusbar: IStatusbarService) {
    super(markers, statusbar);
  }
}

// Swap the placeholder for the list at import time: the panel restores its views before contributions start.
{
  const container = viewContainersRegistry.registerViewContainer(
    { id: MARKERS_CONTAINER_ID, title: 'Problems' }, ViewContainerLocation.Panel);
  const placeholder = viewsRegistry.getViews(container).filter(view => view.id === MARKERS_VIEW_ID);
  viewsRegistry.deregisterViews(placeholder, container);
  viewsRegistry.registerViews([markersViewDescriptor], container);
}

registerWorkbenchContribution2('workbench.contrib.markersModelBridge', MarkersModelBridgeContribution);
registerWorkbenchContribution2('workbench.contrib.markersView', MarkersViewContribution);
registerWorkbenchContribution2('workbench.contrib.problemsStatus', ProblemsStatusContribution);

registerAction2(class FocusProblems extends Action2 {
  constructor() {
    super({ id: FOCUS_PROBLEMS_COMMAND, title: 'Focus Problems (Errors, Warnings, Infos)', category: 'View', f1: true });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IViewsService).openView(MARKERS_VIEW_ID, true);
    focusMarkersView();
  }
});
