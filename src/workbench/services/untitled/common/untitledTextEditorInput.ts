import type { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import type { UntitledTextEditorModel } from './untitledTextEditorModel.js';

/** An untitled text editor, `untitled:Untitled-N`. It owns its model and disposes it with itself. */
export class UntitledTextEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.untitledEditorInput';

  constructor(readonly model: UntitledTextEditorModel) {
    super();
    this._register(model.onDidChangeDirty(() => this._onDidChangeDirty.fire()));
    // A model disposed from elsewhere takes the input with it.
    this._register(model.onWillDispose(() => this.dispose()));
  }

  override get typeId(): string {
    return UntitledTextEditorInput.ID;
  }

  override get resource(): URI {
    return this.model.resource;
  }

  override getName(): string {
    return this.model.name;
  }

  override isDirty(): boolean {
    return this.model.isDirty();
  }

  override async resolve(): Promise<UntitledTextEditorModel> {
    await this.model.resolve();
    return this.model;
  }

  override matches(other: EditorInput): boolean {
    return other === this
      || (other instanceof UntitledTextEditorInput && other.resource.toString() === this.resource.toString());
  }

  override dispose(): void {
    super.dispose();
    this.model.dispose();
  }
}
