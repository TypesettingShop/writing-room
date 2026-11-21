import { Disposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import type { IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { isTextFileResource } from '../../../services/textfile/common/textfiles.js';
import { MarkdownEditorInput, MarkdownEditorInputSerializer } from './markdownEditorInput.js';
import { MarkdownEditorPane } from './markdownEditorPane.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(MarkdownEditorPane, MarkdownEditorPane.ID, 'Markdown Editor'), [MarkdownEditorInput.ID],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!
  .registerEditorSerializer(MarkdownEditorInput.ID, MarkdownEditorInputSerializer);

class MarkdownEditorResolver extends Disposable {
  constructor(
    @IEditorResolverService resolver: IEditorResolverService,
    @IFileService fileService: IFileService,
    @IEditorGroupsService groups: IEditorGroupsService,
    @IInstantiationService instantiationService: IInstantiationService,
  ) {
    super();
    for (const glob of ['*.md', '*.markdown']) {
      this._register(resolver.registerEditor(
        glob,
        { id: MarkdownEditorInput.ID, label: 'Markdown Editor', priority: RegisteredEditorPriority.default },
        { canSupportResource: resource => isTextFileResource(resource, fileService) },
        ({ resource, options }) => {
          const existing = groups.groups.flatMap(group => group.editors)
            .find(editor => editor instanceof MarkdownEditorInput && isEqual(editor.resource, resource));
          return { editor: existing ?? instantiationService.createInstance(MarkdownEditorInput, resource, {}), options };
        },
      ));
    }
  }
}

registerWorkbenchContribution2('workbench.contrib.markdownEditor', MarkdownEditorResolver);
