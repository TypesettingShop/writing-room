import { addDisposableListener } from '../../../../base/browser/dom.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import type { URI } from '../../../../base/common/uri.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import type { IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IUntitledTextEditorService } from '../../untitled/common/untitledTextEditorService.js';
import { TextFileBackups } from '../common/textFileBackup.js';
import { TextFileEditorModelManager } from '../common/textFileEditorModelManager.js';
import { ITextFileService, UntitledTextFileService } from '../common/textfiles.js';
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
    @IWorkspaceContextService workspace: IWorkspaceContextService,
    @IInstantiationService instantiationService: IInstantiationService,
  ) {
    super(untitledService);
    this.backups = new TextFileBackups(fileService, workspace.getWorkspace().id);
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
      return super.save(resource, options);
    }
    const model = this.files.get(resource);
    return model && await model.save(options) ? resource : undefined;
  }

  override async revert(resource: URI, options?: ITextFileRevertOptions): Promise<void> {
    if (resource.scheme === Schemas.untitled) {
      return super.revert(resource, options);
    }
    await this.files.get(resource)?.revert(options);
  }

  /**
   * Untitled text, and any resource a file system provider serves — unless someone else already made
   * its text model (the settings editor's `settings.json`, say), which is lent as it is.
   */
  override canHandleResource(resource: URI): boolean {
    if (resource.scheme === Schemas.untitled || this.files.get(resource)) {
      return true;
    }
    return this.fileService.hasProvider(resource) && this.modelService.getModel(resource) === null;
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
