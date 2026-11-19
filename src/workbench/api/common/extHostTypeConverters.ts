import type * as vscode from 'vscode';
import { Position, Range, Selection, TextEdit } from './extHostEditorTypes.js';
import type { WorkspaceEdit } from './extHostEditorTypes.js';

export interface EditorPosition { readonly lineNumber: number; readonly column: number }

export interface EditorRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface EditorSelection extends EditorRange {
  readonly selectionStartLineNumber: number;
  readonly selectionStartColumn: number;
  readonly positionLineNumber: number;
  readonly positionColumn: number;
}

export interface EditorTextEdit {
  readonly range: EditorRange;
  readonly text: string;
  readonly eol?: 1 | 2;
}

export function positionToEditor(position: vscode.Position): EditorPosition {
  return { lineNumber: position.line + 1, column: position.character + 1 };
}

export function positionFromEditor(position: EditorPosition): Position {
  return new Position(position.lineNumber - 1, position.column - 1);
}

export function rangeToEditor(range: vscode.Range): EditorRange {
  return {
    startLineNumber: range.start.line + 1, startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1, endColumn: range.end.character + 1,
  };
}

export function rangeFromEditor(range: EditorRange): Range {
  return new Range(range.startLineNumber - 1, range.startColumn - 1, range.endLineNumber - 1, range.endColumn - 1);
}

export function selectionToEditor(selection: vscode.Selection): EditorSelection {
  return {
    ...rangeToEditor(selection),
    selectionStartLineNumber: selection.anchor.line + 1, selectionStartColumn: selection.anchor.character + 1,
    positionLineNumber: selection.active.line + 1, positionColumn: selection.active.character + 1,
  };
}

export function selectionFromEditor(selection: EditorSelection): Selection {
  return new Selection(
    selection.selectionStartLineNumber - 1, selection.selectionStartColumn - 1,
    selection.positionLineNumber - 1, selection.positionColumn - 1,
  );
}

export function textEditToEditor(edit: vscode.TextEdit): EditorTextEdit {
  return { range: rangeToEditor(edit.range), text: edit.newText, eol: edit.newEol };
}

export function textEditFromEditor(edit: EditorTextEdit): TextEdit {
  const result = new TextEdit(rangeFromEditor(edit.range), edit.text);
  result.newEol = edit.eol;
  return result;
}

export function markdownToDto(markdown: vscode.MarkdownString): Pick<vscode.MarkdownString,
  'value' | 'isTrusted' | 'supportThemeIcons' | 'supportHtml' | 'baseUri'> {
  return {
    value: markdown.value,
    isTrusted: markdown.isTrusted,
    supportThemeIcons: markdown.supportThemeIcons,
    supportHtml: markdown.supportHtml,
    baseUri: markdown.baseUri,
  };
}

export type WorkspaceEditOperation = ReturnType<WorkspaceEdit['getOperations']>[number];

export function workspaceEditToDto(edit: WorkspaceEdit) {
  return edit.getOperations().map(operation => {
    if (operation.kind === 'text') {
      const { edit, ...rest } = operation;
      return { ...rest, edit: textEditToEditor(edit) };
    }
    if (operation.kind === 'snippet') {
      const { edit, ...rest } = operation;
      return {
        ...rest,
        edit: {
          range: rangeToEditor(edit.range), snippet: edit.snippet.value, keepWhitespace: edit.keepWhitespace,
        },
      };
    }
    return operation;
  });
}
