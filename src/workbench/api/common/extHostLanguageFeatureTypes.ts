import type * as vscode from 'vscode';

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
