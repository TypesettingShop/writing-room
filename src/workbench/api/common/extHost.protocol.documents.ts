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
