import type { IDisposable } from '../../base/common/lifecycle.js';

/** A position in a text model: 1-based line and column, as in Monaco. */
export interface IPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** A range in a text model, both ends 1-based and the end exclusive, as in Monaco. */
export interface IRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

/** One replacement: `text` takes the place of `range`. An empty range inserts, empty text deletes. */
export interface ISingleEditOperation {
  readonly range: IRange;
  readonly text: string | null;
  /** Monaco's flag; the workbench never sets it. */
  readonly forceMoveMarkers?: boolean;
}

/** One replaced range of a content change, in the coordinates before the change. */
export interface IModelContentChange {
  readonly range: IRange;
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

/**
 * What changed in a text model's content. The changes are ordered from the end of the document to the
 * start, so applying them in sequence to the old text gives the new text.
 */
export interface IModelContentChangedEvent {
  readonly changes: readonly IModelContentChange[];
  readonly eol: string;
  /** The version the model is at after this change. */
  readonly versionId: number;
  readonly isUndoing: boolean;
  readonly isRedoing: boolean;
  /** The whole text was replaced (`setValue`), so the changes say nothing finer. */
  readonly isFlush: boolean;
}

export interface IModelLanguageChangedEvent {
  readonly oldLanguage: string;
  readonly newLanguage: string;
}

/** Above this many UTF-16 code units the text is not sent to extensions (`TextModel._MODEL_SYNC_LIMIT`). */
export const MODEL_SYNC_LIMIT = 50 * 1024 * 1024;

/**
 * A text model as the workbench reads it outside the editor control. Monaco's text models have this
 * shape, which the type checker confirms where the model service hands them out; tests implement it
 * without Monaco. Nothing here names a Monaco type, so `common` code can hold one.
 */
export interface ITextModel {
  /** Prints as the resource the model was created for. */
  readonly uri: { toString(): string };
  /** Unique among the models of the page. */
  readonly id: string;
  /** Goes up with every change, undo and redo included. */
  getVersionId(): number;
  getValue(): string;
  getValueLength(): number;
  getValueInRange(range: IRange): string;
  setValue(value: string): void;
  getLineCount(): number;
  /** The line's text without its line break; `lineNumber` is 1-based. */
  getLineContent(lineNumber: number): string;
  getLinesContent(): string[];
  /** The line break the model writes: `\n` or `\r\n`. */
  getEOL(): string;
  getLanguageId(): string;
  getOffsetAt(position: IPosition): number;
  getPositionAt(offset: number): IPosition;
  /** Replaces the ranges in one change, without an undo stop or cursor state. */
  applyEdits(operations: readonly ISingleEditOperation[]): void;
  onDidChangeContent(listener: (event: IModelContentChangedEvent) => void): IDisposable;
  onDidChangeLanguage(listener: (event: IModelLanguageChangedEvent) => void): IDisposable;
  /** Fires once, right before the model is disposed. */
  onWillDispose(listener: () => void): IDisposable;
  isDisposed(): boolean;
  dispose(): void;
}

/** Whether `model` is too large to send to extensions; the document API leaves such a model out. */
export function isTooLargeForSyncing(model: ITextModel): boolean {
  return model.getValueLength() > MODEL_SYNC_LIMIT;
}

/** One edit of the differing span, in the model's EOL format, or no edit for identical text. */
export function getTextModelEdit(model: ITextModel, text: string): ISingleEditOperation | undefined {
  const next = text.replace(/\r\n|\r|\n/g, model.getEOL());
  const current = model.getValue();
  if (next === current) {
    return undefined;
  }
  const shorter = Math.min(current.length, next.length);
  let start = 0;
  while (start < shorter && current.charCodeAt(start) === next.charCodeAt(start)) {
    start++;
  }
  let suffix = 0;
  while (suffix < shorter - start && current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) {
    suffix++;
  }

  // A single Monaco position cannot represent the gap inside a CRLF.
  const splitsLineEnding = (value: string, offset: number) => value[offset - 1] === '\r' && value[offset] === '\n';
  if (splitsLineEnding(current, start) || splitsLineEnding(next, start)) {
    start--;
  }
  if (splitsLineEnding(current, current.length - suffix) || splitsLineEnding(next, next.length - suffix)) {
    suffix--;
  }
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(current.length - suffix);
  return {
    range: {
      startLineNumber: from.lineNumber, startColumn: from.column,
      endLineNumber: to.lineNumber, endColumn: to.column,
    },
    text: next.slice(start, next.length - suffix),
  };
}
