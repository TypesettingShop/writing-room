import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { ExtHostDocuments, TextDocumentChangeReason, TextDocumentSaveReason } from './extHostDocuments.js';
import { ExtHostDocumentsProxy, MainThreadDocumentsProxy } from './extHost.protocol.documents.js';

extHostApiRegistry.register('documents', ({ rpc, isLive }) => {
  const documents = new ExtHostDocuments(rpc.getProxy(MainThreadDocumentsProxy), isLive);
  rpc.set(ExtHostDocumentsProxy, documents);
  return {
    service: documents,
    create: ({ key }) => ({
      types: { TextDocumentChangeReason, TextDocumentSaveReason },
      namespaces: {
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
    dispose: () => documents.dispose(),
  };
});
