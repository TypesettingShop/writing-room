import type * as vscode from 'vscode';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import type { IModelContentChangedEvent } from '../../../editor/common/model.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { ExtHostDocumentData, fromModelRange } from './extHostDocumentData.js';
import { ExtHostDocumentSaveParticipant } from './extHostDocumentSaveParticipant.js';
import { ExtHostMarkdownlintDocuments, usesMarkdownlintDocumentAliases } from './extHostMarkdownlintDocuments.js';
import { Disposable as ApiDisposable } from './extHostTypes.js';
import type { DocumentDelta, MainThreadDocumentsShape, OpenDocumentOptions } from './extHost.protocol.documents.js';

export enum TextDocumentChangeReason { Undo = 1, Redo = 2 }
export enum TextDocumentSaveReason { Manual = 1, AfterDelay = 2, FocusOut = 3 }

interface MarkdownlintRefresh {
  readonly opened: Emitter<vscode.TextDocument>;
  pending: boolean;
}

export class ExtHostDocuments extends Disposable {
  private readonly extensionIds = new Map<string, string>();
  private readonly markdownlintRefresh = new Map<string, MarkdownlintRefresh>();
  private readonly markdownlint = new ExtHostMarkdownlintDocuments();
  private readonly documents = new Map<string, ExtHostDocumentData>();
  private readonly byResource = new Map<string, string>();
  private readonly subscriptions = new Map<string, DisposableStore>();
  private readonly providers = new Map<number, { extension: string; provider: vscode.TextDocumentContentProvider }>();
  private nextProvider = 0;
  private readonly opened = this._register(new Emitter<vscode.TextDocument>());
  private readonly closed = this._register(new Emitter<vscode.TextDocument>());
  private readonly changed = this._register(new Emitter<vscode.TextDocumentChangeEvent>());
  private readonly saved = this._register(new Emitter<vscode.TextDocument>());
  private readonly saveParticipant = this._register(new ExtHostDocumentSaveParticipant());

  constructor(
    readonly proxy: MainThreadDocumentsShape,
    private readonly isLive: (key: string) => boolean,
    private readonly visibleDocuments: () => readonly vscode.TextDocument[] = () => [],
  ) {
    super();
  }

  associateExtension(extension: HostExtensionDescription): void {
    this.extensionIds.set(extension.key, extension.id.toLowerCase());
    this.markdownlintRefresh.get(extension.key)?.opened.dispose();
    this.markdownlintRefresh.delete(extension.key);
    if (usesMarkdownlintDocumentAliases(extension)) {
      this.markdownlintRefresh.set(extension.key, { opened: new Emitter(), pending: false });
    }
  }

  documentFor(extension: string, document: vscode.TextDocument): vscode.TextDocument {
    return this.markdownlintRefresh.has(extension) ? this.markdownlint.document(document) : document;
  }

  editorFor(extension: string, editor: vscode.TextEditor): vscode.TextEditor {
    return this.markdownlintRefresh.has(extension) ? this.markdownlint.editor(editor) : editor;
  }

  documentResource(extension: string, uri: vscode.Uri): vscode.Uri {
    return this.markdownlintRefresh.has(extension) ? this.markdownlint.resource(uri) : uri;
  }

  refreshMarkdownlintDocuments(extension: string): void {
    const refresh = this.markdownlintRefresh.get(extension);
    if (!refresh || refresh.pending) return;

    // A collection reset tells us markdownlint is rebuilding its diagnostics. Its synchronous
    // scan covers real TextEditors. Revisit the other open manuscripts after that scan starts.
    refresh.pending = true;
    queueMicrotask(() => {
      if (this.markdownlintRefresh.get(extension) !== refresh) return;
      refresh.pending = false;
      if (!this.isLive(extension)) return;

      const visible = new Set(this.visibleDocuments());
      for (const { document } of this.documents.values()) {
        if (document.uri.scheme === 'manuscript' && !visible.has(document)) {
          refresh.opened.fire(document);
        }
      }
    });
  }

  canRead(extension: string, document: vscode.TextDocument): boolean {
    const { scheme, path } = document.uri;
    if (scheme !== Schemas.vscodeUserData || path === '/User/settings.json'
      || path === '/extensions' || path.startsWith('/extensions/')) {
      return true;
    }
    const owner = this.extensionIds.get(extension);
    const [, user, area, first, second] = path.split('/');
    return owner !== undefined && user === 'User'
      && ((area === 'globalStorage' && first === owner) || (area === 'workspaceStorage' && second === owner));
  }

  allFor(extension: string): readonly vscode.TextDocument[] {
    return [...this.documents.values()].map(data => data.document)
      .filter(document => this.canRead(extension, document)).map(document => this.documentFor(extension, document));
  }

  get(id: string): vscode.TextDocument | undefined {
    return this.documents.get(id)?.document;
  }

  getByUri(uri: vscode.Uri): vscode.TextDocument | undefined {
    const id = this.byResource.get(uri.toString());
    return id === undefined ? undefined : this.get(id);
  }

  getId(extension: string, document: vscode.TextDocument): string | undefined {
    const uri = this.documentResource(extension, document.uri);
    const id = this.byResource.get(uri.toString());
    const original = id === undefined ? undefined : this.get(id);
    return original && (original === document || this.documentFor(extension, original) === document) ? id : undefined;
  }

  async open(extension: string, target?: string | vscode.Uri | OpenDocumentOptions): Promise<vscode.TextDocument> {
    const resource = typeof target === 'string' ? URI.file(target)
      : URI.isUri(target) ? this.documentResource(extension, target as unknown as vscode.Uri) : target;
    const id = await this.proxy.$openDocument(extension, resource as URI | OpenDocumentOptions ?? {});
    const document = this.get(id);
    if (!document) {
      throw new Error('The text document is no longer available.');
    }
    return this.documentFor(extension, document);
  }

  async setLanguage(extension: string, document: vscode.TextDocument, language: string): Promise<vscode.TextDocument> {
    const id = this.getId(extension, document);
    if (id === undefined || !this.canRead(extension, document)) {
      throw new Error('The text document is no longer available.');
    }
    await this.proxy.$setDocumentLanguage(extension, id, language);
    return document;
  }

  private own(extension: string, disposable: vscode.Disposable): ApiDisposable {
    let store = this.subscriptions.get(extension);
    if (!store) {
      this.subscriptions.set(extension, store = new DisposableStore());
    }
    store.add(disposable);
    return new ApiDisposable(() => store.delete(disposable));
  }

  event<T>(
    extension: string, event: vscode.Event<T>, filter: (value: T) => boolean = () => true, project?: (value: T) => T,
  ): vscode.Event<T> {
    return (listener, thisArg, disposables) => {
      const registration = this.own(extension, event(value => {
        if (this.isLive(extension) && filter(value)) {
          listener.call(thisArg, project ? project(value) : value);
        }
      }));
      disposables?.push(registration);
      return registration;
    };
  }

  events(extension: string, id: string) {
    const readable = (document: vscode.TextDocument) => this.canRead(extension, document);
    const view = (document: vscode.TextDocument) => this.documentFor(extension, document);
    const viewEvent = <T extends { document: vscode.TextDocument }>(event: T): T => {
      const document = view(event.document);
      return document === event.document ? event : { ...event, document };
    };
    const refresh = this.markdownlintRefresh.get(extension);
    const opened = refresh ? Event.any(this.opened.event, refresh.opened.event) : this.opened.event;
    return {
      onDidOpenTextDocument: this.event(extension, opened, readable, view),
      onDidCloseTextDocument: this.event(extension, this.closed.event, readable, view),
      onDidChangeTextDocument: this.event(extension, this.changed.event, event => readable(event.document), viewEvent),
      onDidSaveTextDocument: this.event(extension, this.saved.event, readable, view),
      onWillSaveTextDocument: this.event(extension, this.saveParticipant.event(extension, id), event => readable(event.document), viewEvent),
    };
  }

  registerProvider(extension: string, scheme: string, provider: vscode.TextDocumentContentProvider): vscode.Disposable {
    if (!/^[a-z][a-z\d.+-]*$/.test(scheme) || typeof provider?.provideTextDocumentContent !== 'function') {
      throw new TypeError('A document provider needs a valid scheme and a content function.');
    }
    const handle = ++this.nextProvider;
    const changes = provider.onDidChange?.(uri => {
      if (this.providers.has(handle) && URI.isUri(uri) && uri.scheme === scheme) {
        void this.proxy.$updateProvidedContent(extension, handle, uri).catch(console.error);
      }
    });
    this.providers.set(handle, { extension, provider });
    void this.proxy.$registerContentProvider(extension, handle, scheme).catch(error => {
      this.providers.delete(handle);
      changes?.dispose();
      console.error(error);
    });
    return this.own(extension, new ApiDisposable(() => {
      changes?.dispose();
      if (this.providers.delete(handle)) {
        void this.proxy.$unregisterContentProvider(extension, handle).catch(() => {});
      }
    }));
  }

  release(extension: string): void {
    this.subscriptions.get(extension)?.dispose();
    this.subscriptions.delete(extension);
    this.extensionIds.delete(extension);
    this.markdownlintRefresh.get(extension)?.opened.dispose();
    this.markdownlintRefresh.delete(extension);
  }

  override dispose(): void {
    for (const extension of this.subscriptions.keys()) {
      this.release(extension);
    }
    for (const data of this.documents.values()) {
      data.close();
    }
    this.extensionIds.clear();
    for (const refresh of this.markdownlintRefresh.values()) refresh.opened.dispose();
    this.markdownlintRefresh.clear();
    this.documents.clear();
    this.byResource.clear();
    super.dispose();
  }

  async $acceptDocumentDelta({ added = [], removed = [] }: DocumentDelta): Promise<void> {
    for (const id of removed) {
      const data = this.documents.get(id);
      if (data) {
        this.documents.delete(id);
        this.byResource.delete(data.document.uri.toString());
        data.close();
        this.closed.fire(data.document);
      }
    }
    for (const snapshot of added) {
      const { id, uri } = snapshot;
      const data = new ExtHostDocumentData(snapshot, () => this.proxy.$saveDocument(id));
      this.documents.set(id, data);
      this.byResource.set(uri.toString(), id);
      this.opened.fire(data.document);
    }
  }

  async $acceptDocumentChanges(id: string, changes: IModelContentChangedEvent, dirty: boolean): Promise<void> {
    const data = this.documents.get(id);
    if (data) {
      data.acceptChanges(changes, dirty);
      this.changed.fire({
        document: data.document,
        contentChanges: changes.changes.map(change => ({ ...change, range: fromModelRange(change.range) })),
        reason: changes.isUndoing ? TextDocumentChangeReason.Undo
          : changes.isRedoing ? TextDocumentChangeReason.Redo : undefined,
      });
    }
  }

  async $acceptDocumentLanguage(id: string, language: string): Promise<void> {
    const data = this.documents.get(id);
    if (data && data.document.languageId !== language) {
      this.closed.fire(data.document);
      data.setLanguage(language);
      this.opened.fire(data.document);
    }
  }

  async $acceptDocumentDirty(id: string, dirty: boolean): Promise<void> {
    const data = this.documents.get(id);
    if (data && data.document.isDirty !== dirty) {
      data.setDirty(dirty);
      this.changed.fire({ document: data.document, contentChanges: [], reason: undefined });
    }
  }

  async $acceptDocumentSaved(id: string): Promise<void> {
    const document = this.get(id);
    if (document) {
      this.saved.fire(document);
    }
  }

  async $participateInSave(id: string, save: number, deadline: number, reason: TextDocumentSaveReason, token: CancellationToken): Promise<void> {
    const document = this.get(id);
    if (document) {
      await this.saveParticipant.participate(document, reason, deadline, token, (extension, version, edit) =>
        this.proxy.$applySaveEdits(extension, save, version, edit));
    }
  }

  async $provideDocumentContent(extension: string, handle: number, uri: URI, token: CancellationToken): Promise<string | undefined> {
    const entry = this.providers.get(handle);
    if (entry?.extension !== extension || token.isCancellationRequested || !this.isLive(extension)) {
      return undefined;
    }
    return (await entry.provider.provideTextDocumentContent(uri as unknown as vscode.Uri, token)) ?? undefined;
  }
}
