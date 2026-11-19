import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { ExtHostDocuments, TextDocumentChangeReason, TextDocumentSaveReason } from './extHostDocuments.js';
import { ExtHostTextEditors } from './extHostTextEditors.js';
import { TextEditorCursorStyle, TextEditorLineNumbersStyle, TextEditorRevealType, TextEditorSelectionChangeKind } from './extHostTextEditor.js';
import { ExtHostDocumentsProxy, ExtHostEditorsProxy, MainThreadDocumentsProxy, MainThreadEditorsProxy } from './extHost.protocol.documents.js';

extHostApiRegistry.register('documents', ({ rpc, isLive }) => {
  const documents = new ExtHostDocuments(rpc.getProxy(MainThreadDocumentsProxy), isLive);
  rpc.set(ExtHostDocumentsProxy, documents);
  const editors = new ExtHostTextEditors(rpc.getProxy(MainThreadEditorsProxy), documents);
  rpc.set(ExtHostEditorsProxy, editors);
  return {
    service: documents,
    create: ({ key }) => ({
      types: { TextDocumentChangeReason, TextDocumentSaveReason, TextEditorCursorStyle, TextEditorLineNumbersStyle,
        TextEditorRevealType, TextEditorSelectionChangeKind },
      namespaces: {
        window: editors.createApi(key),
        workspace: {
          get textDocuments() { return documents.all; },
          openTextDocument: promiseApiMethod((target?: Parameters<ExtHostDocuments['open']>[1]) => documents.open(key, target)),
          registerTextDocumentContentProvider: (...args: Parameters<ExtHostDocuments['registerProvider']> extends [string, ...infer P] ? P : never) =>
            documents.registerProvider(key, ...args),
          ...documents.events(key),
        },
        languages: {
          setTextDocumentLanguage: promiseApiMethod((document: Parameters<ExtHostDocuments['setLanguage']>[1], language: string) =>
            documents.setLanguage(key, document, language)),
        },
      },
    }),
    release: key => documents.release(key),
    dispose: () => {
      editors.dispose();
      documents.dispose();
    },
  };
});
