import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../browser/editor.js';
import type { IEditorFactoryRegistry } from '../../../common/editor.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { WebviewEditor } from './webviewEditor.js';
import { WebviewEditorInput } from './webviewEditorInput.js';
import { WebviewEditorInputSerializer } from './webviewEditorInputSerializer.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)?.registerEditorPane(
  EditorPaneDescriptor.create(WebviewEditor, WebviewEditor.id, 'Webview'), [WebviewEditorInput.typeId],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)?.registerEditorSerializer(
  WebviewEditorInput.typeId, WebviewEditorInputSerializer,
);

const activeWebviewPanelId = new RawContextKey<string | undefined>('activeWebviewPanelId', undefined);

class WebviewPanelContext extends Disposable {
  constructor(@IEditorGroupsService groups: IEditorGroupsService, @IContextKeyService context: IContextKeyService) {
    super();
    const id = activeWebviewPanelId.bindTo(context);
    const update = () => {
      const input = groups.activeGroup.activeEditor;
      id.set(input instanceof WebviewEditorInput ? input.viewType : undefined);
    };
    this._register(groups.onDidActiveEditorChange(update));
    update();
  }
}

registerWorkbenchContribution2('workbench.webviewPanel.context', WebviewPanelContext);
