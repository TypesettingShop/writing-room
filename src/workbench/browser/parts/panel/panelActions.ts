import { PanelVisibleContext } from '../../../common/contextkeys.js';
import { Parts } from '../../../services/layout/browser/layoutService.js';
import { registerTogglePartAction } from '../../actions/layoutActions.js';

registerTogglePartAction(
  'workbench.action.togglePanel', Parts.PANEL_PART,
  'Toggle Panel Visibility', 'Panel', PanelVisibleContext, 3, 'ctrl+j',
);
