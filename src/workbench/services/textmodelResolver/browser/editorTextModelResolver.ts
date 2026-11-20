import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { loadMonaco } from '../../../../editor/browser/monaco.js';
import { setEditorTextModelResolver } from '../../../../editor/browser/textModelServiceHook.js';
import type { EditorModelReference, EditorTextModelResolver } from '../../../../editor/browser/textModelServiceHook.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';

export interface EditorTextModelResolverServices {
  readonly resolver: ITextModelService;
  /** Whether F12 (the editor opener) would open the resource: a file system provider, or an open model. */
  readonly canOpen: (resource: URI) => boolean;
  /** The editor package's model of a workbench model, by its URI; `null` when it has none. */
  readonly monacoModel: (resource: URI) => Promise<unknown>;
}

/**
 * The workbench's text model service as the editor package asks for it (the Ctrl+hover definition
 * preview, the references peek): a resource in the range F12 opens, which the workbench resolver
 * handles, comes from that resolver under its reference, so an unopened workspace file is read. The
 * reference is the resolver's, with its counting: the model stays while a tab or a draft holds it, and
 * goes when the last reference does.
 */
export function createEditorTextModelResolver(services: EditorTextModelResolverServices): EditorTextModelResolver {
  const parse = (resource: string): URI | undefined => {
    try {
      return URI.parse(resource, true);
    } catch {
      return undefined;
    }
  };
  return {
    canResolve: resource => {
      const uri = parse(resource);
      return !!uri && services.canOpen(uri) && services.resolver.canHandleResource(uri);
    },
    resolve: async (resource): Promise<EditorModelReference> => {
      const uri = parse(resource);
      if (!uri) {
        throw new Error('Model not found');
      }
      const reference = await services.resolver.createModelReference(uri);
      try {
        const model = await services.monacoModel(URI.parse(reference.object.textEditorModel.uri.toString(), true));
        if (!model) {
          throw new Error('Model not found');
        }
        return { model, dispose: () => reference.dispose() };
      } catch (error) {
        reference.dispose();
        throw error;
      }
    },
  };
}

/** Lends the editor package the workbench's resolver from the start of the workbench. */
export class EditorTextModelResolverContribution extends Disposable {
  static readonly ID = 'workbench.contrib.editorTextModelResolver';

  constructor(
    @ITextModelService resolver: ITextModelService,
    @IFileService files: IFileService,
    @IModelService models: IModelService,
  ) {
    super();
    this._register(setEditorTextModelResolver(createEditorTextModelResolver({
      resolver,
      // The same test as the editor opener's (`EditorOpenerContribution`): no wider than F12.
      canOpen: resource => files.hasProvider(resource) || !!models.getModel(resource),
      monacoModel: async resource => {
        const monaco = await loadMonaco();
        return monaco.editor.getModel(monaco.Uri.parse(resource.toString()));
      },
    })));
  }
}

registerWorkbenchContribution2(EditorTextModelResolverContribution.ID, EditorTextModelResolverContribution);
