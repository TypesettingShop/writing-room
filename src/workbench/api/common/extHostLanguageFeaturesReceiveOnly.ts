import type * as vscode from 'vscode';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { selectorToDto } from './extHostLanguageConverters.js';
import { Disposable } from './extHostTypes.js';
import type { ExtHostLanguageFeatures, LanguageFeatureGroup } from './extHostLanguageFeatures.js';

/*
 * Language features that are registered and kept, but never asked (wr-c9d8.kxn).
 *
 * Monaco's standalone editor has no screen for these (call and type hierarchy, inline values and
 * evaluatable expressions of a debugger, drop and paste edits, inline completions, range semantic
 * tokens, highlights across documents). An extension that registers one gets a disposable, and its
 * activation goes on; the provider is kept on the extension host as any registration is, and leaves with
 * the disposable or the extension's release. The workbench is not told: nothing would ask it.
 *
 * `receiveOnlyProviders` is the one list: the `languages` functions below are made from it, a unit test
 * checks it against the API, and the table of `docs/extension-api-language-features.md` follows it. To
 * give one of them a real implementation, take it out of the list and register it in a feature group.
 */

/** The `languages` functions that only receive, and the API classes their providers use. */
export const receiveOnlyProviders = [
  { name: 'registerCallHierarchyProvider', feature: 'Call hierarchy' },
  { name: 'registerTypeHierarchyProvider', feature: 'Type hierarchy' },
  { name: 'registerInlineValuesProvider', feature: 'Inline values (debugging)' },
  { name: 'registerEvaluatableExpressionProvider', feature: 'Evaluatable expressions (debugging)' },
  { name: 'registerDocumentDropEditProvider', feature: 'Drop into the editor' },
  { name: 'registerDocumentPasteEditProvider', feature: 'Paste with edits (Paste As)' },
  { name: 'registerInlineCompletionItemProvider', feature: 'Inline completions (ghost text)' },
  { name: 'registerDocumentRangeSemanticTokensProvider', feature: 'Semantic tokens of a visible range' },
  { name: 'registerMultiDocumentHighlightProvider', feature: 'Highlights across documents (proposed API)' },
] as const satisfies readonly { readonly name: keyof typeof vscode.languages; readonly feature: string }[];

export type ReceiveOnlyProviderName = (typeof receiveOnlyProviders)[number]['name'];

/** Where a receive-only provider is kept. */
class ReceiveOnlyAdapter {
  constructor(readonly name: ReceiveOnlyProviderName, readonly extension: HostExtensionDescription, readonly provider: unknown) {}
}

// --- API classes ---------------------------------------------------------------------------------

export class CallHierarchyItem implements vscode.CallHierarchyItem {
  name: string;
  kind: vscode.SymbolKind;
  tags?: readonly vscode.SymbolTag[];
  detail?: string;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;

  constructor(kind: vscode.SymbolKind, name: string, detail: string, uri: vscode.Uri, range: vscode.Range, selectionRange: vscode.Range) {
    this.kind = kind;
    this.name = name;
    this.detail = detail;
    this.uri = uri;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

export class CallHierarchyIncomingCall implements vscode.CallHierarchyIncomingCall {
  from: vscode.CallHierarchyItem;
  fromRanges: vscode.Range[];

  constructor(item: vscode.CallHierarchyItem, fromRanges: vscode.Range[]) {
    this.from = item;
    this.fromRanges = fromRanges;
  }
}

export class CallHierarchyOutgoingCall implements vscode.CallHierarchyOutgoingCall {
  to: vscode.CallHierarchyItem;
  fromRanges: vscode.Range[];

  constructor(item: vscode.CallHierarchyItem, fromRanges: vscode.Range[]) {
    this.to = item;
    this.fromRanges = fromRanges;
  }
}

export class TypeHierarchyItem implements vscode.TypeHierarchyItem {
  name: string;
  kind: vscode.SymbolKind;
  tags?: ReadonlyArray<vscode.SymbolTag>;
  detail?: string;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;

  constructor(kind: vscode.SymbolKind, name: string, detail: string, uri: vscode.Uri, range: vscode.Range, selectionRange: vscode.Range) {
    this.kind = kind;
    this.name = name;
    this.detail = detail;
    this.uri = uri;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

export class EvaluatableExpression implements vscode.EvaluatableExpression {
  readonly range: vscode.Range;
  readonly expression?: string;

  constructor(range: vscode.Range, expression?: string) {
    this.range = range;
    this.expression = expression;
  }
}

export class InlineValueText implements vscode.InlineValueText {
  readonly range: vscode.Range;
  readonly text: string;

  constructor(range: vscode.Range, text: string) {
    this.range = range;
    this.text = text;
  }
}

export class InlineValueVariableLookup implements vscode.InlineValueVariableLookup {
  readonly range: vscode.Range;
  readonly variableName?: string;
  readonly caseSensitiveLookup: boolean;

  constructor(range: vscode.Range, variableName?: string, caseSensitiveLookup = true) {
    this.range = range;
    this.variableName = variableName;
    this.caseSensitiveLookup = caseSensitiveLookup;
  }
}

export class InlineValueEvaluatableExpression implements vscode.InlineValueEvaluatableExpression {
  readonly range: vscode.Range;
  readonly expression?: string;

  constructor(range: vscode.Range, expression?: string) {
    this.range = range;
    this.expression = expression;
  }
}

export class DocumentDropOrPasteEditKind implements vscode.DocumentDropOrPasteEditKind {
  private static readonly separator = '.';
  static readonly Empty = new DocumentDropOrPasteEditKind('');
  static readonly Text = DocumentDropOrPasteEditKind.Empty.append('text');
  static readonly TextUpdateImports = DocumentDropOrPasteEditKind.Text.append('updateImports');

  private constructor(readonly value: string) {}

  append(...parts: string[]): DocumentDropOrPasteEditKind {
    return new DocumentDropOrPasteEditKind((this.value ? [this.value, ...parts] : parts).join(DocumentDropOrPasteEditKind.separator));
  }

  intersects(other: vscode.DocumentDropOrPasteEditKind): boolean {
    return this.contains(other) || other.contains(this);
  }

  contains(other: vscode.DocumentDropOrPasteEditKind): boolean {
    return this.value === other.value || other.value.startsWith(this.value + DocumentDropOrPasteEditKind.separator);
  }
}

export class DocumentDropEdit implements vscode.DocumentDropEdit {
  title?: string;
  kind?: vscode.DocumentDropOrPasteEditKind;
  yieldTo?: readonly vscode.DocumentDropOrPasteEditKind[];
  insertText: string | vscode.SnippetString;
  additionalEdit?: vscode.WorkspaceEdit;

  constructor(insertText: string | vscode.SnippetString, title?: string, kind?: vscode.DocumentDropOrPasteEditKind) {
    this.insertText = insertText;
    this.title = title;
    this.kind = kind;
  }
}

export enum DocumentPasteTriggerKind { Automatic = 0, PasteAs = 1 }

export class DocumentPasteEdit implements vscode.DocumentPasteEdit {
  title: string;
  kind: vscode.DocumentDropOrPasteEditKind;
  insertText: string | vscode.SnippetString;
  additionalEdit?: vscode.WorkspaceEdit;
  yieldTo?: readonly vscode.DocumentDropOrPasteEditKind[];

  constructor(insertText: string | vscode.SnippetString, title: string, kind: vscode.DocumentDropOrPasteEditKind) {
    this.insertText = insertText;
    this.title = title;
    this.kind = kind;
  }
}

export enum InlineCompletionTriggerKind { Invoke = 0, Automatic = 1 }

export class InlineCompletionItem implements vscode.InlineCompletionItem {
  insertText: string | vscode.SnippetString;
  filterText?: string;
  range?: vscode.Range;
  command?: vscode.Command;

  constructor(insertText: string | vscode.SnippetString, range?: vscode.Range, command?: vscode.Command) {
    this.insertText = insertText;
    this.range = range;
    this.command = command;
  }
}

export class InlineCompletionList implements vscode.InlineCompletionList {
  items: vscode.InlineCompletionItem[];

  constructor(items: vscode.InlineCompletionItem[]) {
    this.items = items;
  }
}

export class MultiDocumentHighlight implements vscode.MultiDocumentHighlight {
  uri: vscode.Uri;
  highlights: vscode.DocumentHighlight[];

  constructor(uri: vscode.Uri, highlights: vscode.DocumentHighlight[]) {
    this.uri = uri;
    this.highlights = highlights;
  }
}

// --- The group -----------------------------------------------------------------------------------

export class ExtHostReceiveOnly implements LanguageFeatureGroup {
  private readonly kept = new Set<ReceiveOnlyAdapter>();

  readonly types = {
    CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, TypeHierarchyItem, EvaluatableExpression,
    InlineValueText, InlineValueVariableLookup, InlineValueEvaluatableExpression, DocumentDropOrPasteEditKind, DocumentDropEdit,
    DocumentPasteTriggerKind, DocumentPasteEdit, InlineCompletionTriggerKind, InlineCompletionItem, InlineCompletionList,
    MultiDocumentHighlight,
  };

  constructor(private readonly features: ExtHostLanguageFeatures) {}

  /** The providers kept now, by function name, for tests that look for leaks. */
  count(name?: ReceiveOnlyProviderName): number {
    return [...this.kept].filter(adapter => name === undefined || adapter.name === name).length;
  }

  api(extension: HostExtensionDescription): Readonly<Record<ReceiveOnlyProviderName, (...args: any[]) => vscode.Disposable>> {
    const api = {} as Record<ReceiveOnlyProviderName, (...args: any[]) => vscode.Disposable>;
    for (const { name } of receiveOnlyProviders) {
      // The selector is checked as every registration checks it; the provider and the options are not,
      // as upstream (the `documentPaste` proposal's options differ a little from the final API).
      api[name] = (selector: vscode.DocumentSelector, provider: unknown) => this.register(extension, name, selector, provider);
    }
    return api;
  }

  private register(extension: HostExtensionDescription, name: ReceiveOnlyProviderName, selector: vscode.DocumentSelector, provider: unknown): vscode.Disposable {
    selectorToDto(selector);
    const adapter = new ReceiveOnlyAdapter(name, extension, provider);
    this.kept.add(adapter);
    // Nothing is sent: the workbench would never ask.
    const registration = this.features.register(extension, adapter, async () => {});
    return new Disposable(() => {
      this.kept.delete(adapter);
      registration.dispose();
    });
  }

  release(key: string): void {
    for (const adapter of [...this.kept]) {
      if (adapter.extension.key === key) {
        this.kept.delete(adapter);
      }
    }
  }

  dispose(): void {
    this.kept.clear();
  }
}

/** The group's factory; a function declaration, so the seam can list it while the two modules load each other. */
export function createReceiveOnlyGroup(features: ExtHostLanguageFeatures): ExtHostReceiveOnly {
  return new ExtHostReceiveOnly(features);
}
