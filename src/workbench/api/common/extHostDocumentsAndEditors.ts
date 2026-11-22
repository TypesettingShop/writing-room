import type * as vscode from 'vscode';
import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { ExtHostDocuments, TextDocumentChangeReason, TextDocumentSaveReason } from './extHostDocuments.js';
import { ExtHostEditorTabs, tabInputTypes } from './extHostEditorTabs.js';
import { ExtHostBulkEdits } from './extHostBulkEdits.js';
import { ExtHostTextEditorDecorations, OverviewRulerLane, DecorationRangeBehavior } from './extHostTextEditorDecorations.js';
import { ExtHostTextEditors } from './extHostTextEditors.js';
import { TextEditorCursorStyle, TextEditorLineNumbersStyle, TextEditorRevealType, TextEditorSelectionChangeKind } from './extHostTextEditor.js';
import { ExtHostDocumentsProxy, ExtHostEditorsProxy, ExtHostEditorTabsProxy, MainThreadEditorTabsProxy, MainThreadBulkEditsProxy, MainThreadDecorationsProxy, MainThreadDocumentsProxy, MainThreadEditorsProxy } from './extHost.protocol.documents.js';

extHostApiRegistry.register('documents', ({ rpc, isLive }) => {
  const documents = new ExtHostDocuments(rpc.getProxy(MainThreadDocumentsProxy), isLive);
  rpc.set(ExtHostDocumentsProxy, documents);
  const decorations = new ExtHostTextEditorDecorations(rpc.getProxy(MainThreadDecorationsProxy));
  const editors = new ExtHostTextEditors(rpc.getProxy(MainThreadEditorsProxy), documents, decorations);
  rpc.set(ExtHostEditorsProxy, editors);
  const tabs = new ExtHostEditorTabs(rpc.getProxy(MainThreadEditorTabsProxy), documents);
  rpc.set(ExtHostEditorTabsProxy, tabs);
  const bulkEdits = new ExtHostBulkEdits(rpc.getProxy(MainThreadBulkEditsProxy), documents);
  // The main thread can already have restored models and tabs when the worker starts.
  // Announce readiness only after every receiver in this area has been registered.
  void documents.proxy.$startDocumentSync().catch(() => {});
  return {
    service: documents,
    create: extension => {
      const { key, id } = extension;
      documents.associateExtension(extension);
      return {
        types: { ...tabInputTypes, TextDocumentChangeReason, TextDocumentSaveReason, TextEditorCursorStyle, TextEditorLineNumbersStyle,
          TextEditorRevealType, TextEditorSelectionChangeKind, OverviewRulerLane, DecorationRangeBehavior },
        namespaces: {
          window: Object.assign(editors.createApi(key), { tabGroups: tabs.createApi(key) }),
          workspace: {
            applyEdit: promiseApiMethod((edit: vscode.WorkspaceEdit, metadata?: vscode.WorkspaceEditMetadata) =>
              bulkEdits.apply(key, edit, metadata)),
            get textDocuments() { return documents.allFor(key); },
            openTextDocument: promiseApiMethod((target?: Parameters<ExtHostDocuments['open']>[1]) => documents.open(key, target)),
            registerTextDocumentContentProvider: (scheme: string, provider: vscode.TextDocumentContentProvider) =>
              documents.registerProvider(key, scheme, provider),
            ...documents.events(key, id),
          },
          languages: {
            setTextDocumentLanguage: promiseApiMethod((document: vscode.TextDocument, language: string) =>
              documents.setLanguage(key, document, language)),
          },
        },
      };
    },
    release: key => {
      decorations.release(key);
      documents.release(key);
    },
    dispose: () => {
      tabs.dispose();
      decorations.dispose();
      editors.dispose();
      documents.dispose();
    },
  };
});
