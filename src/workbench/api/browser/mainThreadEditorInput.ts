import { basename } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import type { IReference, IResolvedTextEditorModel } from '../../../editor/common/services/resolverService.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../browser/editor.js';
import { TextEditorPane } from '../../browser/parts/editor/textEditor.js';
import { EditorInput } from '../../common/editor/editorInput.js';

export class DocumentContentEditorInput extends EditorInput {
  static readonly ID = 'workbench.input.extensionDocument';

  constructor(readonly resource: URI, private readonly reference: IReference<IResolvedTextEditorModel>) {
    super();
    this._register(reference);
  }

  get typeId(): string { return DocumentContentEditorInput.ID; }
  override getName(): string { return basename(this.resource) || this.resource.toString(); }
  override isReadonly(): boolean { return true; }
  override async resolve(): Promise<IResolvedTextEditorModel> { return this.reference.object; }
  override matches(other: EditorInput): boolean {
    return other.typeId === this.typeId && other.resource?.toString() === this.resource.toString();
  }
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(TextEditorPane, TextEditorPane.ID, 'Text Editor'),
  [DocumentContentEditorInput.ID],
);
