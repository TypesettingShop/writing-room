import type { Dimension } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, isEqual, relativePath } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import type { IReference, IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import type { IResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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
 * A custom text editor: a Webview the extension fills, over the text model of `resource`. It shows
 * in the Webview pane (which needs only `webview` of it) and identifies itself to the rest of the
 * workbench by `resource` and `viewType`. Dirty state, save and revert are the text file model's, as
 * for the text editor of the same file; once the custom editor started to resolve, it holds a
 * reference to that model.
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
  private untitledSnapshot: { readonly value: string; readonly languageId: string } | undefined;
  private readonly services: IInstantiationService;

  constructor(
    readonly resource: URI,
    readonly viewType: string,
    readonly extensionId: string,
    readonly options: WebviewPanelOptions,
    readonly supportsMultipleEditorsPerDocument: boolean,
    @IInstantiationService instantiation: IInstantiationService,
    @ITextFileService private readonly textFiles: ITextFileService,
    @ITextModelService private readonly textModels: ITextModelService,
    @IUntitledTextEditorService private readonly untitled: IUntitledTextEditorService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IFileDialogService fileDialogs: IFileDialogService,
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
        this.untitledSnapshot = { value: text.getValue(), languageId: model.getLanguageId() };
      }
    }
    this.closeHandler = {
      // Another editor of the same text (the text editor, say) keeps the changes: closing this one loses nothing.
      showConfirm: () => this.isDirty() && !this.isShownElsewhere(),
      confirm: editors => fileDialogs.showSaveConfirm(editors.map(({ editor }) => editor.getName())),
    };
    this._register(Event.filter(textFiles.onDidChangeDirty, changed => isEqual(changed, resource))(() => this._onDidChangeDirty.fire()));
    this._register(Event.filter(textFiles.files.onDidChangeReadonly, model => isEqual(model.resource, resource))(() => this._onDidChangeLabel.fire()));
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
    return this.textFiles.isDirty(this.resource);
  }

  override isReadonly(): boolean {
    return this.textFiles.files.get(this.resource)?.isReadonly() ?? false;
  }

  override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IResourceEditorInput | undefined> {
    const saved = await this.textFiles.save(this.resource, options);
    if (!saved) {
      return undefined;
    }
    // Untitled text saved to a file: the file opens in this editor's place, through the resolver.
    return isEqual(saved, this.resource) ? this : { resource: saved };
  }

  override async saveAs(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IResourceEditorInput | undefined> {
    const target = await this.textFiles.saveAs(this.resource, undefined, options);
    return target ? { resource: target } : undefined;
  }

  override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
    await this.textFiles.revert(this.resource, options);
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
    this.webview.resetForRestore();
  }

  private isShownElsewhere(): boolean {
    const groups = this.services.invokeFunction(accessor => accessor.get(IEditorGroupsService));
    return groups.groups.some(group => group.editors.some(editor => editor !== this && !editor.matches(this)
      && isEqual(editor.resource, this.resource)));
  }

  override dispose(): void {
    if (this.isDisposed()) {
      return;
    }
    this.cancellation?.dispose(true);
    this.cancellation = undefined;
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
