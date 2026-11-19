import { Event } from '../../../../../base/common/event.js';
import { basename, dirname, isEqual, relativePath } from '../../../../../base/common/resources.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../../../platform/editor/common/editor.js';
import type { IReference, IResolvedTextEditorModel, ITextEditorModel } from '../../../../../editor/common/services/resolverService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { GroupIdentifier } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import type { IEditorCloseHandler, IRevertOptions, ISaveOptions } from '../../../../common/editor/editorInput.js';
import { IFileDialogService } from '../../../../services/dialogs/common/dialogs.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';

export const FILE_EDITOR_INPUT_ID = 'workbench.editors.files.fileEditorInput';

export interface IFileEditorInputOptions {
  /** Restored with a draft: dirty until its model says otherwise. */
  readonly restoredDirty?: boolean;
}

/**
 * A file in the text editor. Its text is the file's `TextFileEditorModel`, which the input holds a
 * text model reference to while it lives: two inputs of one file share one model, and the model goes
 * once the last reference does and it is clean.
 */
export class FileEditorInput extends EditorInput {
  static readonly ID = FILE_EDITOR_INPUT_ID;

  private reference: Promise<IReference<IResolvedTextEditorModel>> | undefined;
  private restoredDirty: boolean;

  /** A dirty file asks Save, Don't Save or Cancel before its last tab closes. */
  override readonly closeHandler: IEditorCloseHandler;

  constructor(
    private readonly target: URI,
    options: IFileEditorInputOptions = {},
    @ITextFileService private readonly textFileService: ITextFileService,
    @ITextModelService private readonly textModelService: ITextModelService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IFileDialogService fileDialogService: IFileDialogService,
  ) {
    super();
    this.closeHandler = {
      showConfirm: () => this.isDirty(),
      confirm: editors => fileDialogService.showSaveConfirm(editors.map(({ editor }) => editor.getName())),
    };
    this.restoredDirty = options.restoredDirty ?? false;
    const files = textFileService.files;
    const mine = <T extends { readonly resource: URI }>(event: Event<T>) => Event.filter(event, model => isEqual(model.resource, this.target));
    this._register(mine(files.onDidChangeDirty)(() => this._onDidChangeDirty.fire()));
    this._register(Event.any(mine(files.onDidChangeOrphaned), mine(files.onDidChangeReadonly))(() => this._onDidChangeLabel.fire()));
  }

  override get typeId(): string {
    return FileEditorInput.ID;
  }

  override get resource(): URI {
    return this.target;
  }

  override getName(): string {
    return basename(this.target) || this.target.toString();
  }

  /** The folder: relative to the workspace folder, which is named for a file at its top. */
  override getDescription(): string {
    const parent = dirname(this.target);
    const folder = this.workspace.getWorkspaceFolder(this.target);
    if (folder) {
      const relative = relativePath(folder.uri, parent);
      return relative ? relative : folder.name;
    }
    return parent.toString(true);
  }

  /** The whole path, and whether the file is gone or read-only. */
  override getTitle(): string {
    const folder = this.workspace.getWorkspaceFolder(this.target);
    const relative = folder && relativePath(folder.uri, this.target);
    const label = folder && relative ? `${folder.name}/${relative}` : this.target.toString(true);
    const model = this.textFileService.files.get(this.target);
    const marks = [model?.isOrphaned() ? 'deleted' : undefined, model?.isReadonly() ? 'read-only' : undefined].filter(Boolean);
    return marks.length ? `${label} (${marks.join(', ')})` : label;
  }

  override isDirty(): boolean {
    const model = this.textFileService.files.get(this.target);
    return model?.isResolved() ? model.isDirty() : this.restoredDirty;
  }

  override isReadonly(): boolean {
    return this.textFileService.files.get(this.target)?.isReadonly() ?? false;
  }

  /**
   * The file's model, through a text model reference this input holds until it is disposed. It
   * rejects, and keeps nothing, when the file cannot be read as text (`TextFileOperationError`).
   */
  override resolve(): Promise<ITextEditorModel> {
    if (this.isDisposed()) {
      return Promise.reject(new Error(`${this.target} is closed.`));
    }
    const reference = this.reference ??= this.textModelService.createModelReference(this.target);
    return reference.then(({ object }) => {
      this.settleRestoredDirty();
      return this.textFileService.files.get(this.target) ?? object;
    }, error => {
      if (this.reference === reference) {
        this.reference = undefined;
      }
      this.settleRestoredDirty();
      throw error;
    });
  }

  /** The model knows from now on. */
  private settleRestoredDirty(): void {
    if (this.restoredDirty) {
      this.restoredDirty = false;
      this._onDidChangeDirty.fire();
    }
  }

  override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | undefined> {
    await this.resolveForChange();
    return await this.textFileService.save(this.target, options) ? this : undefined;
  }

  /** Saves the text to a file the user picks; the result names that file, which opens in this editor's place. */
  override async saveAs(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IResourceEditorInput | undefined> {
    await this.resolveForChange();
    const target = await this.textFileService.saveAs(this.target, undefined, options);
    return target ? { resource: target } : undefined;
  }

  override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
    await this.resolveForChange();
    await this.textFileService.revert(this.target, options);
  }

  /**
   * A tab restored with a draft has no model until it is shown; saving or reverting it acts on the
   * draft, so the model is read first. A file that cannot be read has nothing to save or revert.
   */
  private async resolveForChange(): Promise<void> {
    if (!this.isDisposed() && !this.textFileService.files.get(this.target)?.isResolved()) {
      await this.resolve().catch(() => undefined);
    }
  }

  override matches(other: EditorInput): boolean {
    return other === this || (other instanceof FileEditorInput && isEqual(other.resource, this.target));
  }

  override dispose(): void {
    const reference = this.reference;
    this.reference = undefined;
    super.dispose();
    // The model goes with the last reference, once it is clean.
    void reference?.then(held => held.dispose(), () => {});
  }
}
