import { addDisposableListener } from '../../../../base/browser/dom.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, isEqual, joinPath } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import type { IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../dialogs/common/dialogs.js';
import { IUntitledTextEditorService } from '../../untitled/common/untitledTextEditorService.js';
import { createBackupSessionId, TextFileBackups } from '../common/textFileBackup.js';
import { TextFileEditorModelManager } from '../common/textFileEditorModelManager.js';
import { isTextFileResource, ITextFileService, UntitledTextFileService } from '../common/textfiles.js';
import type { ITextFileRevertOptions, ITextFileSaveOptions, SaveReason } from '../common/textfiles.js';

/**
 * The text file service of the workbench: untitled text as before, and the text of every resource a
 * file system provider serves, in `TextFileEditorModel`s. Drafts of dirty files go to the workspace
 * storage; leaving the page while one is not written yet asks first.
 */
export class BrowserTextFileService extends UntitledTextFileService {
  private readonly fileModels: TextFileEditorModelManager;
  readonly backups: TextFileBackups;
  private readonly beforeUnload = this._register(new MutableDisposable<IDisposable>());
  private disposed = false;

  constructor(
    @IUntitledTextEditorService untitledService: IUntitledTextEditorService,
    @IFileService private readonly fileService: IFileService,
    @IModelService private readonly modelService: IModelService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IInstantiationService private readonly instantiationService: IInstantiationService,
  ) {
    super(untitledService);
    this.backups = new TextFileBackups(fileService, workspace.getWorkspace().id, createBackupSessionId());
    this.fileModels = this._register(instantiationService.createInstance(TextFileEditorModelManager,
      (model, reason) => this.runSaveParticipants(model.resource, reason), this.backups));
    this._register(this.files.onDidChangeDirty(model => this.fireDidChangeDirty(model.resource)));
    this._register(this.files.onDidSave(({ resource, reason }) => this.fireDidSave({ resource, reason })));
    this._register(this.files.onDidChangeBackupState(() => this.updateBeforeUnload()));
  }

  override get files(): TextFileEditorModelManager {
    return this.fileModels;
  }

  /** Fires `onWillSave` and waits for what its listeners handed in; a failing participant does not stop the save. */
  private async runSaveParticipants(resource: URI, reason: SaveReason): Promise<void> {
    const pending: Promise<unknown>[] = [];
    let delivering = true;
    this.fireWillSave({
      resource,
      reason,
      waitUntil: work => {
        if (!delivering) {
          throw new Error('waitUntil can only be called while the save event is being delivered.');
        }
        pending.push(work);
      },
    });
    delivering = false;
    for (const result of await Promise.allSettled(pending)) {
      if (result.status === 'rejected') {
        console.warn(`A save participant of ${resource} failed.`, result.reason);
      }
    }
  }

  override isDirty(resource: URI): boolean {
    return resource.scheme === Schemas.untitled ? super.isDirty(resource) : this.files.get(resource)?.isDirty() ?? false;
  }

  override async save(resource: URI, options?: ITextFileSaveOptions): Promise<URI | undefined> {
    if (resource.scheme === Schemas.untitled) {
      // Untitled text has nowhere to go yet: ask where.
      return this.saveAs(resource, undefined, options);
    }
    const model = this.files.get(resource);
    return model && await model.save(options) ? resource : undefined;
  }

  /**
   * Writes the text of `source` to `target` (asked for when not given). A target that is open has
   * its model take the text and save it, which runs the save participants and asks before
   * overwriting a newer file; any other target is written directly. A file source drops its unsaved
   * changes afterwards, as they are in the target now; untitled text goes with its editor.
   */
  override async saveAs(source: URI, target?: URI, options?: ITextFileSaveOptions): Promise<URI | undefined> {
    if (!this.hasText(source)) {
      return undefined;
    }
    if (!target) {
      target = await this.pickSaveTarget(source);
      if (!target) {
        return undefined;
      }
    }
    if (isEqual(source, target)) {
      return source.scheme === Schemas.untitled ? undefined : this.save(source, options);
    }
    if (source.scheme !== Schemas.untitled && !this.files.get(source)?.isResolved()) {
      // A file with no text read (binary, too large, never opened) goes over byte for byte, as VS
      // Code copies it: decoding it as UTF-8 and encoding it again would change what it holds.
      return await this.copyFile(source, target) ? target : undefined;
    }
    // Read once the dialog is done: nothing could be typed while it was open, but a reload could happen.
    const text = this.readText(source);
    if (text === undefined || !await this.writeText(target, text, options)) {
      return undefined;
    }
    if (source.scheme !== Schemas.untitled) {
      await this.files.get(source)?.revert().catch(error => console.warn(`Could not revert ${source} after Save As.`, error));
    }
    return target;
  }

  private hasText(resource: URI): boolean {
    return resource.scheme === Schemas.untitled ? this.untitledService.get(resource) !== undefined : this.fileService.hasProvider(resource);
  }

  /** The text of untitled text or of a file model that has read its file. */
  private readText(resource: URI): string | undefined {
    return resource.scheme === Schemas.untitled
      ? this.untitledService.get(resource)?.getValue()
      : this.files.get(resource)?.textEditorModel?.getValue();
  }

  /** Copies a file as it is stored; a failure is told as a failed save. */
  private async copyFile(source: URI, target: URI): Promise<boolean> {
    try {
      await this.fileService.copy(source, target, true);
      return true;
    } catch (error) {
      this.files.saveErrorHandler.onSaveError(error, { resource: target });
      return false;
    }
  }

  private async writeText(target: URI, text: string, options?: ITextFileSaveOptions): Promise<boolean> {
    const open = this.files.get(target);
    const model = open?.isResolved() && !open.isDisposed() ? open.textEditorModel : null;
    if (open && model) {
      if (model.getValue() !== text) {
        const end = model.getPositionAt(model.getValueLength());
        model.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column }, text }]);
      }
      return open.save(options);
    }
    try {
      await this.fileService.writeFile(target, new TextEncoder().encode(text));
      return true;
    } catch (error) {
      this.files.saveErrorHandler.onSaveError(error, { resource: target });
      return false;
    }
  }

  /** The save dialog, from the file's own place, or for untitled text its name in the default folder. */
  private async pickSaveTarget(source: URI): Promise<URI | undefined> {
    return this.instantiationService.invokeFunction(async accessor => {
      const dialogs = accessor.get(IFileDialogService);
      if (source.scheme !== Schemas.untitled) {
        return dialogs.pickFileToSave(source);
      }
      const folder = dialogs.defaultFilePath() ?? this.workspace.getWorkspace().folders[0]?.uri;
      if (!folder) {
        return undefined;
      }
      return dialogs.pickFileToSave(joinPath(folder, basename(source) + this.suggestedExtension(source)));
    });
  }

  /** The first file extension of the untitled text's language; `.txt` for plain text or when none is known. */
  private suggestedExtension(source: URI): string {
    const languageId = this.untitledService.get(source)?.getLanguageId();
    if (!languageId) {
      return '.txt';
    }
    const extension = this.instantiationService.invokeFunction(accessor => {
      try {
        return accessor.get(ILanguageService).getExtensions(languageId)[0];
      } catch {
        return undefined;
      }
    });
    return extension && /^\.[^/\\]+$/.test(extension) ? extension : '.txt';
  }

  override async revert(resource: URI, options?: ITextFileRevertOptions): Promise<void> {
    if (resource.scheme === Schemas.untitled) {
      return super.revert(resource, options);
    }
    await this.files.get(resource)?.revert(options);
  }

  /**
   * Untitled text, and any text file resource (`isTextFileResource`) — unless someone else already made
   * its text model (the settings editor's `settings.json`, say), which is lent as it is.
   */
  override canHandleResource(resource: URI): boolean {
    if (resource.scheme === Schemas.untitled || this.files.get(resource)) {
      return true;
    }
    return isTextFileResource(resource, this.fileService) && this.modelService.getModel(resource) === null;
  }

  override async resolve(resource: URI): Promise<IResolvedTextEditorModel> {
    if (resource.scheme === Schemas.untitled) {
      return super.resolve(resource);
    }
    const model = await this.files.resolve(resource);
    let released = false;
    return {
      textEditorModel: model.textEditorModel,
      // The last reference went: the model goes once it is clean, unless resolved again first.
      dispose: () => {
        if (!released) {
          released = true;
          this.files.release(model);
        }
      },
    };
  }

  /** As the editor part does for untitled text past its budget: the browser asks before the page goes. */
  private updateBeforeUnload(): void {
    if (this.disposed || !this.files.hasUnsavedBackups()) {
      this.beforeUnload.clear();
    } else if (!this.beforeUnload.value && typeof window !== 'undefined') {
      this.beforeUnload.value = addDisposableListener(window, 'beforeunload', event => {
        event.preventDefault();
        event.returnValue = ' ';
      });
    }
  }

  override dispose(): void {
    // The models it disposes report their drafts on the way out; nothing may listen after this.
    this.disposed = true;
    super.dispose();
  }
}

registerSingleton(ITextFileService, BrowserTextFileService);
