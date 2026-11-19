import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { promiseApiMethod } from './extHostApiRegistry.js';
import { toModelRange } from './extHost.protocol.documents.js';
import type { EditorDelta, EditorProperties, MainThreadEditorsShape } from './extHost.protocol.documents.js';
import type { ExtHostDocuments } from './extHostDocuments.js';
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

  constructor(private readonly proxy: MainThreadEditorsShape, private readonly documents: ExtHostDocuments) { super(); }

  private get activeTextEditor(): vscode.TextEditor | undefined {
    return this.active === null ? undefined : this.editors.get(this.active)?.value;
  }

  private get visibleTextEditors(): readonly vscode.TextEditor[] {
    return this.visible.flatMap(id => this.editors.get(id)?.value ?? []);
  }

  createApi(key: string) {
    const service = this;
    return {
      get activeTextEditor() { return service.activeTextEditor; },
      get visibleTextEditors() { return service.visibleTextEditors; },
      onDidChangeActiveTextEditor: this.documents.event(key, this.activeChanged.event),
      onDidChangeVisibleTextEditors: this.documents.event(key, this.visibleChanged.event),
      onDidChangeTextEditorSelection: this.documents.event(key, this.selectionChanged.event),
      onDidChangeTextEditorVisibleRanges: this.documents.event(key, this.rangesChanged.event),
      onDidChangeTextEditorOptions: this.documents.event(key, this.optionsChanged.event),
      onDidChangeTextEditorViewColumn: this.documents.event(key, this.columnChanged.event),
      showTextDocument: promiseApiMethod(async (
        document: vscode.TextDocument | vscode.Uri,
        column?: vscode.ViewColumn | vscode.TextDocumentShowOptions,
        preserveFocus?: boolean,
      ): Promise<vscode.TextEditor> => {
        const target = URI.isUri(document) ? document : this.documents.getId(document as vscode.TextDocument);
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
        return editor.value;
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
        this.editors.set(snapshot.id, new ExtHostTextEditor(snapshot.id, this.proxy, document, snapshot));
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
