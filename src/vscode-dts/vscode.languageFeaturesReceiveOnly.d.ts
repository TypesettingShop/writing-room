declare module 'vscode' {
  // Language features that are registered and kept, but never asked: Monaco's standalone editor has no
  // screen for them (wr-c9d8.kxn). The list is `receiveOnlyProviders` in
  // `src/workbench/api/common/extHostLanguageFeaturesReceiveOnly.ts` and the table in
  // `docs/extension-api-language-features.md`.

  export class CallHierarchyItem {
    name: string;
    kind: SymbolKind;
    tags?: readonly SymbolTag[];
    detail?: string;
    uri: Uri;
    range: Range;
    selectionRange: Range;
    constructor(kind: SymbolKind, name: string, detail: string, uri: Uri, range: Range, selectionRange: Range);
  }

  export class CallHierarchyIncomingCall {
    from: CallHierarchyItem;
    fromRanges: Range[];
    constructor(item: CallHierarchyItem, fromRanges: Range[]);
  }

  export class CallHierarchyOutgoingCall {
    to: CallHierarchyItem;
    fromRanges: Range[];
    constructor(item: CallHierarchyItem, fromRanges: Range[]);
  }

  export interface CallHierarchyProvider {
    prepareCallHierarchy(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<CallHierarchyItem | CallHierarchyItem[]>;
    provideCallHierarchyIncomingCalls(item: CallHierarchyItem, token: CancellationToken): ProviderResult<CallHierarchyIncomingCall[]>;
    provideCallHierarchyOutgoingCalls(item: CallHierarchyItem, token: CancellationToken): ProviderResult<CallHierarchyOutgoingCall[]>;
  }

  export class TypeHierarchyItem {
    name: string;
    kind: SymbolKind;
    tags?: ReadonlyArray<SymbolTag>;
    detail?: string;
    uri: Uri;
    range: Range;
    selectionRange: Range;
    constructor(kind: SymbolKind, name: string, detail: string, uri: Uri, range: Range, selectionRange: Range);
  }

  export interface TypeHierarchyProvider {
    prepareTypeHierarchy(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<TypeHierarchyItem | TypeHierarchyItem[]>;
    provideTypeHierarchySupertypes(item: TypeHierarchyItem, token: CancellationToken): ProviderResult<TypeHierarchyItem[]>;
    provideTypeHierarchySubtypes(item: TypeHierarchyItem, token: CancellationToken): ProviderResult<TypeHierarchyItem[]>;
  }

  export class EvaluatableExpression {
    readonly range: Range;
    readonly expression?: string | undefined;
    constructor(range: Range, expression?: string);
  }

  export interface EvaluatableExpressionProvider {
    provideEvaluatableExpression(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<EvaluatableExpression>;
  }

  export class InlineValueText {
    readonly range: Range;
    readonly text: string;
    constructor(range: Range, text: string);
  }

  export class InlineValueVariableLookup {
    readonly range: Range;
    readonly variableName?: string | undefined;
    readonly caseSensitiveLookup: boolean;
    constructor(range: Range, variableName?: string, caseSensitiveLookup?: boolean);
  }

  export class InlineValueEvaluatableExpression {
    readonly range: Range;
    readonly expression?: string | undefined;
    constructor(range: Range, expression?: string);
  }

  export type InlineValue = InlineValueText | InlineValueVariableLookup | InlineValueEvaluatableExpression;

  export interface InlineValueContext {
    readonly frameId: number;
    readonly stoppedLocation: Range;
  }

  export interface InlineValuesProvider {
    onDidChangeInlineValues?: Event<void> | undefined;
    provideInlineValues(document: TextDocument, viewPort: Range, context: InlineValueContext, token: CancellationToken): ProviderResult<InlineValue[]>;
  }

  export class DocumentDropOrPasteEditKind {
    static readonly Empty: DocumentDropOrPasteEditKind;
    static readonly Text: DocumentDropOrPasteEditKind;
    static readonly TextUpdateImports: DocumentDropOrPasteEditKind;
    private constructor(value: string);
    readonly value: string;
    append(...parts: string[]): DocumentDropOrPasteEditKind;
    intersects(other: DocumentDropOrPasteEditKind): boolean;
    contains(other: DocumentDropOrPasteEditKind): boolean;
  }

  export class DocumentDropEdit {
    title?: string;
    kind?: DocumentDropOrPasteEditKind;
    yieldTo?: readonly DocumentDropOrPasteEditKind[];
    insertText: string | SnippetString;
    additionalEdit?: WorkspaceEdit;
    constructor(insertText: string | SnippetString, title?: string, kind?: DocumentDropOrPasteEditKind);
  }

  export interface DocumentDropEditProvider<T extends DocumentDropEdit = DocumentDropEdit> {
    provideDocumentDropEdits(document: TextDocument, position: Position, dataTransfer: DataTransfer, token: CancellationToken): ProviderResult<T | T[]>;
    resolveDocumentDropEdit?(edit: T, token: CancellationToken): ProviderResult<T>;
  }

  export interface DocumentDropEditProviderMetadata {
    readonly providedDropEditKinds?: readonly DocumentDropOrPasteEditKind[];
    readonly dropMimeTypes: readonly string[];
  }

  export enum DocumentPasteTriggerKind {
    Automatic = 0,
    PasteAs = 1
  }

  export interface DocumentPasteEditContext {
    readonly only: DocumentDropOrPasteEditKind | undefined;
    readonly triggerKind: DocumentPasteTriggerKind;
  }

  export interface DocumentPasteEditProvider<T extends DocumentPasteEdit = DocumentPasteEdit> {
    prepareDocumentPaste?(document: TextDocument, ranges: readonly Range[], dataTransfer: DataTransfer, token: CancellationToken): void | Thenable<void>;
    provideDocumentPasteEdits?(document: TextDocument, ranges: readonly Range[], dataTransfer: DataTransfer, context: DocumentPasteEditContext, token: CancellationToken): ProviderResult<T[]>;
    resolveDocumentPasteEdit?(pasteEdit: T, token: CancellationToken): ProviderResult<T>;
  }

  export class DocumentPasteEdit {
    title: string;
    kind: DocumentDropOrPasteEditKind;
    insertText: string | SnippetString;
    additionalEdit?: WorkspaceEdit;
    yieldTo?: readonly DocumentDropOrPasteEditKind[];
    constructor(insertText: string | SnippetString, title: string, kind: DocumentDropOrPasteEditKind);
  }

  export interface DocumentPasteProviderMetadata {
    readonly providedPasteEditKinds: readonly DocumentDropOrPasteEditKind[];
    readonly copyMimeTypes?: readonly string[];
    readonly pasteMimeTypes?: readonly string[];
  }

  export interface InlineCompletionItemProvider {
    provideInlineCompletionItems(document: TextDocument, position: Position, context: InlineCompletionContext, token: CancellationToken): ProviderResult<InlineCompletionItem[] | InlineCompletionList>;
  }

  export class InlineCompletionList {
    items: InlineCompletionItem[];
    constructor(items: InlineCompletionItem[]);
  }

  export interface InlineCompletionContext {
    readonly triggerKind: InlineCompletionTriggerKind;
    readonly selectedCompletionInfo: SelectedCompletionInfo | undefined;
  }

  export interface SelectedCompletionInfo {
    readonly range: Range;
    readonly text: string;
  }

  export enum InlineCompletionTriggerKind {
    Invoke = 0,
    Automatic = 1
  }

  export class InlineCompletionItem {
    insertText: string | SnippetString;
    filterText?: string;
    range?: Range;
    command?: Command;
    constructor(insertText: string | SnippetString, range?: Range, command?: Command);
  }

  export interface DocumentRangeSemanticTokensProvider {
    onDidChangeSemanticTokens?: Event<void>;
    provideDocumentRangeSemanticTokens(document: TextDocument, range: Range, token: CancellationToken): ProviderResult<SemanticTokens>;
  }

  // Proposed API multiDocumentHighlightProvider (vscode.proposed.multiDocumentHighlightProvider.d.ts at the
  // fixed commit), with its upstream signature; see apiDeviations.json.

  export class MultiDocumentHighlight {
    uri: Uri;
    highlights: DocumentHighlight[];
    constructor(uri: Uri, highlights: DocumentHighlight[]);
  }

  export interface MultiDocumentHighlightProvider {
    provideMultiDocumentHighlights(document: TextDocument, position: Position, otherDocuments: TextDocument[], token: CancellationToken): ProviderResult<MultiDocumentHighlight[]>;
  }

  export namespace languages {
    export function registerCallHierarchyProvider(selector: DocumentSelector, provider: CallHierarchyProvider): Disposable;
    export function registerTypeHierarchyProvider(selector: DocumentSelector, provider: TypeHierarchyProvider): Disposable;
    export function registerInlineValuesProvider(selector: DocumentSelector, provider: InlineValuesProvider): Disposable;
    export function registerEvaluatableExpressionProvider(selector: DocumentSelector, provider: EvaluatableExpressionProvider): Disposable;
    export function registerDocumentDropEditProvider(selector: DocumentSelector, provider: DocumentDropEditProvider, metadata?: DocumentDropEditProviderMetadata): Disposable;
    export function registerDocumentPasteEditProvider(selector: DocumentSelector, provider: DocumentPasteEditProvider, metadata: DocumentPasteProviderMetadata): Disposable;
    export function registerInlineCompletionItemProvider(selector: DocumentSelector, provider: InlineCompletionItemProvider): Disposable;
    export function registerDocumentRangeSemanticTokensProvider(selector: DocumentSelector, provider: DocumentRangeSemanticTokensProvider, legend: SemanticTokensLegend): Disposable;
    export function registerMultiDocumentHighlightProvider(selector: DocumentSelector, provider: MultiDocumentHighlightProvider): Disposable;
  }
}
