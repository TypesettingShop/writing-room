import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import type { IViewBody, IViewDescriptor } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EXPLORER_VIEW_ID, EXPLORER_VIEWLET_ID } from './explorerActions.js';
import { IExplorerService } from './explorerService.js';
import { ExplorerView } from './views/explorerView.js';

/** The v0.1.0 placeholder this view takes the place of. */
const EMPTY_VIEW_ID = 'workbench.explorer.emptyView';
/**
 * The view's name is the workspace folder's, as VS Code titles it with the workspace label. The
 * workspace is the one browser-storage folder `vscode-vfs://writing-room/workspace`; the name is
 * needed when the module loads, before any service exists, as the sidebar draws the view first.
 */
export const EXPLORER_VIEW_NAME = 'workspace';

/**
 * The workbench's instantiation service, once the Explorer contribution has started. The view
 * registry gives a view body only its element, and the sidebar draws its views before the workbench
 * contributions start, so a body drawn before then waits here for the services.
 */
let instantiationService: IInstantiationService | undefined;
const waitingBodies = new Set<() => void>();

function renderExplorerView(parent: HTMLElement): IViewBody {
  let view: ExplorerView | undefined;
  let size: [number, number] | undefined;
  const create = () => {
    waitingBodies.delete(create);
    view = instantiationService!.createInstance(ExplorerView, parent);
    if (size) {
      view.layoutBody(size[0]);
    }
  };
  if (instantiationService) {
    create();
  } else {
    waitingBodies.add(create);
  }
  return {
    layoutBody(height: number, width: number) {
      size = [height, width];
      view?.layoutBody(height);
    },
    dispose() {
      waitingBodies.delete(create);
      view?.dispose();
      view = undefined;
    },
  };
}

const fileView: IViewDescriptor = { id: EXPLORER_VIEW_ID, name: EXPLORER_VIEW_NAME, renderBody: renderExplorerView };

// The file view takes the placeholder's place in the same container, so saved placements stay valid.
// It is registered before the placeholder goes, so the container is never empty in between.
const explorerContainer = viewContainersRegistry.get(EXPLORER_VIEWLET_ID);
if (explorerContainer) {
  viewsRegistry.registerViews([fileView], explorerContainer);
  const placeholder = viewsRegistry.getViews(explorerContainer).filter(view => view.id === EMPTY_VIEW_ID);
  viewsRegistry.deregisterViews(placeholder, explorerContainer);
}

/**
 * Gives the Explorer view its services and keeps the tree's selection on the active editor's file,
 * as VS Code's `explorer.autoReveal` does by default.
 */
export class ExplorerViewletContribution extends Disposable {
  static readonly ID = 'workbench.contrib.explorerViewlet';

  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @IExplorerService explorer: IExplorerService,
    @IEditorService editorService: IEditorService,
  ) {
    super();
    instantiationService = instantiation;
    this._register(toDisposable(() => {
      if (instantiationService === instantiation) {
        instantiationService = undefined;
      }
    }));
    for (const create of [...waitingBodies]) {
      create();
    }

    const followActiveEditor = () => {
      const resource = editorService.activeEditor?.resource;
      if (resource && !explorer.editable) {
        void explorer.select(resource).catch(console.error);
      }
    };
    this._register(editorService.onDidActiveEditorChange(followActiveEditor));
    followActiveEditor();
  }
}
