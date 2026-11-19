import type * as vscode from 'vscode';
import type { ISingleEditOperation } from '../../../editor/common/model.js';
import { EndOfLine, Position, Range, Selection } from './extHostEditorTypes.js';
import { fromModelRange } from './extHostDocumentData.js';
import { toModelRange } from './extHost.protocol.documents.js';
import type {
  DocumentEdit, EditorProperties, EditorSelection, MainThreadEditorsShape,
} from './extHost.protocol.documents.js';

export enum TextEditorSelectionChangeKind { Keyboard = 1, Mouse = 2, Command = 3 }
export enum TextEditorCursorStyle { Line = 1, Block, Underline, LineThin, BlockOutline, UnderlineThin }
export enum TextEditorLineNumbersStyle { Off, On, Relative, Interval }
export enum TextEditorRevealType { Default, InCenter, InCenterIfOutsideViewport, AtTop }

function selectionFromDto(value: EditorSelection): Selection {
  return new Selection(value.selectionStartLineNumber - 1, value.selectionStartColumn - 1,
    value.positionLineNumber - 1, value.positionColumn - 1);
}

function selectionToDto(selection: vscode.Selection): EditorSelection {
  if (!(selection instanceof Selection)) {
    throw new TypeError('Expected a Selection.');
  }
  return {
    selectionStartLineNumber: selection.anchor.line + 1,
    selectionStartColumn: selection.anchor.character + 1,
    positionLineNumber: selection.active.line + 1,
    positionColumn: selection.active.character + 1,
  };
}

class TextEditorEdit implements vscode.TextEditorEdit {
  private operations: ISingleEditOperation[] = [];
  private ranges: Range[] = [];
  private eol: EndOfLine | undefined;
  private finalized = false;

  constructor(private readonly document: vscode.TextDocument) {}

  replace(location: Position | Range | Selection, value: string): void {
    this.add(location instanceof Position ? new Range(location, location) : location, value, false);
  }

  insert(location: Position, value: string): void {
    this.add(new Range(location, location), value, true);
  }

  delete(location: Range | Selection): void {
    this.add(location, null, true);
  }

  setEndOfLine(endOfLine: EndOfLine): void {
    this.assertOpen();
    if (endOfLine !== EndOfLine.LF && endOfLine !== EndOfLine.CRLF) {
      throw new TypeError('Invalid end of line.');
    }
    this.eol = endOfLine;
  }

  private add(range: Range, text: string | null, forceMoveMarkers: boolean): void {
    this.assertOpen();
    if (!(range instanceof Range) || (typeof text !== 'string' && text !== null)) {
      throw new TypeError('Invalid text edit.');
    }
    const valid = this.document.validateRange(range) as Range;
    this.ranges.push(valid);
    this.operations.push({ range: toModelRange(valid), text, forceMoveMarkers });
  }

  private assertOpen(): void {
    if (this.finalized) {
      throw new Error('Edit is only valid while callback runs');
    }
  }

  finish(): DocumentEdit {
    this.finalized = true;
    const ordered = this.ranges.sort((a, b) => a.start.compareTo(b.start) || a.end.compareTo(b.end));
    if (ordered.some((range, index) => index > 0 && ordered[index - 1].end.isAfter(range.start))) {
      throw new Error('Overlapping ranges are not allowed!');
    }
    return { operations: this.operations, eol: this.eol };
  }
}

export class ExtHostTextEditor {
  private _selections: readonly Selection[] = [];
  private _visibleRanges: readonly Range[] = [];
  private _options: vscode.TextEditorOptions = {};
  private _viewColumn: vscode.ViewColumn | undefined;
  private closed = false;
  readonly value: vscode.TextEditor;

  constructor(readonly id: string, private readonly proxy: MainThreadEditorsShape, document: vscode.TextDocument, properties: EditorProperties) {
    this.accept(properties);
    const editor = this;
    const setOptions = (options: vscode.TextEditorOptions) => {
      if (!editor.closed) {
        void proxy.$setOptions(id, options).catch(() => {});
      }
    };
    const options: vscode.TextEditorOptions = {};
    const keys = ['tabSize', 'indentSize', 'insertSpaces', 'cursorStyle', 'lineNumbers'] as const;
    for (const key of keys) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => editor._options[key],
        set: (value: unknown) => setOptions({ [key]: value }),
      });
    }
    this.value = Object.freeze<vscode.TextEditor>({
      document,
      get selections() { return editor._selections; },
      set selections(value) {
        const selections = value.map(selectionToDto);
        if (!editor.closed && selections.length) {
          void proxy.$setSelections(id, selections).catch(() => {});
        }
      },
      get selection() { return editor._selections[0]; },
      set selection(value) { editor.value.selections = [value]; },
      get visibleRanges() { return editor._visibleRanges; },
      get options() { return options; },
      set options(value) { setOptions(value); },
      get viewColumn() { return editor._viewColumn; },
      edit(callback, options) {
        if (editor.closed) {
          return Promise.resolve(false);
        }
        const version = document.version;
        const builder = new TextEditorEdit(document);
        let edit: DocumentEdit;
        try {
          callback(builder);
        } finally {
          edit = builder.finish();
        }
        return proxy.$applyEdits(id, version, edit, options ?? {}).catch(() => false);
      },
      insertSnippet(snippet, location, options) {
        if (editor.closed) {
          return Promise.resolve(false);
        }
        const locations = location === undefined ? undefined : Array.isArray(location) ? location : [location];
        const ranges = locations?.map(part => toModelRange(document.validateRange(
          part instanceof Position ? new Range(part, part) : part,
        )));
        return proxy.$insertSnippet(id, document.version, snippet.value, ranges, options ?? {}).catch(() => false);
      },
      revealRange(range, revealType = TextEditorRevealType.Default) {
        if (!editor.closed) {
          void proxy.$revealRange(id, toModelRange(document.validateRange(range)), revealType).catch(() => {});
        }
      },
      show(column) {
        if (!editor.closed) {
          void proxy.$showEditor(id, column).catch(() => {});
        }
      },
      hide() {
        if (!editor.closed) {
          void proxy.$hideEditor(id).catch(() => {});
        }
      },
    });
  }

  accept(properties: Partial<EditorProperties>): void {
    if (properties.selections) {
      this._selections = Object.freeze(properties.selections.map(selectionFromDto));
    }
    if (properties.visibleRanges) {
      this._visibleRanges = Object.freeze(properties.visibleRanges.map(fromModelRange));
    }
    if (properties.options) {
      this._options = { ...properties.options };
    }
    if (properties.viewColumn !== undefined) {
      this._viewColumn = properties.viewColumn;
    }
  }

  get optionsSnapshot(): vscode.TextEditorOptions {
    return { ...this._options };
  }

  close(): void { this.closed = true; }
}
