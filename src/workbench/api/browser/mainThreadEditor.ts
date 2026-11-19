import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../editor/browser/services/codeEditorService.js';
import type { IMonacoTextModel } from '../../../editor/browser/monaco.js';
import type { IRange } from '../../../editor/common/model.js';
import type { IEditorGroup } from '../../services/editor/common/editorGroupsService.js';
import type { EditorProperties, EditorSnapshot, ExtHostEditorsShape } from '../common/extHost.protocol.documents.js';

const cursorStyles = ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'] as const;
const lineNumbers = ['off', 'on', 'relative', 'interval'] as const;
export type EditorUpdateOptions = Parameters<ICodeEditor['updateOptions']>[0];

export function editorStyles(cursor: unknown, numbers: unknown): EditorUpdateOptions {
  return {
    ...(typeof cursor === 'number' && cursorStyles[cursor - 1] ? { cursorStyle: cursorStyles[cursor - 1] } : {}),
    ...(typeof numbers === 'number' && lineNumbers[numbers] ? { lineNumbers: lineNumbers[numbers] } : {}),
  };
}

function rangeDto(range: IRange): IRange {
  return {
    startLineNumber: range.startLineNumber, startColumn: range.startColumn,
    endLineNumber: range.endLineNumber, endColumn: range.endColumn,
  };
}

export class MainThreadEditor extends Disposable {
  readonly decorations = this._register(new DisposableStore());
  private properties: EditorProperties;
  private pending = false;
  private selectionSource: string | undefined;
  private stopped = false;

  constructor(
    readonly id: string,
    readonly control: ICodeEditor,
    readonly model: IMonacoTextModel,
    readonly group: IEditorGroup,
    private readonly column: () => number,
    private readonly proxy: ExtHostEditorsShape,
  ) {
    super();
    this.properties = this.read();
    this._register(control.onDidChangeCursorSelection(event => {
      this.selectionSource = event.source;
      this.schedule();
    }));
    this._register(control.onDidScrollChange(() => this.schedule()));
    this._register(control.onDidLayoutChange(() => this.schedule()));
    this._register(control.onDidChangeConfiguration(() => this.schedule()));
    this._register(model.onDidChangeOptions(() => this.schedule()));
    this._register(model.onDidChangeContent(() => this.schedule()));
  }

  get snapshot(): EditorSnapshot {
    return { id: this.id, document: this.model.id, ...this.properties };
  }

  schedule(): void {
    if (!this.pending) {
      this.pending = true;
      queueMicrotask(() => this.refresh());
    }
  }

  private read(): EditorProperties {
    const { tabSize, indentSize, insertSpaces } = this.model.getOptions();
    const { cursorStyle, lineNumbers: numbers } = this.control.getRawOptions();
    return {
      selections: (this.control.getSelections() ?? []).map(selection => ({
        selectionStartLineNumber: selection.selectionStartLineNumber,
        selectionStartColumn: selection.selectionStartColumn,
        positionLineNumber: selection.positionLineNumber,
        positionColumn: selection.positionColumn,
      })),
      visibleRanges: this.control.getVisibleRanges().map(rangeDto),
      options: {
        tabSize, indentSize, insertSpaces,
        cursorStyle: cursorStyles.indexOf(cursorStyle ?? 'line') + 1,
        lineNumbers: Math.max(0, lineNumbers.indexOf(typeof numbers === 'string' ? numbers : 'on')),
      },
      viewColumn: this.column(),
    };
  }

  private refresh(): void {
    this.pending = false;
    if (this.stopped || this.control.getModel() !== this.model) {
      return;
    }
    const current = this.read();
    const old = this.properties;
    const modified = {
      ...(JSON.stringify(current.selections) !== JSON.stringify(old.selections) ? { selections: current.selections } : {}),
      ...(JSON.stringify(current.visibleRanges) !== JSON.stringify(old.visibleRanges) ? { visibleRanges: current.visibleRanges } : {}),
      ...(JSON.stringify(current.options) !== JSON.stringify(old.options) ? { options: current.options } : {}),
      ...(current.viewColumn !== old.viewColumn ? { viewColumn: current.viewColumn } : {}),
    };
    const source = this.selectionSource;
    this.selectionSource = undefined;
    this.properties = current;
    if (Object.keys(modified).length) {
      const kind = source === 'keyboard' ? 1 : source === 'mouse' ? 2 : source ? 3 : undefined;
      void this.proxy.$acceptEditorProperties(this.id, modified, kind).catch(() => {});
    }
  }

  override dispose(): void {
    this.stopped = true;
    super.dispose();
  }
}

export interface EditorSnippetController {
  dispose(): void;
  insert(snippet: string, options: {
    adjustWhitespace?: boolean;
    undoStopBefore?: boolean;
    undoStopAfter?: boolean;
  }): void;
}
