import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../editor/browser/services/codeEditorService.js';
import { loadMonaco } from '../../../editor/browser/monaco.js';
import type { IRange } from '../../../editor/common/model.js';
import type { IEditorPane } from '../../common/editor.js';
import { columnToEditorGroup, editorGroupToColumn } from '../../services/editor/common/editorGroupColumn.js';
import { GroupsOrder, IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import type { IEditorGroup } from '../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { DEFAULT_EDITOR_ID } from '../../services/editor/common/editorResolverService.js';
import type {
  DocumentEdit, EditorOptions, EditorSelection, EditorShowOptions, EditorUndoOptions, ExtHostEditorsShape, MainThreadEditorsShape,
} from '../common/extHost.protocol.documents.js';
import { MainThreadDocuments } from './mainThreadDocuments.js';
import { validateDocumentEdit, validateModelRange } from './mainThreadDocumentEdits.js';
import { editorStyles, MainThreadEditor } from './mainThreadEditor.js';
import type { EditorSnippetController } from './mainThreadEditor.js';

export function paneControl(pane: IEditorPane | undefined): ICodeEditor | undefined {
  return pane && 'getControl' in pane && typeof pane.getControl === 'function' ? pane.getControl() : undefined;
}

export function extensionEditorGroup(groups: IEditorGroupsService, column: number | undefined) {
  return columnToEditorGroup(groups, column !== undefined && column > 0 ? column - 1 : column);
}

function fixedSize(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 1
    ? Math.min(100, Math.floor(numeric)) : undefined;
}

export class MainThreadEditors extends Disposable implements MainThreadEditorsShape {
  private readonly controls = new Map<ICodeEditor, DisposableStore>();
  private readonly visible = new Map<ICodeEditor, MainThreadEditor>();
  private readonly entries = new Map<string, MainThreadEditor>();
  private visibleIds: string[] = [];
  private activeId: string | null = null;
  private nextId = 0;
  private pending = false;
  private stopped = false;

  constructor(
    private readonly proxy: ExtHostEditorsShape,
    private readonly documents: MainThreadDocuments,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @IEditorService private readonly service: IEditorService,
    @ICodeEditorService controls: ICodeEditorService,
  ) {
    super();
    this._register(documents.onDidChangeMirrors(() => this.schedule()));
    this._register(groups.onDidActiveEditorChange(() => this.schedule()));
    this._register(groups.onDidAddGroup(() => this.schedule()));
    this._register(groups.onDidRemoveGroup(() => this.schedule()));
    this._register(groups.onDidMoveGroup(() => this.schedule()));
    this._register(service.onDidVisibleEditorsChange(() => this.schedule()));
    this._register(controls.onCodeEditorAdd(control => this.watch(control)));
    this._register(controls.onCodeEditorRemove(control => {
      this.controls.get(control)?.dispose();
      this.controls.delete(control);
      this.schedule();
    }));
    for (const control of controls.listCodeEditors()) {
      this.watch(control);
    }
    this.update();
  }

  get(id: string): MainThreadEditor | undefined {
    const entry = this.entries.get(id);
    return entry && this.valid(entry) ? entry : undefined;
  }

  get active(): MainThreadEditor | undefined {
    return this.activeId === null ? undefined : this.get(this.activeId);
  }

  private valid(entry: MainThreadEditor): boolean {
    return entry.control.getModel() === entry.model && !entry.model.isDisposed() && this.documents.isMirrored(entry.model.id);
  }

  private editable(entry: MainThreadEditor): boolean {
    return !this.documents.isReadOnly(entry.model) && !entry.group.activeEditor?.isReadonly() && !entry.control.getRawOptions().readOnly;
  }

  private watch(control: ICodeEditor): void {
    const listeners = new DisposableStore();
    listeners.add(control.onDidChangeModel(() => this.schedule()));
    this.controls.set(control, listeners);
    this.schedule();
  }

  private schedule(): void {
    if (!this.pending) {
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        this.update();
      });
    }
  }

  private update(): void {
    if (this.stopped) {
      return;
    }
    const newVisible = new Map<ICodeEditor, MainThreadEditor>();
    const added = [];
    let active: string | null = null;
    for (const group of this.groups.getGroups(GroupsOrder.GRID_APPEARANCE)) {
      const pane = group.activeEditorPane;
      const control = paneControl(pane);
      const model = control?.getModel();
      if (!group.activeEditor || pane?.input !== group.activeEditor || !control || !this.controls.has(control)
        || !model || !this.documents.isMirrored(model.id)) {
        continue;
      }
      let entry = this.visible.get(control);
      if (entry?.model !== model) {
        entry = new MainThreadEditor(String(++this.nextId), control, model, group,
          () => editorGroupToColumn(this.groups, group) + 1, this.proxy);
        this.entries.set(entry.id, entry);
        added.push(entry.snapshot);
      } else {
        entry.schedule();
      }
      newVisible.set(control, entry);
      if (group === this.groups.activeGroup) {
        active = entry.id;
      }
    }
    const removed = [];
    for (const [control, entry] of this.visible) {
      if (newVisible.get(control) !== entry) {
        removed.push(entry.id);
        entry.dispose();
        this.entries.delete(entry.id);
      }
    }
    this.visible.clear();
    for (const [control, entry] of newVisible) {
      this.visible.set(control, entry);
    }
    const visible = [...this.visible.values()].map(entry => entry.id);
    if (added.length || removed.length || active !== this.activeId
      || visible.some((id, index) => id !== this.visibleIds[index]) || visible.length !== this.visibleIds.length) {
      this.activeId = active;
      this.visibleIds = visible;
      void this.proxy.$acceptEditorDelta({ added, removed, active, visible }).catch(() => {});
    }
  }

  async $showTextDocument(extension: string, target: string | URI, options: EditorShowOptions): Promise<string> {
    const id = typeof target === 'string' ? target : await this.documents.$openDocument(extension, target);
    const model = this.documents.getModel(id);
    if (!model) {
      throw new Error('The text document is no longer available.');
    }
    const resource = this.documents.authorizeResource(extension, URI.parse(model.uri.toString(), true), false);
    const group = extensionEditorGroup(this.groups, options.viewColumn);
    const showOptions = {
      override: DEFAULT_EDITOR_ID,
      preserveFocus: options.preserveFocus === true,
      selection: options.selection && validateModelRange(model, options.selection),
    };
    const existing = this.service.findEditors(resource)[0]?.editor;
    const pane = existing
      ? await this.service.openEditor(existing, showOptions, group)
      : await this.service.openEditor({ resource, options: showOptions }, group);
    this.update();
    const control = paneControl(pane);
    const editor = control && this.visible.get(control);
    if (!editor || editor.model !== model) {
      throw new Error('The resource could not be shown in a text editor.');
    }
    return editor.id;
  }

  async $setSelections(id: string, selections: EditorSelection[]): Promise<void> {
    const entry = this.get(id);
    if (!entry || !Array.isArray(selections) || !selections.length) {
      return;
    }
    const { Selection } = await loadMonaco();
    if (!this.valid(entry)) {
      return;
    }
    const validated = selections.map(selection => {
      const anchor = entry.model.validatePosition({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn });
      const active = entry.model.validatePosition({ lineNumber: selection.positionLineNumber, column: selection.positionColumn });
      return new Selection(anchor.lineNumber, anchor.column, active.lineNumber, active.column);
    });
    entry.control.setSelections(validated, 'api');
  }

  async $setOptions(id: string, options: EditorOptions): Promise<void> {
    const entry = this.get(id);
    if (!entry || !options || typeof options !== 'object') {
      return;
    }
    const current = entry.model.getOptions();
    const tabSize = fixedSize(options.tabSize);
    const indentSize = options.indentSize === 'tabSize' ? 'tabSize' : fixedSize(options.indentSize);
    const spaces = options.insertSpaces;
    const insertSpaces = typeof spaces === 'boolean' ? spaces : spaces === 'true' ? true : spaces === 'false' ? false : undefined;
    if (options.tabSize === 'auto' || spaces === 'auto') {
      entry.model.detectIndentation(insertSpaces ?? current.insertSpaces, tabSize ?? current.tabSize);
    }
    entry.model.updateOptions({
      ...(tabSize === undefined ? {} : { tabSize }),
      ...(indentSize === undefined ? {} : { indentSize }),
      ...(insertSpaces === undefined ? {} : { insertSpaces }),
    });
    entry.control.updateOptions(editorStyles(options.cursorStyle, options.lineNumbers));
  }

  async $revealRange(id: string, range: IRange, how: number): Promise<void> {
    const entry = this.get(id);
    if (!entry) {
      return;
    }
    const valid = validateModelRange(entry.model, range);
    switch (how) {
      case 0: entry.control.revealRange(valid, 1); break;
      case 1: entry.control.revealRangeInCenter(valid, 1); break;
      case 2: entry.control.revealRangeInCenterIfOutsideViewport(valid, 1); break;
      case 3: entry.control.revealRangeAtTop(valid, 1); break;
    }
  }

  async $applyEdits(id: string, version: number, edit: DocumentEdit, options: EditorUndoOptions): Promise<boolean> {
    const entry = this.get(id);
    if (!entry || !this.editable(entry) || entry.model.getVersionId() !== version) {
      return false;
    }
    try {
      const operations = validateDocumentEdit(entry.model, edit);
      if (options.undoStopBefore !== false) {
        entry.control.pushUndoStop();
      }
      if (edit.eol !== undefined) {
        entry.model.pushEOL(edit.eol === 1 ? 0 : 1);
      }
      const applied = !operations.length || entry.control.executeEdits('api', operations);
      if (options.undoStopAfter !== false) {
        entry.control.pushUndoStop();
      }
      return applied;
    } catch {
      return false;
    }
  }

  async $insertSnippet(id: string, version: number, snippet: string, ranges: IRange[] | undefined, options: EditorUndoOptions): Promise<boolean> {
    const entry = this.get(id);
    if (!entry || !this.editable(entry) || typeof snippet !== 'string') {
      return false;
    }
    try {
      const { Selection } = await loadMonaco();
      if (!this.valid(entry) || entry.model.getVersionId() !== version || !this.editable(entry)) {
        return false;
      }
      const controller = entry.control.getContribution<EditorSnippetController>('snippetController2');
      if (!controller || (ranges && !ranges.length)) {
        return false;
      }
      if (ranges) {
        const edits = validateDocumentEdit(entry.model, { operations: ranges.map(range => ({ range, text: snippet })) });
        entry.control.setSelections(edits.map(({ range }) =>
          new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn)), 'api');
      }
      controller.insert(snippet, {
        adjustWhitespace: options.keepWhitespace !== true,
        undoStopBefore: options.undoStopBefore !== false,
        undoStopAfter: options.undoStopAfter !== false,
      });
      return true;
    } catch {
      return false;
    }
  }

  async $showEditor(id: string, column?: number): Promise<void> {
    const editor = this.get(id);
    if (editor?.group.activeEditor) {
      await this.service.openEditor(editor.group.activeEditor, undefined, extensionEditorGroup(this.groups, column));
    }
  }

  async $hideEditor(id: string): Promise<void> {
    const editor = this.get(id);
    if (editor) {
      await editor.group.closeEditor();
    }
  }

  override dispose(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      entry.dispose();
    }
    for (const listener of this.controls.values()) {
      listener.dispose();
    }
    this.entries.clear();
    this.controls.clear();
    this.visible.clear();
    super.dispose();
  }
}
