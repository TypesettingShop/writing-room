import type * as vscode from 'vscode';
import { Location } from './extHostEditorTypes.js';

/*
 * The API classes and enums of the language feature groups. Each group exports the ones it adds
 * through its `types`. They are plain classes: extensions extend them (a language client's
 * `ProtocolCompletionItem extends CompletionItem`), so constructors keep the API's signatures and do
 * no more than store their arguments.
 */

// --- Completions, hover and signature help (wr-c9d8.w6j) -----------------------------------------

export enum CompletionItemKind {
  Text = 0, Method = 1, Function = 2, Constructor = 3, Field = 4, Variable = 5, Class = 6, Interface = 7,
  Module = 8, Property = 9, Unit = 10, Value = 11, Enum = 12, Keyword = 13, Snippet = 14, Color = 15,
  File = 16, Reference = 17, Folder = 18, EnumMember = 19, Constant = 20, Struct = 21, Event = 22,
  Operator = 23, TypeParameter = 24, User = 25, Issue = 26,
}

export enum CompletionItemTag { Deprecated = 1 }

export enum CompletionTriggerKind { Invoke = 0, TriggerCharacter = 1, TriggerForIncompleteCompletions = 2 }

export enum SignatureHelpTriggerKind { Invoke = 1, TriggerCharacter = 2, ContentChange = 3 }

export class CompletionItem implements vscode.CompletionItem {
  label: string | vscode.CompletionItemLabel;
  kind?: vscode.CompletionItemKind;
  tags?: readonly vscode.CompletionItemTag[];
  detail?: string;
  documentation?: string | vscode.MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | vscode.SnippetString;
  range?: vscode.Range | { inserting: vscode.Range; replacing: vscode.Range };
  commitCharacters?: string[];
  keepWhitespace?: boolean;
  textEdit?: vscode.TextEdit;
  additionalTextEdits?: vscode.TextEdit[];
  command?: vscode.Command;

  constructor(label: string | vscode.CompletionItemLabel, kind?: vscode.CompletionItemKind) {
    this.label = label;
    this.kind = kind;
  }
}

export class CompletionList<T extends vscode.CompletionItem = vscode.CompletionItem> implements vscode.CompletionList<T> {
  isIncomplete?: boolean;
  items: T[];

  constructor(items: T[] = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

export class Hover implements vscode.Hover {
  contents: Array<vscode.MarkdownString | vscode.MarkedString>;
  range?: vscode.Range;

  constructor(
    contents: vscode.MarkdownString | vscode.MarkedString | Array<vscode.MarkdownString | vscode.MarkedString>,
    range?: vscode.Range,
  ) {
    if (contents === undefined || contents === null) {
      throw new TypeError('A hover needs contents.');
    }
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

export class ParameterInformation implements vscode.ParameterInformation {
  label: string | [number, number];
  documentation?: string | vscode.MarkdownString;

  constructor(label: string | [number, number], documentation?: string | vscode.MarkdownString) {
    this.label = label;
    this.documentation = documentation;
  }
}

export class SignatureInformation implements vscode.SignatureInformation {
  label: string;
  documentation?: string | vscode.MarkdownString;
  parameters: vscode.ParameterInformation[] = [];
  activeParameter?: number;

  constructor(label: string, documentation?: string | vscode.MarkdownString) {
    this.label = label;
    this.documentation = documentation;
  }
}

export class SignatureHelp implements vscode.SignatureHelp {
  signatures: vscode.SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

// --- Formatting, code actions and rename (wr-c9d8.08x) -------------------------------------------

export enum CodeActionTriggerKind { Invoke = 1, Automatic = 2 }

export class CodeAction implements vscode.CodeAction {
  title: string;
  edit?: vscode.WorkspaceEdit;
  diagnostics?: vscode.Diagnostic[];
  command?: vscode.Command;
  kind?: vscode.CodeActionKind;
  isPreferred?: boolean;
  disabled?: { readonly reason: string };

  constructor(title: string, kind?: vscode.CodeActionKind) {
    this.title = title;
    this.kind = kind;
  }
}

// --- Navigation: symbols, links, definitions, folding and the like (wr-c9d8.rj2) ----------------

export enum SymbolKind {
  File = 0, Module = 1, Namespace = 2, Package = 3, Class = 4, Method = 5, Property = 6, Field = 7, Constructor = 8,
  Enum = 9, Interface = 10, Function = 11, Variable = 12, Constant = 13, String = 14, Number = 15, Boolean = 16,
  Array = 17, Object = 18, Key = 19, Null = 20, EnumMember = 21, Struct = 22, Event = 23, Operator = 24, TypeParameter = 25,
}

export enum SymbolTag { Deprecated = 1 }

export enum DocumentHighlightKind { Text = 0, Read = 1, Write = 2 }

export enum FoldingRangeKind { Comment = 1, Imports = 2, Region = 3 }

export enum InlayHintKind { Type = 1, Parameter = 2 }

function isPositionLike(value: unknown): value is vscode.Position {
  return !!value && typeof value === 'object' && typeof (value as vscode.Position).line === 'number'
    && typeof (value as vscode.Position).character === 'number';
}

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !name) {
    throw new Error('name must not be falsy');
  }
  return name;
}

export class SymbolInformation implements vscode.SymbolInformation {
  name: string;
  containerName: string;
  kind: vscode.SymbolKind;
  tags?: readonly vscode.SymbolTag[];
  location: vscode.Location;

  constructor(name: string, kind: vscode.SymbolKind, containerName: string, location: vscode.Location);
  constructor(name: string, kind: vscode.SymbolKind, range: vscode.Range, uri?: vscode.Uri, containerName?: string);
  constructor(name: string, kind: vscode.SymbolKind, rangeOrContainer: string | vscode.Range | undefined, locationOrUri?: vscode.Location | vscode.Uri, containerName?: string) {
    this.name = checkName(name);
    this.kind = kind;
    this.containerName = containerName ?? '';
    if (typeof rangeOrContainer === 'string') {
      this.containerName = rangeOrContainer;
    }
    if (locationOrUri && 'range' in locationOrUri && 'uri' in locationOrUri) {
      this.location = locationOrUri as vscode.Location;
    } else {
      this.location = new Location(locationOrUri as vscode.Uri, rangeOrContainer as vscode.Range);
    }
  }
}

export class DocumentSymbol implements vscode.DocumentSymbol {
  name: string;
  detail: string;
  kind: vscode.SymbolKind;
  tags?: readonly vscode.SymbolTag[];
  range: vscode.Range;
  selectionRange: vscode.Range;
  children: vscode.DocumentSymbol[] = [];

  constructor(name: string, detail: string, kind: vscode.SymbolKind, range: vscode.Range, selectionRange: vscode.Range) {
    this.name = checkName(name);
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
    if (range && selectionRange && typeof range.contains === 'function' && !range.contains(selectionRange)) {
      throw new Error('selectionRange must be contained in fullRange');
    }
  }
}

export class DocumentLink implements vscode.DocumentLink {
  range: vscode.Range;
  target?: vscode.Uri;
  tooltip?: string;

  constructor(range: vscode.Range, target?: vscode.Uri) {
    if (!range) {
      throw new TypeError('range must be set');
    }
    this.range = range;
    this.target = target;
  }
}

export class DocumentHighlight implements vscode.DocumentHighlight {
  range: vscode.Range;
  kind?: vscode.DocumentHighlightKind;

  constructor(range: vscode.Range, kind: vscode.DocumentHighlightKind = DocumentHighlightKind.Text) {
    this.range = range;
    this.kind = kind;
  }
}

export class FoldingRange implements vscode.FoldingRange {
  start: number;
  end: number;
  kind?: vscode.FoldingRangeKind;

  constructor(start: number, end: number, kind?: vscode.FoldingRangeKind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

export class SelectionRange implements vscode.SelectionRange {
  range: vscode.Range;
  parent?: vscode.SelectionRange;

  constructor(range: vscode.Range, parent?: vscode.SelectionRange) {
    this.range = range;
    this.parent = parent;
    if (parent && typeof parent.range?.contains === 'function' && !parent.range.contains(range)) {
      throw new Error('Invalid argument: parent must contain this range');
    }
  }
}

export class CodeLens implements vscode.CodeLens {
  range: vscode.Range;
  command?: vscode.Command;

  constructor(range: vscode.Range, command?: vscode.Command) {
    this.range = range;
    this.command = command;
  }

  get isResolved(): boolean {
    return !!this.command;
  }
}

export class Color implements vscode.Color {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;

  constructor(red: number, green: number, blue: number, alpha: number) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha;
  }
}

export class ColorInformation implements vscode.ColorInformation {
  range: vscode.Range;
  color: vscode.Color;

  constructor(range: vscode.Range, color: vscode.Color) {
    if (!color || typeof color !== 'object') {
      throw new TypeError('color must be a Color');
    }
    this.range = range;
    this.color = color;
  }
}

export class ColorPresentation implements vscode.ColorPresentation {
  label: string;
  textEdit?: vscode.TextEdit;
  additionalTextEdits?: vscode.TextEdit[];

  constructor(label: string) {
    if (!label || typeof label !== 'string') {
      throw new TypeError('label must be a non-empty string');
    }
    this.label = label;
  }
}

export class InlayHintLabelPart implements vscode.InlayHintLabelPart {
  value: string;
  tooltip?: string | vscode.MarkdownString;
  location?: vscode.Location;
  command?: vscode.Command;

  constructor(value: string) {
    this.value = value;
  }
}

export class InlayHint implements vscode.InlayHint {
  position: vscode.Position;
  label: string | vscode.InlayHintLabelPart[];
  tooltip?: string | vscode.MarkdownString;
  kind?: vscode.InlayHintKind;
  textEdits?: vscode.TextEdit[];
  paddingLeft?: boolean;
  paddingRight?: boolean;

  constructor(position: vscode.Position, label: string | vscode.InlayHintLabelPart[], kind?: vscode.InlayHintKind) {
    this.position = position;
    this.label = label;
    this.kind = kind;
  }
}

export class LinkedEditingRanges implements vscode.LinkedEditingRanges {
  readonly ranges: vscode.Range[];
  readonly wordPattern: RegExp | undefined;

  constructor(ranges: vscode.Range[], wordPattern?: RegExp) {
    this.ranges = ranges;
    this.wordPattern = wordPattern;
  }
}

export class SemanticTokensLegend implements vscode.SemanticTokensLegend {
  readonly tokenTypes: string[];
  readonly tokenModifiers: string[];

  constructor(tokenTypes: string[], tokenModifiers: string[] = []) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}

export class SemanticTokens implements vscode.SemanticTokens {
  readonly resultId: string | undefined;
  readonly data: Uint32Array;

  constructor(data: Uint32Array, resultId?: string) {
    this.resultId = resultId;
    this.data = data;
  }
}

export class SemanticTokensEdit implements vscode.SemanticTokensEdit {
  readonly start: number;
  readonly deleteCount: number;
  readonly data: Uint32Array | undefined;

  constructor(start: number, deleteCount: number, data?: Uint32Array) {
    this.start = start;
    this.deleteCount = deleteCount;
    this.data = data;
  }
}

export class SemanticTokensEdits implements vscode.SemanticTokensEdits {
  readonly resultId: string | undefined;
  readonly edits: vscode.SemanticTokensEdit[];

  constructor(edits: vscode.SemanticTokensEdit[], resultId?: string) {
    this.edits = edits;
    this.resultId = resultId;
  }
}

/** Builds the relative encoding of semantic tokens, as VS Code's builder: tokens pushed out of order are sorted. */
export class SemanticTokensBuilder implements vscode.SemanticTokensBuilder {
  private readonly tokens: number[] = [];
  private sorted = true;
  private readonly types = new Map<string, number>();
  private readonly modifiers = new Map<string, number>();
  private readonly hasLegend: boolean;

  constructor(legend?: vscode.SemanticTokensLegend) {
    this.hasLegend = !!legend;
    legend?.tokenTypes.forEach((type, index) => this.types.set(type, index));
    legend?.tokenModifiers.forEach((modifier, index) => this.modifiers.set(modifier, index));
  }

  push(line: number, char: number, length: number, tokenType: number, tokenModifiers?: number): void;
  push(range: vscode.Range, tokenType: string, tokenModifiers?: readonly string[]): void;
  push(first: number | vscode.Range, second: number | string, third?: number | readonly string[], fourth?: number, fifth?: number): void {
    if (typeof first === 'number') {
      if (typeof second !== 'number' || typeof third !== 'number' || typeof fourth !== 'number') {
        throw new Error('Illegal argument');
      }
      this.add(first, second, third, fourth, fifth ?? 0);
      return;
    }
    if (!first || !isPositionLike(first.start) || !isPositionLike(first.end) || typeof second !== 'string') {
      throw new Error('Illegal argument');
    }
    if (!this.hasLegend) {
      throw new Error('Legend must be provided in constructor');
    }
    if (first.start.line !== first.end.line) {
      throw new Error('`range` cannot span multiple lines');
    }
    const type = this.types.get(second);
    if (type === undefined) {
      throw new Error('`tokenType` is not in the provided legend');
    }
    let bits = 0;
    for (const modifier of (third as readonly string[] | undefined) ?? []) {
      const index = this.modifiers.get(modifier);
      if (index === undefined) {
        throw new Error('`tokenModifier` is not in the provided legend');
      }
      bits |= 1 << index;
    }
    this.add(first.start.line, first.start.character, first.end.character - first.start.character, type, bits);
  }

  private add(line: number, char: number, length: number, type: number, modifiers: number): void {
    const count = this.tokens.length / 5;
    if (count > 0) {
      const lastLine = this.tokens[(count - 1) * 5];
      const lastChar = this.tokens[(count - 1) * 5 + 1];
      if (line < lastLine || (line === lastLine && char < lastChar)) {
        this.sorted = false;
      }
    }
    this.tokens.push(line, char, length, type, modifiers);
  }

  build(resultId?: string): vscode.SemanticTokens {
    const count = this.tokens.length / 5;
    const order = [...Array(count).keys()];
    if (!this.sorted) {
      order.sort((a, b) => this.tokens[a * 5] - this.tokens[b * 5] || this.tokens[a * 5 + 1] - this.tokens[b * 5 + 1]);
    }
    const data = new Uint32Array(count * 5);
    let previousLine = 0;
    let previousChar = 0;
    order.forEach((token, index) => {
      const line = this.tokens[token * 5];
      const char = this.tokens[token * 5 + 1];
      data[index * 5] = line - previousLine;
      data[index * 5 + 1] = line === previousLine ? char - previousChar : char;
      data[index * 5 + 2] = this.tokens[token * 5 + 2];
      data[index * 5 + 3] = this.tokens[token * 5 + 3];
      data[index * 5 + 4] = this.tokens[token * 5 + 4];
      previousLine = line;
      previousChar = char;
    });
    return new SemanticTokens(data, resultId);
  }
}
