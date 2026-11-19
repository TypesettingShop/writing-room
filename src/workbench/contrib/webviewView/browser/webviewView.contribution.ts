import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { registerExtensionViewBody } from '../../../api/browser/viewsExtensionPoint.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IWebviewViewService } from './webviewViewService.js';
import type { WebviewViewPane } from './webviewViewPane.js';

const workbenches = new WeakMap<HTMLElement, IWebviewViewService>();

class WebviewViewContribution extends Disposable {
  constructor(@IWorkbenchLayoutService layout: IWorkbenchLayoutService, @IWebviewViewService views: IWebviewViewService) {
    super();
    workbenches.set(layout.mainContainer, views);
    this._register(toDisposable(() => workbenches.delete(layout.mainContainer)));
  }
}

registerWorkbenchContribution2('workbench.webviewView', WebviewViewContribution);

registerExtensionViewBody('webview', ({ parent, viewId, extension }) => {
  let pane: WebviewViewPane | undefined;
  let size: { height: number; width: number } | undefined;
  let disposed = false;
  // A restored container can create its body during workbench startup, before contributions run.
  queueMicrotask(() => {
    const root = parent.closest<HTMLElement>('.workbench');
    if (!disposed && root) {
      pane = workbenches.get(root)?.mount(parent, viewId, extension.identifier.value);
      if (size) {
        pane?.layoutBody(size.height, size.width);
      }
    }
  });
  return {
    layoutBody(height, width) {
      size = { height, width };
      pane?.layoutBody(height, width);
    },
    dispose() {
      disposed = true;
      pane?.dispose();
    },
  };
});
