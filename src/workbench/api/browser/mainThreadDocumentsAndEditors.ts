import { DisposableStore } from '../../../base/common/lifecycle.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadBulkEdits } from './mainThreadBulkEdits.js';
import { MainThreadDocuments } from './mainThreadDocuments.js';
import { MainThreadEditorDecorations } from './mainThreadEditorDecorations.js';
import { MainThreadEditors } from './mainThreadEditors.js';
import { ExtHostDocumentsProxy, ExtHostEditorsProxy, MainThreadBulkEditsProxy, MainThreadDecorationsProxy, MainThreadDocumentsProxy, MainThreadEditorsProxy } from '../common/extHost.protocol.documents.js';

mainThreadCustomers.register('documents', ({ rpc, instantiation, getExtension }) => {
  const documents = instantiation.createInstance(MainThreadDocuments, rpc.getProxy(ExtHostDocumentsProxy), getExtension);
  rpc.set(MainThreadDocumentsProxy, documents);
  const editors = instantiation.createInstance(MainThreadEditors, rpc.getProxy(ExtHostEditorsProxy), documents);
  rpc.set(MainThreadEditorsProxy, editors);
  rpc.set(MainThreadBulkEditsProxy, instantiation.createInstance(MainThreadBulkEdits, documents, editors));
  const decorations = instantiation.createInstance(MainThreadEditorDecorations, editors, getExtension);
  rpc.set(MainThreadDecorationsProxy, decorations);
  const lifetime = new DisposableStore();
  lifetime.add(decorations);
  lifetime.add(editors);
  lifetime.add(documents);
  return {
    remove: key => {
      decorations.remove(key);
      documents.remove(key);
    },
    dispose: () => lifetime.dispose(),
  };
});
