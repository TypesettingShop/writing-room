import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { FileChangeType, IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITextFileBackups } from './textFileBackup.js';
import { TextFileEditorModel } from './textFileEditorModel.js';
import type { ITextFileModelHost } from './textFileEditorModel.js';
import type {
  IResolvedTextFileEditorModel, ITextFileEditorModel, ITextFileEditorModelManager, ITextFileSaveErrorHandler, ITextFileSaveEvent,
  SaveReason,
} from './textfiles.js';

/** Until the workbench sets one that asks: a conflict cancels the save, a failure is logged. */
const LOGGING_SAVE_ERROR_HANDLER: ITextFileSaveErrorHandler = {
  resolveConflict: async () => 'cancel',
  onSaveError: (error, model) => console.error(`Failed to save ${model.resource}.`, error),
};

/**
 * One `TextFileEditorModel` per resource. A model lives while it is referenced (text model
 * references come through `ITextFileService.resolve`); once released it goes as soon as it is
 * neither dirty nor saving — a dirty model is never dropped with its text.
 */
export class TextFileEditorModelManager extends Disposable implements ITextFileEditorModelManager {
  private readonly _onDidCreate = this._register(new Emitter<ITextFileEditorModel>());
  readonly onDidCreate = this._onDidCreate.event;
  private readonly _onDidResolve = this._register(new Emitter<ITextFileEditorModel>());
  readonly onDidResolve = this._onDidResolve.event;
  private readonly _onDidChangeDirty = this._register(new Emitter<ITextFileEditorModel>());
  readonly onDidChangeDirty = this._onDidChangeDirty.event;
  private readonly _onDidChangeOrphaned = this._register(new Emitter<ITextFileEditorModel>());
  readonly onDidChangeOrphaned = this._onDidChangeOrphaned.event;
  private readonly _onDidChangeReadonly = this._register(new Emitter<ITextFileEditorModel>());
  readonly onDidChangeReadonly = this._onDidChangeReadonly.event;
  private readonly _onDidSave = this._register(new Emitter<ITextFileSaveEvent & { readonly model: ITextFileEditorModel }>());
  readonly onDidSave = this._onDidSave.event;
  private readonly _onDidRevert = this._register(new Emitter<ITextFileEditorModel>());
  readonly onDidRevert = this._onDidRevert.event;
  private readonly _onDidRemove = this._register(new Emitter<URI>());
  readonly onDidRemove = this._onDidRemove.event;
  private readonly _onDidChangeBackupState = this._register(new Emitter<void>());
  /** Whether some dirty model's draft is not written yet may have changed (`hasUnsavedBackups`). */
  readonly onDidChangeBackupState = this._onDidChangeBackupState.event;

  saveErrorHandler: ITextFileSaveErrorHandler = LOGGING_SAVE_ERROR_HANDLER;

  private readonly mapResourceToModel = new Map<string, TextFileEditorModel>();
  private readonly modelListeners = new Map<TextFileEditorModel, DisposableStore>();
  /** Released models waiting to go, each with the token of its release; a resolve takes it back. */
  private readonly releasing = new Map<TextFileEditorModel, object>();
  private readonly host: ITextFileModelHost;

  constructor(
    runSaveParticipants: (model: ITextFileEditorModel, reason: SaveReason) => Promise<void>,
    backups: ITextFileBackups | undefined,
    @IFileService fileService: IFileService,
    @IInstantiationService private readonly instantiationService: IInstantiationService,
  ) {
    super();
    const manager = this;
    this.host = {
      get saveErrorHandler() { return manager.saveErrorHandler; },
      runSaveParticipants,
      backups,
    };
    this._register(fileService.onDidFilesChange(event => {
      for (const model of this.mapResourceToModel.values()) {
        // A deleted parent folder takes the file with it; `contains` counts that.
        if (event.contains(model.resource, FileChangeType.ADDED, FileChangeType.UPDATED, FileChangeType.DELETED)) {
          void model.checkFile();
        }
      }
    }));
  }

  get models(): readonly TextFileEditorModel[] {
    return [...this.mapResourceToModel.values()];
  }

  get(resource: URI): TextFileEditorModel | undefined {
    return this.mapResourceToModel.get(resource.toString());
  }

  /** Whether a dirty model's draft is still waiting to be written, or failed to be. */
  hasUnsavedBackups(): boolean {
    return this.models.some(model => model.hasUnsavedBackup());
  }

  async resolve(resource: URI): Promise<IResolvedTextFileEditorModel & TextFileEditorModel> {
    const key = resource.toString();
    let model = this.mapResourceToModel.get(key);
    const created = !model;
    if (!model) {
      model = this.instantiationService.createInstance(TextFileEditorModel, resource, this.host);
      this.add(key, model);
    }
    // Wanted again: a release that is waiting for it to become clean no longer applies.
    this.releasing.delete(model);
    try {
      await model.resolve();
    } catch (error) {
      // A model that never got its text is no model of the resource; the next resolve starts over.
      if (!model.isResolved() && !model.isDisposed()) {
        model.dispose();
      }
      throw error;
    }
    if (model.isDisposed() || !model.isResolved()) {
      throw new Error(`Unable to resolve resource ${resource}: its model was disposed.`);
    }
    if (created) {
      this._onDidResolve.fire(model);
    }
    return model as IResolvedTextFileEditorModel & TextFileEditorModel;
  }

  /**
   * Nothing references `model` any more: it goes once it is neither dirty nor saving, unless a
   * resolve wants it back before that.
   */
  release(model: TextFileEditorModel): void {
    if (model.isDisposed()) {
      return;
    }
    const token = {};
    this.releasing.set(model, token);
    void this.disposeWhenUnused(model, token);
  }

  private async disposeWhenUnused(model: TextFileEditorModel, token: object): Promise<void> {
    while (this.releasing.get(model) === token && !model.isDisposed()) {
      if (model.isSaving()) {
        await model.whenSaved();
      } else if (model.isDirty()) {
        // Never dropped with unsaved text: it goes once saved or reverted.
        await Event.toPromise(Event.any(model.onDidChangeDirty, model.onWillDispose));
      } else {
        this.releasing.delete(model);
        model.dispose();
      }
    }
  }

  private add(key: string, model: TextFileEditorModel): void {
    const listeners = new DisposableStore();
    listeners.add(model.onDidChangeDirty(() => this._onDidChangeDirty.fire(model)));
    listeners.add(model.onDidChangeOrphaned(() => this._onDidChangeOrphaned.fire(model)));
    listeners.add(model.onDidChangeReadonly(() => this._onDidChangeReadonly.fire(model)));
    listeners.add(model.onDidSave(event => this._onDidSave.fire({ ...event, model })));
    listeners.add(model.onDidRevert(() => this._onDidRevert.fire(model)));
    listeners.add(model.onDidChangeBackupState(() => this._onDidChangeBackupState.fire()));
    listeners.add(model.onWillDispose(() => {
      if (this.mapResourceToModel.get(key) === model) {
        this.mapResourceToModel.delete(key);
      }
      this.releasing.delete(model);
      this.modelListeners.get(model)?.dispose();
      this.modelListeners.delete(model);
      this._onDidRemove.fire(model.resource);
      this._onDidChangeBackupState.fire();
    }));
    this.mapResourceToModel.set(key, model);
    this.modelListeners.set(model, listeners);
    this._onDidCreate.fire(model);
  }

  override dispose(): void {
    for (const model of this.models) {
      model.dispose();
    }
    super.dispose();
  }
}
