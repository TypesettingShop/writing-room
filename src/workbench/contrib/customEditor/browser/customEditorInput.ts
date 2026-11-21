import type { Dimension } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, isEqual, relativePath } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../editor/common/languages/language.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import type { IReference, IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import type { IResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { WebviewPanelOptions } from '../../../api/common/extHost.protocol.webview.js';
import type { GroupIdentifier } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import type { IEditorCloseHandler, IRevertOptions, ISaveOptions } from '../../../common/editor/editorInput.js';
import { IFileDialogService } from '../../../services/dialogs/common/dialogs.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import { WebviewOverlay } from '../../webview/browser/webviewOverlay.js';
import type { CustomDocumentModel } from './customDocumentModel.js';
import { ICustomEditorService } from './customEditorService.js';

/** The Webview of a custom editor: it says when a pane shows it, which is when the editor resolves. */
export class CustomEditorWebview extends WebviewOverlay {
  private readonly shown = this._register(new Emitter<void>());
  readonly onDidShow: Event<void> = this.shown.event;

  override show(anchor: HTMLElement, dimension?: Dimension): void {
    super.show(anchor, dimension);
    this.shown.fire();
  }
}

/** The message of `error`, for a notification. */
export function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** Where a custom editor stands with its provider. */
export enum CustomEditorResolution {
  /** Not asked yet, or asked again after the extension host restarted. */
  Pending,
  Resolving,
  Resolved,
  /** The provider threw, or the model could not be read; the Webview shows why. */
  Failed,
}

/**
 * A custom editor: a Webview the extension fills. It shows in the Webview pane (which needs only
 * `webview` of it) and identifies itself to the rest of the workbench by `resource` and `viewType`.
 *
 * A `text` editor is over the text model of `resource`: dirty state, save and revert are the text
 * file model's, as for the text editor of the same file, and once it started to resolve (or startup
 * read its draft, `resolve`) it holds a reference to that model. A `custom` editor is over a document
 * of the extension's own, which the main thread attaches when it resolves: dirty state, save, revert,
 * undo and redo are that document's, shared by the editors of the same `viewType` and resource.
 */
export class CustomEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.webviewEditor';
  /** Names the Webview: its origin and its saved state. */
  readonly id = globalThis.crypto.randomUUID();
  readonly webview: CustomEditorWebview;
  override readonly closeHandler: IEditorCloseHandler;

  private reference: Promise<IReference<IResolvedTextEditorModel>> | undefined;
  private resolution = CustomEditorResolution.Pending;
  private generation = 0;
  private cancellation: CancellationTokenSource | undefined;
  /** Untitled text the editor was made for, kept until it has the model (see `acquireModel`). */
  private untitledSnapshot: { readonly value: string; readonly languageId: string | undefined } | undefined;
  private readonly services: IInstantiationService;
  private document: { readonly model: CustomDocumentModel; readonly release: IDisposable; readonly listener: IDisposable } | undefined;

  constructor(
    readonly resource: URI,
    readonly viewType: string,
    readonly extensionId: string,
    readonly options: WebviewPanelOptions,
    readonly supportsMultipleEditorsPerDocument: boolean,
    readonly kind: 'text' | 'custom',
    @IInstantiationService instantiation: IInstantiationService,
    @ITextFileService private readonly textFiles: ITextFileService,
    @ITextModelService private readonly textModels: ITextModelService,
    @IUntitledTextEditorService private readonly untitled: IUntitledTextEditorService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IFileDialogService private readonly fileDialogs: IFileDialogService,
    @INotificationService private readonly notifications: INotificationService,
  ) {
    super();
    // The editor groups and the custom editor service are looked up when needed: an input restored
    // with the editor part is made while the part (the groups service) is still being made.
    this.services = instantiation;
    const webview = this.webview = this._register(
      instantiation.createInstance(CustomEditorWebview, viewType, undefined, options.retainContextWhenHidden === true));
    if (resource.scheme === Schemas.untitled) {
      const model = untitled.get(resource);
      const text = model?.textEditorModel;
      if (model && text) {
        const languageId = model.getLanguageId();
        this.untitledSnapshot = { value: text.getValue(), languageId: languageId === PLAINTEXT_LANGUAGE_ID ? undefined : languageId };
      }
    }
    this.closeHandler = {
      // Another editor of the same text (the text editor, say) keeps the changes: closing this one loses nothing.
      showConfirm: () => this.isDirty() && !this.isShownElsewhere(),
      confirm: editors => fileDialogs.showSaveConfirm(editors.map(({ editor }) => editor.getName())),
    };
    if (kind === 'text') {
      this._register(Event.filter(textFiles.onDidChangeDirty, changed => isEqual(changed, resource))(() => this._onDidChangeDirty.fire()));
      this._register(Event.filter(textFiles.files.onDidChangeReadonly, model => isEqual(model.resource, resource))(() => this._onDidChangeLabel.fire()));
    }
    this._register(webview.onDidShow(() => instantiation.invokeFunction(accessor => accessor.get(ICustomEditorService)).resolve(this)));
  }

  override get typeId(): string {
    return CustomEditorInput.ID;
  }

  override getName(): string {
    return basename(this.resource) || this.resource.toString();
  }

  override getTitle(): string {
    const folder = this.workspace.getWorkspaceFolder(this.resource);
    const relative = folder && relativePath(folder.uri, this.resource);
    return folder && relative ? `${folder.name}/${relative}` : this.resource.toString(true);
  }

  override isDirty(): boolean {
    return this.kind === 'text' ? this.textFiles.isDirty(this.resource) : this.document?.model.isDirty() ?? false;
  }

  override isReadonly(): boolean {
    if (this.kind === 'custom') {
      // A `CustomReadonlyEditorProvider` has nothing to save.
      return this.document ? !this.document.model.editable : false;
    }
    return this.textFiles.files.get(this.resource)?.isReadonly() ?? false;
  }

  override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IResourceEditorInput | undefined> {
    if (this.kind === 'custom') {
      return await this.saveDocument(model => model.save()) ? this : undefined;
    }
    const saved = await this.textFiles.save(this.resource, options);
    if (!saved) {
      return undefined;
    }
    // Untitled text saved to a file: the file opens in this editor's place, through the resolver.
    return isEqual(saved, this.resource) ? this : { resource: saved };
  }

  override async saveAs(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IResourceEditorInput | undefined> {
    if (this.kind === 'custom') {
      const target = this.document?.model.editable ? await this.fileDialogs.pickFileToSave(this.resource) : undefined;
      return target && await this.saveDocument(model => model.saveAs(target)) ? { resource: target } : undefined;
    }
    const target = await this.textFiles.saveAs(this.resource, undefined, options);
    return target ? { resource: target } : undefined;
  }

  override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
    if (this.kind === 'custom') {
      await this.document?.model.revert().catch(error => this.notifications.error(`Failed to revert '${this.getName()}': ${describeError(error)}`));
      return;
    }
    await this.textFiles.revert(this.resource, options);
  }

  /** Undoes the last edit of a custom document; nothing for text, whose editors undo themselves. */
  async undo(): Promise<void> {
    await this.document?.model.undo();
  }

  async redo(): Promise<void> {
    await this.document?.model.redo();
  }

  /** Saves the custom document; a failure is told and leaves it dirty. */
  private async saveDocument(save: (model: CustomDocumentModel) => Promise<void>): Promise<boolean> {
    const model = this.document?.model;
    if (!model?.editable) {
      return false;
    }
    try {
      await save(model);
      return true;
    } catch (error) {
      this.notifications.error(`Failed to save '${this.getName()}': ${describeError(error)}`);
      return false;
    }
  }

  /** Puts the custom document under this editor; the input lets go of it with `release` when it closes. */
  attachDocument(model: CustomDocumentModel, release: IDisposable): void {
    this.detachDocument();
    if (this.isDisposed()) {
      release.dispose();
      return;
    }
    const listener = model.onDidChangeDirty(() => this._onDidChangeDirty.fire());
    this.document = { model, release, listener };
    if (model.isDirty()) {
      this._onDidChangeDirty.fire();
    }
  }

  /** Lets go of the custom document: it closed, or its extension host stopped. */
  detachDocument(): void {
    const document = this.document;
    if (document) {
      this.document = undefined;
      document.listener.dispose();
      document.release.dispose();
      if (document.model.isDirty()) {
        this._onDidChangeDirty.fire();
      }
    }
  }

  override matches(other: EditorInput): boolean {
    return other === this || (!this.supportsMultipleEditorsPerDocument && other instanceof CustomEditorInput
      && other.viewType === this.viewType && isEqual(other.resource, this.resource));
  }

  /**
   * The text model, through a reference this input holds until it is disposed. The first call takes
   * the reference synchronously when the model exists, so an editor that replaces another of the same
   * text keeps that model. Untitled text that went with its untitled editor (Reopen With replaced it)
   * comes back from the text it had when this input was made.
   */
  acquireModel(): Promise<ITextModel> {
    if (this.isDisposed()) {
      return Promise.reject(new Error(`${this.resource} is closed.`));
    }
    if (!this.reference) {
      if (this.resource.scheme === Schemas.untitled && !this.untitled.get(this.resource)) {
        this.untitled.restore(this.resource, this.untitledSnapshot?.value ?? '', this.untitledSnapshot?.languageId);
      }
      this.untitledSnapshot = undefined;
      const reference = this.reference = this.textModels.createModelReference(this.resource);
      reference.catch(() => {
        if (this.reference === reference) {
          this.reference = undefined;
        }
      });
    }
    return this.reference.then(({ object }) => object.textEditorModel);
  }

  /**
   * A `text` editor's model, as `acquireModel`: startup reads a restored editor's draft this way
   * before it is shown, so its tab is dirty from the start. A `custom` editor's document is the
   * extension's, which it opens only when the editor shows.
   */
  override async resolve(): Promise<IResolvedTextEditorModel | null> {
    if (this.kind !== 'text') {
      return null;
    }
    await this.acquireModel();
    return this.reference ? (await this.reference).object : null;
  }

  get resolutionState(): CustomEditorResolution {
    return this.resolution;
  }

  /** Starts a resolution, cancelling any before it; the result says which one a later answer belongs to. */
  startResolution(): { readonly generation: number; readonly token: CancellationToken } {
    this.cancellation?.dispose(true);
    const cancellation = this.cancellation = new CancellationTokenSource();
    this.resolution = CustomEditorResolution.Resolving;
    return { generation: ++this.generation, token: cancellation.token };
  }

  /** Whether `generation` is still the resolution this input waits for. */
  isResolving(generation: number): boolean {
    return !this.isDisposed() && this.generation === generation && this.resolution === CustomEditorResolution.Resolving;
  }

  completeResolution(generation: number, error?: string): void {
    if (this.isResolving(generation)) {
      this.resolution = error === undefined ? CustomEditorResolution.Resolved : CustomEditorResolution.Failed;
      this.cancellation?.dispose();
      this.cancellation = undefined;
      if (error !== undefined) {
        this.webview.setError(error);
      }
    }
  }

  /**
   * Forgets the provider's work: the extension host that resolved the editor stopped. The Webview
   * waits again, and the editor resolves anew when it is next shown, at once when it is visible.
   */
  resetResolution(): void {
    if (this.isDisposed()) {
      return;
    }
    this.cancellation?.dispose(true);
    this.cancellation = undefined;
    this.generation++;
    this.resolution = CustomEditorResolution.Pending;
    this.detachDocument();
    this.webview.resetForRestore();
  }

  /**
   * Whether another editor keeps the changes when this one closes: for text, any other editor of the
   * resource; for a custom document, another editor of the same document.
   */
  private isShownElsewhere(): boolean {
    const groups = this.services.invokeFunction(accessor => accessor.get(IEditorGroupsService));
    // A custom editor over a document of its own does not hold the text, nor another viewType's document.
    return groups.groups.some(group => group.editors.some(editor => editor !== this && !editor.matches(this)
      && isEqual(editor.resource, this.resource)
      && (editor instanceof CustomEditorInput
        ? editor.kind === this.kind && (this.kind === 'text' || editor.viewType === this.viewType)
        : this.kind === 'text')));
  }

  override dispose(): void {
    if (this.isDisposed()) {
      return;
    }
    this.cancellation?.dispose(true);
    this.cancellation = undefined;
    this.detachDocument();
    const reference = this.reference;
    this.reference = undefined;
    const untitled = this.resource.scheme === Schemas.untitled && reference !== undefined && !this.isShownElsewhere();
    super.dispose();
    void reference?.then(held => {
      held.dispose();
      // Untitled text has no file to go back to: the last editor that shows it takes it along.
      if (untitled && !this.isShownElsewhere()) {
        this.untitled.get(this.resource)?.dispose();
      }
    }, () => {});
  }
}
