import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { IResolvedTextEditorModel, ITextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUntitledTextEditorService } from '../../untitled/common/untitledTextEditorService.js';

export const ITextFileService = createDecorator<ITextFileService>('textFileService');

export type SaveReason = 'explicit' | 'auto';

/** Before a text file saves. Listeners may hand in work the save waits for, such as edits to apply first. */
export interface ITextFileWillSaveEvent {
  readonly resource: URI;
  readonly reason: SaveReason;
  /** Only while the event is being delivered; the save waits for every promise handed in. */
  waitUntil(work: Promise<unknown>): void;
}

export interface ITextFileSaveEvent {
  readonly resource: URI;
  readonly reason: SaveReason;
}

export interface ITextFileSaveOptions {
  readonly reason?: SaveReason;
}

export interface ITextFileRevertOptions {
  /** Only drop the unsaved state; the text stays as it is and the file is not read again. */
  readonly soft?: boolean;
}

/** Why a file could not be opened as text. */
export enum TextFileOperationResult {
  FILE_IS_BINARY,
  FILE_TOO_LARGE,
  FILE_NOT_FOUND,
  FILE_IS_DIRECTORY,
}

export class TextFileOperationError extends Error {
  constructor(message: string, readonly textFileOperationResult: TextFileOperationResult, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TextFileOperationError';
  }
}

/** The largest file that opens in the text editor: `TextModel.LARGE_FILE_SIZE_THRESHOLD`. */
export const TEXT_FILE_SIZE_LIMIT = 20 * 1024 * 1024;

/** A save that would overwrite what another writer saved first: overwrite it, take its text, or neither. */
export type TextFileConflictResolution = 'overwrite' | 'revert' | 'cancel';

/**
 * What a file model asks when a save cannot go on by itself. The workbench sets the one that asks the
 * user; without it, a conflict cancels the save and a failure is only logged.
 */
export interface ITextFileSaveErrorHandler {
  /** The file changed on disk since it was read; the save waits for the answer. */
  resolveConflict(model: ITextFileEditorModel): Promise<TextFileConflictResolution>;
  /** The save failed; the text stays unsaved. */
  onSaveError(error: unknown, model: ITextFileEditorModel): void;
}

/** The text of one file, read into a text model, with its unsaved state. */
export interface ITextFileEditorModel extends ITextEditorModel {
  readonly resource: URI;
  readonly onDidChangeDirty: Event<void>;
  /** The file was deleted while open, or came back. */
  readonly onDidChangeOrphaned: Event<void>;
  readonly onDidChangeReadonly: Event<void>;
  readonly onDidSave: Event<ITextFileSaveEvent>;
  readonly onDidRevert: Event<void>;
  readonly onWillDispose: Event<void>;

  /** Whether the text has been read, so `textEditorModel` is there. */
  isResolved(): boolean;
  isDirty(): boolean;
  /** The file is gone from disk; the text stays until it is saved again or closed. */
  isOrphaned(): boolean;
  isReadonly(): boolean;
  /** A save is running or waiting. */
  isSaving(): boolean;
  /** Saves the text: `true` once what was asked for is saved, `false` when it failed or was cancelled. */
  save(options?: ITextFileSaveOptions): Promise<boolean>;
  revert(options?: ITextFileRevertOptions): Promise<void>;
  isDisposed(): boolean;
}

export interface IResolvedTextFileEditorModel extends ITextFileEditorModel {
  readonly textEditorModel: ITextModel;
}

/**
 * The file models, one per resource, as VS Code's `ITextFileService.files`. Each event names the
 * model it is about.
 */
export interface ITextFileEditorModelManager {
  readonly onDidCreate: Event<ITextFileEditorModel>;
  readonly onDidResolve: Event<ITextFileEditorModel>;
  readonly onDidChangeDirty: Event<ITextFileEditorModel>;
  readonly onDidChangeOrphaned: Event<ITextFileEditorModel>;
  readonly onDidChangeReadonly: Event<ITextFileEditorModel>;
  readonly onDidSave: Event<ITextFileSaveEvent & { readonly model: ITextFileEditorModel }>;
  readonly onDidRevert: Event<ITextFileEditorModel>;
  /** A model was disposed and left the manager. */
  readonly onDidRemove: Event<URI>;

  readonly models: readonly ITextFileEditorModel[];
  /** Asked when a save conflicts or fails. */
  saveErrorHandler: ITextFileSaveErrorHandler;

  get(resource: URI): ITextFileEditorModel | undefined;
  /**
   * The resource's model, read from its draft backup when there is one, else from the file. It
   * rejects with a `TextFileOperationError` for a file that is binary, too large, missing or a folder.
   */
  resolve(resource: URI): Promise<IResolvedTextFileEditorModel>;
}

/**
 * The text of resources that are saved somewhere: whether it has unsaved changes, saving it, and
 * the events around a save that the document API forwards to extensions. The editor part registers
 * an implementation that knows untitled text only, which has nowhere to be saved; the file editing
 * epic registers the real one (`browser/textFileService.ts`) under the same identifier, which also
 * holds the text of files.
 */
export interface ITextFileService extends BrandedService {
  readonly onWillSave: Event<ITextFileWillSaveEvent>;
  readonly onDidSave: Event<ITextFileSaveEvent>;
  /** A resource's text gained or lost unsaved changes. */
  readonly onDidChangeDirty: Event<URI>;

  /** The file models. */
  readonly files: ITextFileEditorModelManager;

  isDirty(resource: URI): boolean;
  /** Saves the resource's text; resolves to where it was saved, or `undefined` when it was not. */
  save(resource: URI, options?: ITextFileSaveOptions): Promise<URI | undefined>;
  /** Drops the resource's unsaved changes: a file reads its text again unless `soft`. */
  revert(resource: URI, options?: ITextFileRevertOptions): Promise<void>;
  /** Whether this service holds the text of `resource`, so text model references come here. */
  canHandleResource(resource: URI): boolean;
  /**
   * The resource's text model, for a text model reference. Disposing the result tells this service
   * the last reference went: a file model goes once it is neither dirty nor saving, unless it is
   * resolved again first; untitled text stays, as its editor owns it.
   */
  resolve(resource: URI): Promise<IResolvedTextEditorModel>;
}

/** The file models of a service that has none. */
class NoTextFileEditorModels implements ITextFileEditorModelManager {
  readonly onDidCreate = Event.None;
  readonly onDidResolve = Event.None;
  readonly onDidChangeDirty = Event.None;
  readonly onDidChangeOrphaned = Event.None;
  readonly onDidChangeReadonly = Event.None;
  readonly onDidSave = Event.None;
  readonly onDidRevert = Event.None;
  readonly onDidRemove = Event.None;
  readonly models: readonly ITextFileEditorModel[] = [];
  saveErrorHandler: ITextFileSaveErrorHandler = {
    resolveConflict: async () => 'cancel',
    onSaveError: () => {},
  };

  get(): undefined {
    return undefined;
  }

  resolve(resource: URI): Promise<IResolvedTextFileEditorModel> {
    return Promise.reject(new Error(`Unable to resolve resource ${resource}: files are not available.`));
  }
}

const NO_TEXT_FILE_EDITOR_MODELS: ITextFileEditorModelManager = new NoTextFileEditorModels();

/** The text file service the workbench starts with: untitled text only, which never saves. */
export class UntitledTextFileService extends Disposable implements ITextFileService {
  declare readonly _serviceBrand: undefined;

  private readonly _onWillSave = this._register(new Emitter<ITextFileWillSaveEvent>());
  /** Never fires here: nothing saves untitled text. */
  readonly onWillSave = this._onWillSave.event;
  private readonly _onDidSave = this._register(new Emitter<ITextFileSaveEvent>());
  readonly onDidSave = this._onDidSave.event;
  private readonly _onDidChangeDirty = this._register(new Emitter<URI>());
  readonly onDidChangeDirty = this._onDidChangeDirty.event;

  /** There are no file models here. */
  get files(): ITextFileEditorModelManager {
    return NO_TEXT_FILE_EDITOR_MODELS;
  }

  constructor(@IUntitledTextEditorService protected readonly untitledService: IUntitledTextEditorService) {
    super();
    this._register(untitledService.onDidChangeDirty(model => this._onDidChangeDirty.fire(model.resource)));
  }

  protected fireWillSave(event: ITextFileWillSaveEvent): void {
    this._onWillSave.fire(event);
  }

  protected fireDidSave(event: ITextFileSaveEvent): void {
    this._onDidSave.fire(event);
  }

  protected fireDidChangeDirty(resource: URI): void {
    this._onDidChangeDirty.fire(resource);
  }

  isDirty(resource: URI): boolean {
    return this.untitledService.get(resource)?.isDirty() ?? false;
  }

  /** Untitled text has no place to go until the file editing epic adds Save As. */
  async save(_resource: URI, _options?: ITextFileSaveOptions): Promise<URI | undefined> {
    return undefined;
  }

  /** Untitled text has no saved state to go back to. */
  async revert(_resource: URI, _options?: ITextFileRevertOptions): Promise<void> {}

  canHandleResource(resource: URI): boolean {
    return resource.scheme === Schemas.untitled;
  }

  async resolve(resource: URI): Promise<IResolvedTextEditorModel> {
    const untitled = this.untitledService.get(resource);
    if (!untitled) {
      throw new Error(`Unable to resolve resource ${resource}: no such untitled text.`);
    }
    await untitled.resolve();
    const model = untitled.textEditorModel;
    if (!model) {
      throw new Error(`Unable to resolve resource ${resource}: the untitled text was disposed.`);
    }
    // The untitled input owns the model, so letting go of the reference disposes nothing.
    return { textEditorModel: model, dispose: () => {} };
  }
}
