import type { URI } from '../../../base/common/uri.js';
import type { IReference, IResolvedTextEditorModel } from '../../../editor/common/services/resolverService.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../browser/editor.js';
import { TextEditorPane } from '../../browser/parts/editor/textEditor.js';
import { EditorInput } from '../../common/editor/editorInput.js';
import { onDidChangeResourceLabel, resourceDisplayName, resourceLabelDescription, resourceLabelTitle } from '../../services/label/common/resourceLabels.js';

export class DocumentContentEditorInput extends EditorInput {
  static readonly ID = 'workbench.input.extensionDocument';

  constructor(readonly resource: URI, private readonly reference: IReference<IResolvedTextEditorModel>) {
    super();
    this._register(reference);
    this._register(onDidChangeResourceLabel(resource)(() => this._onDidChangeLabel.fire()));
  }

  get typeId(): string { return DocumentContentEditorInput.ID; }
  override getName(): string { return resourceDisplayName(this.resource); }
  override getDescription(): string | undefined { return resourceLabelDescription(this.resource) ?? super.getDescription(); }
  override getTitle(): string { return resourceLabelTitle(this.resource) ?? super.getTitle(); }
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
