import type * as vscode from 'vscode';

export class Position implements vscode.Position {
  constructor(readonly line: number, readonly character: number) {
    if (line < 0) {
      throw new Error('Illegal argument: line must be non-negative');
    }
    if (character < 0) {
      throw new Error('Illegal argument: character must be non-negative');
    }
  }

  compareTo(other: Position): number {
    return Math.sign(this.line - other.line || this.character - other.character);
  }

  isBefore(other: Position): boolean { return this.compareTo(other) < 0; }
  isBeforeOrEqual(other: Position): boolean { return this.compareTo(other) <= 0; }
  isAfter(other: Position): boolean { return this.compareTo(other) > 0; }
  isAfterOrEqual(other: Position): boolean { return this.compareTo(other) >= 0; }
  isEqual(other: Position): boolean { return this.line === other.line && this.character === other.character; }

  translate(lineDelta?: number, characterDelta?: number): Position;
  translate(change: { lineDelta?: number; characterDelta?: number }): Position;
  translate(change?: number | { lineDelta?: number; characterDelta?: number }, characterDelta = 0): Position {
    if (change === null || characterDelta === null) {
      throw new Error('Illegal argument');
    }
    const line = typeof change === 'object' ? change.lineDelta ?? 0 : change ?? 0;
    const character = typeof change === 'object' ? change.characterDelta ?? 0 : characterDelta;
    return this.with(this.line + line, this.character + character);
  }

  with(line?: number, character?: number): Position;
  with(change: { line?: number; character?: number }): Position;
  with(change?: number | { line?: number; character?: number }, character = this.character): Position {
    if (change === null || character === null) {
      throw new Error('Illegal argument');
    }
    const nextLine = typeof change === 'object' ? change.line ?? this.line : change ?? this.line;
    const nextCharacter = typeof change === 'object' ? change.character ?? this.character : character;
    return nextLine === this.line && nextCharacter === this.character ? this : new Position(nextLine, nextCharacter);
  }
}

function positions(start: Position | number, end: Position | number, line?: number, character?: number): [Position, Position] {
  if (typeof start === 'number' && typeof end === 'number' && typeof line === 'number' && typeof character === 'number') {
    return [new Position(start, end), new Position(line, character)];
  }
  if (start && end && typeof start === 'object' && typeof end === 'object'
    && typeof start.line === 'number' && typeof start.character === 'number'
    && typeof end.line === 'number' && typeof end.character === 'number') {
    const position = (value: Pick<Position, 'line' | 'character'>) =>
      value instanceof Position ? value : new Position(value.line, value.character);
    return [position(start), position(end)];
  }
  throw new Error('Invalid arguments');
}

export class Range implements vscode.Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(start: Position | number, end: Position | number, endLine?: number, endCharacter?: number) {
    const [first, second] = positions(start, end, endLine, endCharacter);
    [this.start, this.end] = first.isBefore(second) ? [first, second] : [second, first];
  }

  get isEmpty(): boolean { return this.start.isEqual(this.end); }
  get isSingleLine(): boolean { return this.start.line === this.end.line; }

  contains(value: Position | Range): boolean {
    return 'start' in value
      ? this.contains(value.start) && this.contains(value.end)
      : this.start.isBeforeOrEqual(value) && this.end.isAfterOrEqual(value);
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }

  union(other: Range): Range {
    if (this.contains(other)) {
      return this;
    }
    if (other.contains(this)) {
      return other;
    }
    return new Range(this.start.isBefore(other.start) ? this.start : other.start, this.end.isAfter(other.end) ? this.end : other.end);
  }

  with(start?: Position, end?: Position): Range;
  with(change: { start?: Position; end?: Position }): Range;
  with(change?: Position | { start?: Position; end?: Position }, end = this.end): Range {
    if (change === null || end === null) {
      throw new Error('Illegal argument');
    }
    const start = change && 'line' in change ? change : change?.start ?? this.start;
    const nextEnd = change && !('line' in change) ? change.end ?? this.end : end;
    return this.start.isEqual(start) && this.end.isEqual(nextEnd) ? this : new Range(start, nextEnd);
  }
}

export class Selection extends Range implements vscode.Selection {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorCharacter: number, activeLine: number, activeCharacter: number);
  constructor(anchor: Position | number, active: Position | number, activeLine?: number, activeCharacter?: number) {
    const [first, second] = positions(anchor, active, activeLine, activeCharacter);
    super(first, second);
    this.anchor = first;
    this.active = second;
  }

  get isReversed(): boolean { return this.anchor === this.end; }
}

export class Location implements vscode.Location {
  range: Range;

  constructor(public uri: vscode.Uri, rangeOrPosition: Range | Position) {
    this.range = 'start' in rangeOrPosition ? rangeOrPosition : new Range(rangeOrPosition, rangeOrPosition);
  }
}

export enum EndOfLine { LF = 1, CRLF = 2 }

export class TextEdit implements vscode.TextEdit {
  newEol?: EndOfLine;

  constructor(public range: Range, public newText: string) {}

  static replace(range: Range, newText: string): TextEdit { return new TextEdit(range, newText); }
  static insert(position: Position, newText: string): TextEdit { return new TextEdit(new Range(position, position), newText); }
  static delete(range: Range): TextEdit { return new TextEdit(range, ''); }

  static setEndOfLine(eol: EndOfLine): TextEdit {
    const edit = new TextEdit(new Range(0, 0, 0, 0), '');
    edit.newEol = eol;
    return edit;
  }
}

export class SnippetString implements vscode.SnippetString {
  #nextTabstop = 1;

  constructor(public value = '') {}

  appendText(value: string): this {
    this.value += value.replace(/[$}\\]/g, '\\$&');
    return this;
  }

  appendTabstop(number = this.#nextTabstop++): this {
    this.value += '$' + number;
    return this;
  }

  appendPlaceholder(value: string | ((snippet: SnippetString) => unknown), number = this.#nextTabstop++): this {
    const text = typeof value === 'function' ? this.nested(value) : value.replace(/[$}\\]/g, '\\$&');
    this.value += '$' + '{' + number + ':' + text + '}';
    return this;
  }

  appendChoice(values: readonly string[], number = this.#nextTabstop++): this {
    const choices = values.map(value => value.replace(/[|,\\]/g, '\\$&')).join(',');
    this.value += '$' + '{' + number + '|' + choices + '|}';
    return this;
  }

  appendVariable(name: string, defaultValue?: string | ((snippet: SnippetString) => unknown)): this {
    const text = typeof defaultValue === 'function' ? this.nested(defaultValue) : defaultValue?.replace(/[$}]/g, '\\$&');
    this.value += '$' + '{' + name + (text ? ':' + text : '') + '}';
    return this;
  }

  private nested(build: (snippet: SnippetString) => unknown): string {
    const snippet = new SnippetString();
    snippet.#nextTabstop = this.#nextTabstop;
    build(snippet);
    this.#nextTabstop = snippet.#nextTabstop;
    return snippet.value;
  }
}

export class SnippetTextEdit implements vscode.SnippetTextEdit {
  keepWhitespace?: boolean;

  constructor(public range: Range, public snippet: vscode.SnippetString) {}

  static replace(range: Range, snippet: vscode.SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(range, snippet);
  }

  static insert(position: Position, snippet: vscode.SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(new Range(position, position), snippet);
  }
}

type FileCreateOptions = NonNullable<Parameters<vscode.WorkspaceEdit['createFile']>[1]>;
type FileDeleteOptions = NonNullable<Parameters<vscode.WorkspaceEdit['deleteFile']>[1]>;
type FileRenameOptions = NonNullable<Parameters<vscode.WorkspaceEdit['renameFile']>[2]>;
type Edit = vscode.TextEdit | vscode.SnippetTextEdit;
type Metadata = vscode.WorkspaceEditEntryMetadata;
type Operation = { readonly uri: vscode.Uri; readonly metadata?: Metadata } & (
  { readonly kind: 'text'; readonly edit: vscode.TextEdit }
  | { readonly kind: 'snippet'; readonly edit: vscode.SnippetTextEdit }
  | { readonly kind: 'create'; readonly options?: FileCreateOptions }
  | { readonly kind: 'delete'; readonly options?: FileDeleteOptions }
  | { readonly kind: 'rename'; readonly newUri: vscode.Uri; readonly options?: FileRenameOptions }
);

export class WorkspaceEdit implements vscode.WorkspaceEdit {
  private operations: Operation[] = [];

  get size(): number { return this.entries().length; }

  /** Used by the edit converter to preserve file, snippet and text operation order. */
  getOperations(): readonly Operation[] { return this.operations.slice(); }

  replace(uri: vscode.Uri, range: Range, newText: string, metadata?: Metadata): void {
    this.operations.push({ kind: 'text', uri, edit: TextEdit.replace(range, newText), metadata });
  }

  insert(uri: vscode.Uri, position: Position, newText: string, metadata?: Metadata): void {
    this.operations.push({ kind: 'text', uri, edit: TextEdit.insert(position, newText), metadata });
  }

  delete(uri: vscode.Uri, range: Range, metadata?: Metadata): void {
    this.operations.push({ kind: 'text', uri, edit: TextEdit.delete(range), metadata });
  }

  createFile(uri: vscode.Uri, options?: FileCreateOptions, metadata?: Metadata): void {
    this.operations.push({ kind: 'create', uri, options, metadata });
  }

  deleteFile(uri: vscode.Uri, options?: FileDeleteOptions, metadata?: Metadata): void {
    this.operations.push({ kind: 'delete', uri, options, metadata });
  }

  renameFile(oldUri: vscode.Uri, newUri: vscode.Uri, options?: FileRenameOptions, metadata?: Metadata): void {
    this.operations.push({ kind: 'rename', uri: oldUri, newUri, options, metadata });
  }

  set(uri: vscode.Uri, edits: readonly Edit[] | readonly [Edit, Metadata | undefined][]): void {
    if (edits == null) {
      const key = uri.toString();
      this.operations = this.operations.filter(operation => !('edit' in operation) || operation.uri.toString() !== key);
      return;
    }
    for (const entry of edits) {
      const [edit, metadata] = Array.isArray(entry) ? entry : [entry, undefined];
      this.operations.push('snippet' in edit ? { kind: 'snippet', uri, edit, metadata } : { kind: 'text', uri, edit, metadata });
    }
  }

  has(uri: vscode.Uri): boolean {
    return this.get(uri).length !== 0;
  }

  get(uri: vscode.Uri): vscode.TextEdit[] {
    const key = uri.toString();
    const edits: vscode.TextEdit[] = [];
    for (const operation of this.operations) {
      if (operation.kind === 'text' && operation.uri.toString() === key) {
        edits.push(operation.edit);
      }
    }
    return edits;
  }

  entries(): [vscode.Uri, vscode.TextEdit[]][] {
    const entries = new Map<string, [vscode.Uri, vscode.TextEdit[]]>();
    for (const operation of this.operations) {
      if (operation.kind !== 'text') {
        continue;
      }
      const key = operation.uri.toString();
      let entry = entries.get(key);
      if (!entry) {
        entry = [operation.uri, []];
        entries.set(key, entry);
      }
      entry[1].push(operation.edit);
    }
    return [...entries.values()];
  }
}

export enum ViewColumn {
  Active = -1, Beside = -2, One = 1, Two = 2, Three = 3, Four = 4, Five = 5, Six = 6, Seven = 7, Eight = 8, Nine = 9,
}
