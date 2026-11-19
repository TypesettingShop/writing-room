import type { IRange, ISingleEditOperation, ITextModel } from '../../../editor/common/model.js';
import type { IMonacoTextModel } from '../../../editor/browser/monaco.js';
import type { DocumentEdit } from '../common/extHost.protocol.documents.js';

export function validateModelRange(model: ITextModel, range: IRange): IRange {
  const position = (line: number, column: number) => {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) {
      throw new TypeError('Invalid text range.');
    }
    if (line < 1) {
      return { line: 1, column: 1 };
    }
    const last = model.getLineCount();
    return line > last ? { line: last, column: model.getLineContent(last).length + 1 }
      : { line, column: Math.min(Math.max(1, column), model.getLineContent(line).length + 1) };
  };
  const start = position(range.startLineNumber, range.startColumn);
  const end = position(range.endLineNumber, range.endColumn);
  if (end.line < start.line || (end.line === start.line && end.column < start.column)) {
    throw new TypeError('Reversed text range.');
  }
  return { startLineNumber: start.line, startColumn: start.column, endLineNumber: end.line, endColumn: end.column };
}

export function validateDocumentEdit(model: ITextModel, edit: DocumentEdit): ISingleEditOperation[] {
  if (!Array.isArray(edit.operations) || (edit.eol !== undefined && edit.eol !== 1 && edit.eol !== 2)) {
    throw new TypeError('Invalid text edit.');
  }
  const operations = edit.operations.map((entry: ISingleEditOperation) => {
    if (entry.text !== null && typeof entry.text !== 'string') {
      throw new TypeError('Invalid replacement text.');
    }
    return { range: validateModelRange(model, entry.range), text: entry.text, forceMoveMarkers: entry.forceMoveMarkers === true };
  });
  const offsets = operations.map(({ range }) => ({
    start: model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
    end: model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }),
  })).sort((a, b) => a.start - b.start || a.end - b.end);
  if (offsets.some((offset, index) => index > 0 && offsets[index - 1].end > offset.start)) {
    throw new Error('Overlapping ranges are not allowed!');
  }
  return operations;
}

export function applyDocumentEdit(
  model: IMonacoTextModel, operations: ISingleEditOperation[], eol: DocumentEdit['eol'],
  undoStopBefore = true, undoStopAfter = true,
): void {
  if (undoStopBefore) {
    model.pushStackElement();
  }
  if (eol !== undefined) {
    model.pushEOL(eol === 1 ? 0 : 1);
  }
  if (operations.length) {
    model.pushEditOperations(null, operations, () => null);
  }
  if (undoStopAfter) {
    model.pushStackElement();
  }
}
