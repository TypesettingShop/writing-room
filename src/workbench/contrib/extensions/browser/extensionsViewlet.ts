import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ExtensionGalleryService, IExtensionGalleryService } from '../../../../platform/extensionManagement/common/extensionGalleryService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { product } from '../../../../platform/product/common/product.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import type { IViewBody } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { ExtensionsSearchView, InstalledExtensionsView } from './extensionsViews.js';
import { ExtensionsWorkbenchService, IExtensionsWorkbenchService } from './extensionsWorkbenchService.js';

const containerId = 'workbench.view.extensions';
const searchId = containerId + '.search';

registerSingleton(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService, [product.extensionsGallery]));
registerSingleton(IExtensionsWorkbenchService, ExtensionsWorkbenchService);

type ViewConstructor = new (parent: HTMLElement, service: ExtensionsWorkbenchService) => Disposable;
let instantiation: IInstantiationService | undefined;
const waitingBodies = new Set<() => void>();

// Layout restoration looks up the registered container before contributions start. A body restored that
// early waits for this workbench's services, just as the Explorer body does.
function renderBody(parent: HTMLElement, constructor: ViewConstructor): IViewBody {
  let view: Disposable | undefined;
  const create = () => {
    waitingBodies.delete(create);
    view = instantiation!.createInstance(constructor, parent);
  };
  if (instantiation) {
    create();
  } else {
    waitingBodies.add(create);
  }
  return {
    dispose() {
      waitingBodies.delete(create);
      view?.dispose();
    },
  };
}

const container = viewContainersRegistry.registerViewContainer({
  id: containerId, title: 'Extensions', icon: '$(extensions)',
}, ViewContainerLocation.Sidebar);
viewsRegistry.registerViews([
  { id: searchId, name: 'Search Extensions', renderBody: parent => renderBody(parent, ExtensionsSearchView) },
  { id: containerId + '.installed', name: 'Installed', renderBody: parent => renderBody(parent, InstalledExtensionsView) },
], container);

class ExtensionsViewlet extends Disposable {
  constructor(@IInstantiationService service: IInstantiationService) {
    super();
    instantiation = service;
    this._register(toDisposable(() => {
      if (instantiation === service) {
        instantiation = undefined;
      }
    }));
    for (const create of [...waitingBodies]) {
      create();
    }
  }
}

registerWorkbenchContribution2('workbench.contrib.extensionsViewlet', ExtensionsViewlet);

registerAction2(class ShowExtensions extends Action2 {
  constructor() {
    super({
      id: containerId, title: 'Show Extensions', category: 'View', f1: true,
      keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyX, weight: KeybindingWeight.WorkbenchContrib },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const pane = await accessor.get(IViewsService).openView(searchId, true);
    pane?.element.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
  }
});
