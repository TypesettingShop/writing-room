import type * as vscode from 'vscode';
import type { IModelContentChangedEvent, IRange } from '../../../editor/common/model.js';
import { EndOfLine, Position, Range } from './extHostEditorTypes.js';
import type { DocumentSnapshot } from './extHost.protocol.documents.js';
import { languageWordPattern } from './extHostLanguageWordPatterns.js';

export function fromModelRange(range: IRange): Range {
  return new Range(range.startLineNumber - 1, range.startColumn - 1, range.endLineNumber - 1, range.endColumn - 1);
}

const defaultWord = /[\p{L}\p{N}]+/gu;

export class ExtHostDocumentData {
  private lines: string[];
  private separator: string;
  private version: number;
  private language: string;
  private dirty: boolean;
  private closed = false;
  private starts: number[] | undefined;
  readonly document: vscode.TextDocument;

  constructor(snapshot: DocumentSnapshot, save: () => Promise<boolean>) {
    this.lines = snapshot.lines;
    this.separator = snapshot.eol;
    this.version = snapshot.version;
    this.language = snapshot.language;
    this.dirty = snapshot.dirty;

    const data = this;
    const uri = snapshot.uri;
    this.document = Object.freeze({
      uri,
      get fileName() { return uri.fsPath; },
      get isUntitled() { return uri.scheme === 'untitled'; },
      get languageId() { return data.language; },
      encoding: 'utf8',
      get version() { return data.version; },
      get isDirty() { return data.dirty; },
      get isClosed() { return data.closed; },
      get eol() { return data.separator === '\n' ? EndOfLine.LF : EndOfLine.CRLF; },
      get lineCount() { return data.lines.length; },
      save: () => data.closed ? Promise.resolve(false) : save(),
      lineAt: (line: number | vscode.Position) => data.lineAt(typeof line === 'number' ? line : line.line),
      getText: (range?: vscode.Range) => data.getText(range),
      positionAt: (offset: number) => data.positionAt(offset),
      offsetAt: (position: vscode.Position) => data.offsetAt(position),
      validatePosition: (position: vscode.Position) => data.validatePosition(position),
      validateRange: (range: vscode.Range) => data.validateRange(range),
      getWordRangeAtPosition: (position: vscode.Position, regex?: RegExp) => data.wordRange(position, regex),
    });
  }

  setLanguage(language: string): void { this.language = language; }
  setDirty(dirty: boolean): void { this.dirty = dirty; }
  close(): void {
    this.closed = true;
    this.dirty = false;
  }

  acceptChanges(event: IModelContentChangedEvent, dirty: boolean): void {
    for (const { range, text } of event.changes) {
      const first = range.startLineNumber - 1;
      const last = range.endLineNumber - 1;
      const before = this.lines[first].slice(0, range.startColumn - 1);
      const after = this.lines[last].slice(range.endColumn - 1);
      const inserted = text.split(/\r\n|\r|\n/);
      inserted[0] = before + inserted[0];
      inserted[inserted.length - 1] += after;
      if (event.isFlush || inserted.length > 8192) {
        this.lines = this.lines.slice(0, first).concat(inserted, this.lines.slice(last + 1));
      } else {
        this.lines.splice(first, last - first + 1, ...inserted);
      }
    }
    this.separator = event.eol;
    this.version = event.versionId;
    this.dirty = dirty;
    this.starts = undefined;
  }

  private lineAt(lineNumber: number): vscode.TextLine {
    const text = this.lines[lineNumber];
    if (!Number.isInteger(lineNumber) || text === undefined) {
      throw new RangeError('Illegal value for line');
    }
    const range = new Range(lineNumber, 0, lineNumber, text.length);
    const first = text.search(/\S/u);
    return Object.freeze({
      lineNumber, text, range,
      rangeIncludingLineBreak: lineNumber + 1 === this.lines.length ? range : new Range(lineNumber, 0, lineNumber + 1, 0),
      firstNonWhitespaceCharacterIndex: first < 0 ? text.length : first,
      isEmptyOrWhitespace: first < 0,
    });
  }

  private validatePosition(position: vscode.Position): Position {
    const last = this.lines.length - 1;
    if (position.line < 0) {
      return new Position(0, 0);
    }
    if (position.line > last) {
      return new Position(last, this.lines[last].length);
    }
    const line = Math.floor(position.line);
    const character = Math.max(0, Math.min(Math.floor(position.character), this.lines[line].length));
    return position instanceof Position && line === position.line && character === position.character
      ? position : new Position(line, character);
  }

  private validateRange(range: vscode.Range): Range {
    const start = this.validatePosition(range.start);
    const end = this.validatePosition(range.end);
    return range instanceof Range && start === range.start && end === range.end ? range : new Range(start, end);
  }

  private getText(range?: vscode.Range): string {
    if (!range) {
      return this.lines.join(this.separator);
    }
    const { start, end } = this.validateRange(range);
    if (start.line === end.line) {
      return this.lines[start.line].slice(start.character, end.character);
    }
    return [this.lines[start.line].slice(start.character), ...this.lines.slice(start.line + 1, end.line),
      this.lines[end.line].slice(0, end.character)].join(this.separator);
  }

  private get lineStarts(): number[] {
    return this.starts ??= this.lines.reduce<number[]>((starts, line) => {
      starts.push(starts[starts.length - 1] + line.length + this.separator.length);
      return starts;
    }, [0]);
  }

  private offsetAt(position: vscode.Position): number {
    const { line, character } = this.validatePosition(position);
    return this.lineStarts[line] + character;
  }

  private positionAt(offset: number): Position {
    const starts = this.lineStarts;
    offset = Math.max(0, Math.floor(offset) || 0);
    let low = 0;
    let high = this.lines.length;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= offset) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return new Position(low, Math.min(this.lines[low].length, offset - starts[low]));
  }

  private wordRange(position: vscode.Position, pattern?: RegExp): Range | undefined {
    const { line, character } = this.validatePosition(position);
    // The language's configured word pattern, else the default (wr-c9d8: `setLanguageConfiguration`).
    const source = pattern ?? languageWordPattern(this.language) ?? defaultWord;
    const regex = new RegExp(source.source, source.flags.replace(/[gy]/g, '') + 'g');
    if (regex.test('')) {
      return pattern ? this.wordRange(position) : undefined;
    }
    const start = Math.max(0, character - 1000);
    const text = this.lines[line].slice(start, character + 1000);
    const cursor = character - start;
    const deadline = performance.now() + 20;
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match && match.index <= cursor; match = regex.exec(text)) {
      const end = match.index + match[0].length;
      if (match[0] && end >= cursor) {
        return new Range(line, start + match.index, line, start + end);
      }
      if (!match[0]) {
        // A lookaround may match an empty string only in a particular context.
        return pattern ? this.wordRange(position) : undefined;
      }
      if (performance.now() >= deadline) {
        break;
      }
    }
    return undefined;
  }
}
