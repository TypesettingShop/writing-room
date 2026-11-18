import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { scanBuiltinExtensions } from '../../extensionManagement/browser/builtinExtensionsScannerService.js';
import { IWorkbenchLayoutService, Parts } from '../../layout/browser/layoutService.js';
import { IExtensionService } from '../common/extensions.js';
import { ExtensionService } from './extensionService.js';
import './extensions.css';

registerSingleton(IExtensionService, new SyncDescriptor(ExtensionService, [scanBuiltinExtensions]));

class EditorTitleContributions extends Disposable {
  constructor(
    @IWorkbenchLayoutService layout: IWorkbenchLayoutService,
    @IContextKeyService context: IContextKeyService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
    const editor = layout.getContainer(Parts.EDITOR_PART);
    const title = editor.ownerDocument.createElement('div');
    title.className = 'extension-editor-title-actions';
    editor.append(title);
    this._register(toDisposable(() => title.remove()));
    this._register(instantiation.createInstance(MenuWorkbenchToolBar, title, MenuId.EditorTitle, context));
    const update = () => { title.hidden = MenuRegistry.getMenuItems(MenuId.EditorTitle).length === 0; };
    this._register(MenuRegistry.onDidChangeMenu(event => { if (event.has(MenuId.EditorTitle)) { update(); } }));
    update();
  }
}

registerWorkbenchContribution2('workbench.extensions.editorTitle', EditorTitleContributions);
