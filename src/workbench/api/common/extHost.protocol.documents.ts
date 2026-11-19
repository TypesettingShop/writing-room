import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { URI } from '../../../base/common/uri.js';
import type { IModelContentChangedEvent, IRange, ISingleEditOperation } from '../../../editor/common/model.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

export const documentSaveTimeout = 1500;

export interface DocumentSnapshot {
  readonly id: string;
  readonly uri: URI;
  readonly lines: string[];
  readonly eol: string;
  readonly version: number;
  readonly language: string;
  readonly dirty: boolean;
}

export interface DocumentDelta {
  readonly added?: DocumentSnapshot[];
  readonly removed?: string[];
}

export interface DocumentEdit {
  readonly operations: readonly ISingleEditOperation[];
  readonly eol?: 1 | 2;
}

export interface OpenDocumentOptions {
  readonly language?: string;
  readonly content?: string;
  readonly encoding?: string;
}

export interface MainThreadDocumentsShape {
  $openDocument(extension: string, target: URI | OpenDocumentOptions): Promise<string>;
  $saveDocument(id: string): Promise<boolean>;
  $setDocumentLanguage(extension: string, id: string, language: string): Promise<void>;
  $registerContentProvider(extension: string, handle: number, scheme: string): Promise<void>;
  $unregisterContentProvider(extension: string, handle: number): Promise<void>;
  $updateProvidedContent(extension: string, handle: number, uri: URI): Promise<void>;
  $applySaveEdits(extension: string, save: number, version: number, edit: DocumentEdit): Promise<boolean>;
}

export interface ExtHostDocumentsShape {
  $acceptDocumentDelta(delta: DocumentDelta): Promise<void>;
  $acceptDocumentChanges(id: string, changes: IModelContentChangedEvent, dirty: boolean): Promise<void>;
  $acceptDocumentLanguage(id: string, language: string): Promise<void>;
  $acceptDocumentDirty(id: string, dirty: boolean): Promise<void>;
  $acceptDocumentSaved(id: string): Promise<void>;
  $participateInSave(id: string, save: number, deadline: number, reason: number, token: CancellationToken): Promise<void>;
  $provideDocumentContent(extension: string, handle: number, uri: URI, token: CancellationToken): Promise<string | undefined>;
}

export const MainThreadDocumentsProxy = createProxyIdentifier<MainThreadDocumentsShape>('MainThreadDocuments');
export const ExtHostDocumentsProxy = createProxyIdentifier<ExtHostDocumentsShape>('ExtHostDocuments');

export function toModelRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): IRange {
  return {
    startLineNumber: range.start.line + 1, startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1, endColumn: range.end.character + 1,
  };
}

export interface EditorSelection {
  readonly selectionStartLineNumber: number;
  readonly selectionStartColumn: number;
  readonly positionLineNumber: number;
  readonly positionColumn: number;
}

export interface EditorOptions {
  readonly tabSize?: number | string;
  readonly indentSize?: number | string;
  readonly insertSpaces?: boolean | string;
  readonly cursorStyle?: number;
  readonly lineNumbers?: number;
}

export interface EditorProperties {
  readonly selections: EditorSelection[];
  readonly visibleRanges: IRange[];
  readonly options: EditorOptions;
  readonly viewColumn: number;
}

export interface EditorSnapshot extends EditorProperties {
  readonly id: string;
  readonly document: string;
}

export interface EditorDelta {
  readonly added: EditorSnapshot[];
  readonly removed: string[];
  readonly active: string | null;
  readonly visible: string[];
}

export interface EditorShowOptions {
  readonly viewColumn?: number;
  readonly preserveFocus?: boolean;
  readonly selection?: IRange;
}

export interface EditorUndoOptions {
  readonly undoStopBefore?: boolean;
  readonly undoStopAfter?: boolean;
  readonly keepWhitespace?: boolean;
}

export interface MainThreadEditorsShape {
  $showTextDocument(extension: string, document: string | URI, options: EditorShowOptions): Promise<string>;
  $setSelections(id: string, selections: EditorSelection[]): Promise<void>;
  $setOptions(id: string, options: EditorOptions): Promise<void>;
  $revealRange(id: string, range: IRange, how: number): Promise<void>;
  $applyEdits(id: string, version: number, edit: DocumentEdit, options: EditorUndoOptions): Promise<boolean>;
  $insertSnippet(id: string, version: number, snippet: string, ranges: IRange[] | undefined, options: EditorUndoOptions): Promise<boolean>;
  $showEditor(id: string, column?: number): Promise<void>;
  $hideEditor(id: string): Promise<void>;
}

export interface ExtHostEditorsShape {
  $acceptEditorDelta(delta: EditorDelta): Promise<void>;
  $acceptEditorProperties(id: string, properties: Partial<EditorProperties>, selectionKind?: number): Promise<void>;
}

export const MainThreadEditorsProxy = createProxyIdentifier<MainThreadEditorsShape>('MainThreadEditors');
export const ExtHostEditorsProxy = createProxyIdentifier<ExtHostEditorsShape>('ExtHostEditors');
