import { isEqual } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import type { GroupIdentifier } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import type { IEditorCloseHandler, ISaveOptions } from '../../../common/editor/editorInput.js';
import { IFileDialogService } from '../../dialogs/common/dialogs.js';
import { ITextFileService } from '../../textfile/common/textfiles.js';
import type { UntitledTextEditorModel } from './untitledTextEditorModel.js';

/**
 * An untitled text editor, `untitled:Untitled-N`. It owns its model and disposes it with itself.
 *
 * Made through the instantiation service, it saves (asking where, through the text file service) and
 * asks before it closes with text in it. Made with `new` and only a model, as some tests do, it does
 * neither.
 */
export class UntitledTextEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.untitledEditorInput';

  override readonly closeHandler: IEditorCloseHandler | undefined = undefined;

  constructor(
    readonly model: UntitledTextEditorModel,
    @ITextFileService private readonly textFileService?: ITextFileService,
    @IFileDialogService fileDialogService?: IFileDialogService,
  ) {
    super();
    this._register(model.onDidChangeDirty(() => this._onDidChangeDirty.fire()));
    // A model disposed from elsewhere takes the input with it.
    this._register(model.onWillDispose(() => this.dispose()));
    if (fileDialogService) {
      this.closeHandler = {
        // Untitled text is dirty while it has any text.
        showConfirm: () => this.isDirty(),
        confirm: editors => fileDialogService.showSaveConfirm(editors.map(({ editor }) => editor.getName())),
      };
    }
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

  /** Untitled text has no place yet: saving it is Save As. */
  override save(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IResourceEditorInput | undefined> {
    return this.saveAs(group, options);
  }

  /**
   * Asks where to save the text and writes it there. The result names the file, which the editor
   * service opens in this editor's place.
   */
  override async saveAs(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IResourceEditorInput | undefined> {
    if (!this.textFileService || this.isDisposed()) {
      return undefined;
    }
    const target = await this.textFileService.saveAs(this.resource, undefined, { reason: options?.reason });
    return target ? { resource: target } : undefined;
  }

  override async resolve(): Promise<UntitledTextEditorModel> {
    await this.model.resolve();
    return this.model;
  }

  override matches(other: EditorInput): boolean {
    return other === this || (other instanceof UntitledTextEditorInput && isEqual(other.resource, this.resource));
  }

  override dispose(): void {
    super.dispose();
    this.model.dispose();
  }
}
