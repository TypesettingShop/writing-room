import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { promiseApiMethod } from './extHostApiRegistry.js';
import { toModelRange } from './extHost.protocol.documents.js';
import type { EditorDelta, EditorProperties, MainThreadEditorsShape } from './extHost.protocol.documents.js';
import type { ExtHostDocuments } from './extHostDocuments.js';
import type { ExtHostTextEditorDecorations } from './extHostTextEditorDecorations.js';
import { ExtHostTextEditor } from './extHostTextEditor.js';

export class ExtHostTextEditors extends Disposable {
  private readonly editors = new Map<string, ExtHostTextEditor>();
  private active: string | null = null;
  private visible: string[] = [];
  private readonly activeChanged = this._register(new Emitter<vscode.TextEditor | undefined>());
  private readonly visibleChanged = this._register(new Emitter<readonly vscode.TextEditor[]>());
  private readonly selectionChanged = this._register(new Emitter<vscode.TextEditorSelectionChangeEvent>());
  private readonly rangesChanged = this._register(new Emitter<vscode.TextEditorVisibleRangesChangeEvent>());
  private readonly optionsChanged = this._register(new Emitter<vscode.TextEditorOptionsChangeEvent>());
  private readonly columnChanged = this._register(new Emitter<vscode.TextEditorViewColumnChangeEvent>());

  constructor(
    private readonly proxy: MainThreadEditorsShape,
    private readonly documents: ExtHostDocuments,
    private readonly decorations: ExtHostTextEditorDecorations,
  ) { super(); }

  private get activeTextEditor(): vscode.TextEditor | undefined {
    return this.active === null ? undefined : this.editors.get(this.active)?.value;
  }

  get visibleTextEditors(): readonly vscode.TextEditor[] {
    return this.visible.flatMap(id => this.editors.get(id)?.value ?? []);
  }

  createApi(key: string) {
    const service = this;
    const readable = (editor: vscode.TextEditor) => this.documents.canRead(key, editor.document);
    const view = (editor: vscode.TextEditor) => this.documents.editorFor(key, editor);
    const viewEvent = <T extends { textEditor: vscode.TextEditor }>(event: T): T => {
      const textEditor = view(event.textEditor);
      return textEditor === event.textEditor ? event : { ...event, textEditor };
    };
    const getActive = () => {
      const editor = service.activeTextEditor;
      return editor && readable(editor) ? view(editor) : undefined;
    };
    const getVisible = () => service.visibleTextEditors.filter(readable).map(view);
    const onActive = this.documents.event(key, this.activeChanged.event);
    const onVisible = this.documents.event(key, this.visibleChanged.event);
    const onDidChangeActiveTextEditor: vscode.Event<vscode.TextEditor | undefined> = (listener, thisArg, store) => {
      let previous = getActive();
      return onActive(() => {
        const active = getActive();
        if (previous !== active) {
          previous = active;
          listener.call(thisArg, active);
        }
      }, undefined, store);
    };
    const onDidChangeVisibleTextEditors: vscode.Event<readonly vscode.TextEditor[]> = (listener, thisArg, store) => {
      let previous = getVisible();
      return onVisible(() => {
        const visible = getVisible();
        if (previous.length !== visible.length || previous.some((editor, index) => editor !== visible[index])) {
          previous = visible;
          listener.call(thisArg, visible);
        }
      }, undefined, store);
    };
    return {
      get activeTextEditor() { return getActive(); },
      get visibleTextEditors() { return getVisible(); },
      createTextEditorDecorationType: (options: vscode.DecorationRenderOptions) => this.decorations.create(key, options),
      onDidChangeActiveTextEditor,
      onDidChangeVisibleTextEditors,
      onDidChangeTextEditorSelection: this.documents.event(key, this.selectionChanged.event, event => readable(event.textEditor), viewEvent),
      onDidChangeTextEditorVisibleRanges: this.documents.event(key, this.rangesChanged.event, event => readable(event.textEditor), viewEvent),
      onDidChangeTextEditorOptions: this.documents.event(key, this.optionsChanged.event, event => readable(event.textEditor), viewEvent),
      onDidChangeTextEditorViewColumn: this.documents.event(key, this.columnChanged.event, event => readable(event.textEditor), viewEvent),
      showTextDocument: promiseApiMethod(async (
        document: vscode.TextDocument | vscode.Uri,
        column?: vscode.ViewColumn | vscode.TextDocumentShowOptions,
        preserveFocus?: boolean,
      ): Promise<vscode.TextEditor> => {
        const target = URI.isUri(document)
          ? this.documents.documentResource(key, document as unknown as vscode.Uri) as unknown as URI
          : this.documents.getId(key, document as vscode.TextDocument);
        if (target === undefined) {
          throw new Error('The text document is no longer available.');
        }
        const options = typeof column === 'number' ? { viewColumn: column, preserveFocus }
          : column ?? { preserveFocus };
        const id = await this.proxy.$showTextDocument(key, target, {
          viewColumn: options.viewColumn, preserveFocus: options.preserveFocus,
          selection: options.selection && toModelRange(options.selection),
        });
        const editor = this.editors.get(id);
        if (!editor) {
          throw new Error('The text editor is no longer available.');
        }
        return view(editor.value);
      }),
    };
  }

  async $acceptEditorDelta(delta: EditorDelta): Promise<void> {
    const active = this.activeTextEditor;
    const visible = this.visible;
    for (const id of delta.removed) {
      this.editors.get(id)?.close();
      this.editors.delete(id);
    }
    for (const snapshot of delta.added) {
      const document = this.documents.get(snapshot.document);
      if (document) {
        this.editors.set(snapshot.id, new ExtHostTextEditor(snapshot.id, this.proxy, document, snapshot, this.decorations));
      }
    }
    this.active = delta.active;
    this.visible = delta.visible;
    if (visible.length !== this.visible.length || visible.some((id, index) => id !== this.visible[index])) {
      this.visibleChanged.fire(this.visibleTextEditors);
    }
    if (active !== this.activeTextEditor) {
      this.activeChanged.fire(this.activeTextEditor);
    }
  }

  async $acceptEditorProperties(id: string, properties: Partial<EditorProperties>, kind?: vscode.TextEditorSelectionChangeKind): Promise<void> {
    const entry = this.editors.get(id);
    if (!entry) {
      return;
    }
    entry.accept(properties);
    const textEditor = entry.value;
    if (properties.selections) {
      this.selectionChanged.fire({ textEditor, selections: textEditor.selections, kind });
    }
    if (properties.visibleRanges) {
      this.rangesChanged.fire({ textEditor, visibleRanges: textEditor.visibleRanges });
    }
    if (properties.options) {
      this.optionsChanged.fire({ textEditor, options: entry.optionsSnapshot });
    }
    if (properties.viewColumn !== undefined) {
      this.columnChanged.fire({ textEditor, viewColumn: properties.viewColumn });
    }
  }

  override dispose(): void {
    for (const editor of this.editors.values()) {
      editor.close();
    }
    this.editors.clear();
    this.visible = [];
    this.active = null;
    super.dispose();
  }
}
