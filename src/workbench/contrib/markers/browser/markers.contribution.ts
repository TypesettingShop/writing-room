import '../../../../platform/markers/common/markerService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { MarkersModelBridge, MonacoModelMarkerSink } from './markersModelBridge.js';

class MarkersModelBridgeContribution extends MarkersModelBridge {
  constructor(@IMarkerService markers: IMarkerService, @IModelService models: IModelService) {
    super(new MonacoModelMarkerSink(), markers, models);
  }
}

registerWorkbenchContribution2('workbench.contrib.markersModelBridge', MarkersModelBridgeContribution);
