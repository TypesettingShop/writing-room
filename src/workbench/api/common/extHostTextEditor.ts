import type * as vscode from 'vscode';
import type { ISingleEditOperation } from '../../../editor/common/model.js';
import { EndOfLine, Position, Range, Selection } from './extHostEditorTypes.js';
import type { ExtHostTextEditorDecorations } from './extHostTextEditorDecorations.js';
import { fromModelRange } from './extHostDocumentData.js';
import { toModelRange } from './extHost.protocol.documents.js';
import type {
  DocumentEdit, EditorProperties, EditorSelection, MainThreadEditorsShape,
} from './extHost.protocol.documents.js';

export enum TextEditorSelectionChangeKind { Keyboard = 1, Mouse = 2, Command = 3 }
export enum TextEditorCursorStyle { Line = 1, Block, Underline, LineThin, BlockOutline, UnderlineThin }
export enum TextEditorLineNumbersStyle { Off, On, Relative, Interval }
export enum TextEditorRevealType { Default, InCenter, InCenterIfOutsideViewport, AtTop }

/** The value the main thread stores for an option, when it stores the given one as it is. */
function settledOption(key: keyof vscode.TextEditorOptions, value: unknown): number | boolean | undefined {
  switch (key) {
    case 'tabSize':
    case 'indentSize': {
      const size = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
      return typeof size === 'number' && Number.isInteger(size) && size >= 1 && size <= 100 ? size : undefined;
    }
    case 'insertSpaces':
      return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : undefined;
    case 'cursorStyle':
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6 ? value : undefined;
    case 'lineNumbers':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : undefined;
  }
}

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

  /** Ends the callback's window; later builder calls throw. */
  close(): void {
    this.finalized = true;
  }

  finish(): DocumentEdit {
    this.close();
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

  constructor(readonly id: string, private readonly proxy: MainThreadEditorsShape, document: vscode.TextDocument,
    properties: EditorProperties, decorations: ExtHostTextEditorDecorations,
  ) {
    this.accept(properties);
    const editor = this;
    const keys = ['tabSize', 'indentSize', 'insertSpaces', 'cursorStyle', 'lineNumbers'] as const;
    const setOptions = (options: vscode.TextEditorOptions) => {
      if (!editor.closed) {
        void proxy.$setOptions(id, options).catch(() => {});
        // As VS Code: a value the main thread takes as it is reads back at once, not after a round trip.
        // 'auto' and the 'tabSize' indent size wait for the main thread's result.
        if (options && typeof options === 'object' && options.tabSize !== 'auto' && options.insertSpaces !== 'auto') {
          const settled: Record<string, unknown> = { ...editor._options };
          for (const key of keys) {
            const value = settledOption(key, options[key]);
            if (value !== undefined) {
              settled[key] = value;
            }
          }
          editor._options = settled as vscode.TextEditorOptions;
        }
      }
    };
    const options: vscode.TextEditorOptions = {};
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
          // As VS Code: the editor reads back what was set at once; the main thread's clamped result follows.
          editor._selections = Object.freeze([...value] as Selection[]);
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
          // As VS Code: a closed editor rejects instead of reporting an edit that did not apply.
          return Promise.reject(new Error('TextEditor#edit not possible on closed editors'));
        }
        const version = document.version;
        const builder = new TextEditorEdit(document);
        try {
          callback(builder);
        } finally {
          builder.close();
        }
        let edit: DocumentEdit;
        try {
          edit = builder.finish();
        } catch (error) {
          // As VS Code: an invalid edit rejects the returned thenable instead of throwing.
          return Promise.reject(error);
        }
        return proxy.$applyEdits(id, version, edit, options ?? {}).catch(() => false);
      },
      insertSnippet(snippet, location, options) {
        if (editor.closed) {
          return Promise.reject(new Error('TextEditor#insertSnippet not possible on closed editors'));
        }
        // As VS Code: no location, or an empty list of them, inserts at the selections.
        const locations = location === undefined || (Array.isArray(location) && !location.length) ? undefined
          : Array.isArray(location) ? location : [location];
        const ranges = locations?.map(part => toModelRange(document.validateRange(
          part instanceof Position ? new Range(part, part) : part,
        )));
        return proxy.$insertSnippet(id, document.version, snippet.value, ranges, options ?? {}).catch(() => false);
      },
      setDecorations(type, ranges) {
        if (!editor.closed) {
          decorations.set(id, type, ranges);
        }
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
