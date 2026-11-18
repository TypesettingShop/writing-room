import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import type { ViewContainer } from '../../../common/views.js';

function registerPlaceholder(container: ViewContainer, location: ViewContainerLocation, id: string, name: string, message: string): void {
  const registered = viewContainersRegistry.registerViewContainer(container, location);
  viewsRegistry.registerViews([{
    id,
    name,
    renderBody(parent) {
      const placeholder = parent.ownerDocument.createElement('p');
      placeholder.className = 'view-placeholder';
      placeholder.textContent = message;
      parent.append(placeholder);
    },
  }], registered);
}

registerPlaceholder({ id: 'workbench.view.explorer', title: 'Explorer', icon: '$(files)' },
  ViewContainerLocation.Sidebar, 'workbench.explorer.emptyView', 'Files', 'No folder opened');
registerPlaceholder({ id: 'workbench.panel.output', title: 'Output' },
  ViewContainerLocation.Panel, 'workbench.panel.output', 'Output', 'No output yet');
registerPlaceholder({ id: 'workbench.panel.markers', title: 'Problems' },
  ViewContainerLocation.Panel, 'workbench.panel.markers.view', 'Problems', 'No problems detected');
