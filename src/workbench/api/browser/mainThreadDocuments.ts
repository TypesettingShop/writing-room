import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { normalize } from '../../../base/common/path.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import type { IMonacoTextModel } from '../../../editor/browser/monaco.js';
import { ILanguageService } from '../../../editor/common/languages/language.js';
import { isTooLargeForSyncing, MODEL_SYNC_LIMIT } from '../../../editor/common/model.js';
import type { ITextModel } from '../../../editor/common/model.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { normalizeFileResource } from '../../../platform/files/common/fileResource.js';
import { FileSystemProviderError, FileSystemProviderErrorCode, IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { extensionGlobalStorageUri, extensionWorkspaceStorageUri } from '../../services/extensions/common/extensionStoragePaths.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { ITextFileService } from '../../services/textfile/common/textfiles.js';
import type { ITextFileWillSaveEvent } from '../../services/textfile/common/textfiles.js';
import { IUntitledTextEditorService } from '../../services/untitled/common/untitledTextEditorService.js';
import { documentSaveTimeout } from '../common/extHost.protocol.documents.js';
import type { DocumentEdit, ExtHostDocumentsShape, MainThreadDocumentsShape, OpenDocumentOptions } from '../common/extHost.protocol.documents.js';
import { applyDocumentEdit, validateDocumentEdit } from './mainThreadDocumentEdits.js';

const referenceMaxAge = 3 * 60 * 1000;
const settingsUri = 'vscode-userdata:/User/settings.json';
const reservedSchemes = new Set<string>([...Object.values(Schemas), 'webview-panel', 'vscode-custom-editor', 'output']);
const unsafeResource = /[\\\x00-\x1f\x7f-\x9f]|%(?:25)*(?:2f|5c)/i;

interface TrackedModel {
  readonly model: ITextModel;
  readonly uri: URI;
  readonly listeners: DisposableStore;
  mirrored: boolean;
  dirty: boolean;
}

interface Provider {
  readonly owner: string;
  readonly scheme: string;
  readonly registration: IDisposable;
}

export class MainThreadDocuments extends Disposable implements MainThreadDocumentsShape {
  private readonly tracked = new Map<string, TrackedModel>();
  private readonly references = new Map<string, { model: ITextModel; release: IDisposable }>();
  private readonly providers = new Map<number, Provider>();
  private readonly provided = new WeakMap<ITextModel, number>();
  private readonly updates = new WeakMap<ITextModel, symbol>();
  private readonly saves = new Map<number, { id: string; deadline: number }>();
  private nextSave = 0;
  private stopped = false;

  constructor(
    private readonly proxy: ExtHostDocumentsShape,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    @IModelService private readonly models: IModelService,
    @ICodeEditorService private readonly editors: ICodeEditorService,
    @ITextModelService private readonly resolver: ITextModelService,
    @ITextFileService private readonly files: ITextFileService,
    @IFileService private readonly fileService: IFileService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IUntitledTextEditorService private readonly untitled: IUntitledTextEditorService,
    @ILanguageService private readonly languages: ILanguageService,
  ) {
    super();
    this._register(models.onModelAdded(model => this.add(model)));
    this._register(models.onModelRemoved(model => this.removeModel(model)));
    this._register(models.onModelLanguageChanged(({ model, newLanguageId }) => {
      if (this.isMirrored(model.id)) {
        this.send(proxy.$acceptDocumentLanguage(model.id, newLanguageId));
      }
    }));
    this._register(files.onDidChangeDirty(uri => {
      // Some text file models set dirty in a listener of the same content change.
      queueMicrotask(() => this.sendDirty(uri));
    }));
    this._register(files.onDidSave(({ resource }) => {
      const model = this.models.getModel(resource);
      if (model && this.isMirrored(model.id)) {
        this.sendDirty(resource);
        this.send(proxy.$acceptDocumentSaved(model.id));
      }
    }));
    this._register(files.onWillSave(event => {
      const model = this.models.getModel(event.resource);
      if (model && this.isMirrored(model.id)) {
        event.waitUntil(this.participate(model, event));
      }
    }));
    for (const model of models.getModels()) {
      this.add(model);
    }
  }


  isMirrored(id: string): boolean {
    return this.tracked.get(id)?.mirrored === true;
  }

  getModel(id: string): ITextModel | undefined {
    return this.isMirrored(id) ? this.tracked.get(id)?.model : undefined;
  }

  isReadOnly(model: ITextModel): boolean {
    return this.provided.has(model);
  }

  private send(result: Promise<void>): void {
    void result.catch(error => {
      if (!this.stopped) {
        console.error(error);
      }
    });
  }

  private add(model: ITextModel): void {
    if (this.tracked.has(model.id)) {
      return;
    }
    const uri = URI.parse(model.uri.toString(), true);
    const entry = { model, uri, listeners: new DisposableStore(), mirrored: false, dirty: false };
    this.tracked.set(model.id, entry);
    this.updateMirror(entry);
    entry.listeners.add(model.onDidChangeContent(event => {
      if (this.updateMirror(entry)) {
        entry.dirty = this.files.isDirty(uri);
        this.send(this.proxy.$acceptDocumentChanges(model.id, event, entry.dirty));
      }
    }));
  }

  /** Returns whether an existing mirror can accept an incremental change. */
  private updateMirror(entry: TrackedModel): boolean {
    const eligible = !isTooLargeForSyncing(entry.model);
    if (entry.mirrored === eligible) {
      return eligible;
    }
    entry.mirrored = eligible;
    const { model, uri } = entry;
    if (eligible) {
      entry.dirty = this.files.isDirty(uri);
      this.send(this.proxy.$acceptDocumentDelta({ added: [{
        id: model.id, uri, lines: model.getLinesContent(), eol: model.getEOL(), version: model.getVersionId(),
        language: model.getLanguageId(), dirty: entry.dirty,
      }] }));
    } else {
      this.send(this.proxy.$acceptDocumentDelta({ removed: [model.id] }));
    }
    return false;
  }

  private removeModel(model: ITextModel): void {
    const entry = this.tracked.get(model.id);
    if (!entry) {
      return;
    }
    entry.listeners.dispose();
    this.tracked.delete(model.id);
    this.references.get(model.id)?.release.dispose();
    if (entry.mirrored) {
      this.send(this.proxy.$acceptDocumentDelta({ removed: [model.id] }));
    }
  }

  private sendDirty(resource: URI): void {
    const model = this.models.getModel(resource);
    const entry = model && this.tracked.get(model.id);
    if (entry?.mirrored) {
      const dirty = this.files.isDirty(resource);
      if (entry.dirty !== dirty) {
        entry.dirty = dirty;
        this.send(this.proxy.$acceptDocumentDirty(entry.model.id, dirty));
      }
    }
  }

  private requireExtension(key: string): HostExtensionDescription {
    const extension = this.getExtension(key);
    if (!extension || this.stopped) {
      throw new Error('The extension is no longer registered.');
    }
    return extension;
  }

  /** Apply the same storage boundaries to document opens, editor commands, and workspace edits. */
  authorizeResource(extension: string, resource: URI, write: boolean): URI {
    const { id } = this.requireExtension(extension);
    if (!URI.isUri(resource) || resource.hasEncodedPathSeparator || unsafeResource.test(resource.path)) {
      throw new FileSystemProviderError('Invalid document resource.', FileSystemProviderErrorCode.NoPermissions);
    }
    if (resource.scheme === Schemas.untitled || resource.toString() === settingsUri) {
      if (!write) {
        return resource;
      }
    } else if (resource.scheme === Schemas.vscodeVfs || resource.scheme === Schemas.vscodeUserData) {
      const normalized = normalizeFileResource(resource);
      if (this.workspace.getWorkspaceFolder(normalized)
        || isEqualOrParent(normalized, extensionGlobalStorageUri(id))
        || isEqualOrParent(normalized, extensionWorkspaceStorageUri(this.workspace.getWorkspace().id, id))
        || (!write && isEqualOrParent(normalized, URI.parse('vscode-userdata:/extensions')))) {
        return normalized;
      }
    } else if (!reservedSchemes.has(resource.scheme)) {
      const normalized = resource.with({ path: normalize(resource.path) });
      if (this.fileService.hasProvider(normalized) || (!write && this.resolver.canHandleResource(normalized))) {
        return normalized;
      }
    }
    throw new FileSystemProviderError('Access to this document resource is denied.', FileSystemProviderErrorCode.NoPermissions);
  }

  async $openDocument(extension: string, target: URI | OpenDocumentOptions): Promise<string> {
    this.requireExtension(extension);
    if (URI.isUri(target)) {
      const resource = this.authorizeResource(extension, target, false);
      const existing = this.models.getModel(resource);
      if (existing) {
        return this.requireMirrored(existing);
      }
      const reference = await this.resolver.createModelReference(resource);
      const model = reference.object.textEditorModel;
      if (!this.isMirrored(model.id) || this.stopped) {
        reference.dispose();
        return this.requireMirrored(model);
      }
      this.keepReference(model, reference);
      return model.id;
    }
    if (target === null || typeof target !== 'object'
      || ('scheme' in target) || (target.content !== undefined && typeof target.content !== 'string')
      || (target.language !== undefined && typeof target.language !== 'string')) {
      throw new TypeError('Invalid text document options.');
    }
    if ((target.content?.length ?? 0) > MODEL_SYNC_LIMIT) {
      throw new Error('The text document exceeds the 50 MiB synchronization limit.');
    }
    const languageId = target.language;
    this.validateLanguage(languageId);
    const untitled = this.untitled.create({ initialValue: target.content, languageId });
    try {
      await untitled.resolve();
      const model = untitled.textEditorModel;
      if (!model) {
        throw new Error('The text document is no longer available.');
      }
      const id = this.requireMirrored(model);
      this.keepReference(model, toDisposable(() => {
        if (!this.editors.listCodeEditors().some(editor => editor.getModel() === model)) {
          untitled.dispose();
        }
      }));
      return id;
    } catch (error) {
      untitled.dispose();
      throw error;
    }
  }

  private requireMirrored(model: ITextModel): string {
    if (!this.isMirrored(model.id) || this.stopped) {
      throw new Error('The text document is unavailable or exceeds the 50 MiB synchronization limit.');
    }
    return model.id;
  }

  private keepReference(model: ITextModel, reference: IDisposable | undefined): void {
    if (!reference) {
      return;
    }
    if (this.references.has(model.id)) {
      reference.dispose();
      return;
    }
    const release = toDisposable(() => {
      this.references.delete(model.id);
      clearTimeout(timer);
      reference.dispose();
    });
    const timer = setTimeout(() => release.dispose(), referenceMaxAge);
    this.references.set(model.id, { model, release });
    let total = 0;
    for (const entry of this.references.values()) {
      total += entry.model.getValueLength();
    }
    for (const entry of this.references.values()) {
      if (total <= MODEL_SYNC_LIMIT) {
        break;
      }
      total -= entry.model.getValueLength();
      entry.release.dispose();
    }
  }

  private validateLanguage(language: string | undefined): void {
    if (language !== undefined && (typeof language !== 'string' || !this.languages.isRegisteredLanguageId(language))) {
      throw new Error(`Unknown language '${language}'.`);
    }
  }

  async $setDocumentLanguage(extension: string, id: string, language: string): Promise<void> {
    this.requireExtension(extension);
    const model = this.getModel(id);
    if (!model) {
      throw new Error('The text document is no longer available.');
    }
    this.validateLanguage(language);
    this.models.setModelLanguage(model, language);
  }

  async $saveDocument(id: string): Promise<boolean> {
    const entry = this.tracked.get(id);
    if (!entry?.mirrored || this.isReadOnly(entry.model) || this.stopped || !this.files.canHandleResource(entry.uri)
      || [...this.saves.values()].some(save => save.id === id)
      || (entry.uri.scheme !== Schemas.untitled && !this.workspace.getWorkspaceFolder(entry.uri))) {
      return false;
    }
    try {
      return !!await this.files.save(entry.uri, { reason: 'explicit' });
    } catch {
      return false;
    }
  }

  private async participate(model: ITextModel, event: ITextFileWillSaveEvent): Promise<void> {
    const id = ++this.nextSave;
    const deadline = Date.now() + documentSaveTimeout;
    const source = new CancellationTokenSource();
    this.saves.set(id, { id: model.id, deadline });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, documentSaveTimeout); });
      await Promise.race([this.proxy.$participateInSave(model.id, id, deadline, event.reason === 'explicit' ? 1 : 2, source.token), timeout]);
    } catch (error) {
      if (!this.stopped) {
        console.warn('Document save participation failed:', error);
      }
    } finally {
      this.saves.delete(id);
      clearTimeout(timer);
      source.dispose(true);
    }
  }

  async $applySaveEdits(extension: string, save: number, version: number, edit: DocumentEdit): Promise<boolean> {
    const pending = this.saves.get(save);
    const model = pending && this.getModel(pending.id);
    if (!pending || Date.now() >= pending.deadline || !model || this.isReadOnly(model)
      || !this.getExtension(extension) || model.getVersionId() !== version || this.stopped) {
      return false;
    }
    try {
      const operations = validateDocumentEdit(model, edit);
      if (Date.now() >= pending.deadline) {
        return false;
      }
      applyDocumentEdit(model as IMonacoTextModel, operations, edit.eol);
      return true;
    } catch {
      return false;
    }
  }

  async $registerContentProvider(extension: string, handle: number, scheme: string): Promise<void> {
    this.requireExtension(extension);
    if (!Number.isSafeInteger(handle) || this.providers.has(handle)
      || typeof scheme !== 'string' || !/^[a-z][a-z\d.+-]*$/.test(scheme) || reservedSchemes.has(scheme)) {
      throw new Error('Cannot register a document provider for this scheme.');
    }
    const registration = this.resolver.registerTextModelContentProvider(scheme, {
      provideTextContent: async resource => {
        const content = await this.proxy.$provideDocumentContent(extension, handle, resource, CancellationToken.None);
        if (typeof content !== 'string' || this.stopped || !this.providers.has(handle)) {
          return null;
        }
        const model = await this.models.createModel(content, undefined, resource);
        if (this.stopped || !this.providers.has(handle)) {
          model.dispose();
          return null;
        }
        this.provided.set(model, handle);
        return model;
      },
    });
    this.providers.set(handle, { owner: extension, scheme, registration });
  }

  async $unregisterContentProvider(extension: string, handle: number): Promise<void> {
    const provider = this.providers.get(handle);
    if (provider?.owner === extension) {
      this.providers.delete(handle);
      provider.registration.dispose();
    }
  }

  async $updateProvidedContent(extension: string, handle: number, uri: URI): Promise<void> {
    const provider = this.providers.get(handle);
    if (!URI.isUri(uri) || provider?.owner !== extension || provider.scheme !== uri.scheme) {
      return;
    }
    const resource = this.authorizeResource(extension, uri, false);
    const model = this.models.getModel(resource);
    if (!model || this.provided.get(model) !== handle) {
      return;
    }
    const update = Symbol();
    this.updates.set(model, update);
    const content = await this.proxy.$provideDocumentContent(extension, handle, resource, CancellationToken.None);
    if (typeof content === 'string' && !model.isDisposed() && !this.stopped && this.providers.get(handle) === provider
      && this.updates.get(model) === update && model.getValue() !== content) {
      model.setValue(content);
    }
  }

  remove(extension: string): void {
    for (const [handle, provider] of this.providers) {
      if (provider.owner === extension) {
        void this.$unregisterContentProvider(extension, handle);
      }
    }
  }

  override dispose(): void {
    this.stopped = true;
    super.dispose();
    for (const provider of this.providers.values()) {
      provider.registration.dispose();
    }
    this.providers.clear();
    for (const entry of this.tracked.values()) {
      entry.listeners.dispose();
    }
    this.tracked.clear();
    for (const { release } of this.references.values()) {
      release.dispose();
    }
    this.saves.clear();
  }
}
