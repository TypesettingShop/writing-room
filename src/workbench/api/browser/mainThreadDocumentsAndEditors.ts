import { DisposableStore } from '../../../base/common/lifecycle.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadDocuments } from './mainThreadDocuments.js';
import { MainThreadEditors } from './mainThreadEditors.js';
import { ExtHostDocumentsProxy, ExtHostEditorsProxy, MainThreadDocumentsProxy, MainThreadEditorsProxy } from '../common/extHost.protocol.documents.js';

mainThreadCustomers.register('documents', ({ rpc, instantiation, getExtension }) => {
  const documents = instantiation.createInstance(MainThreadDocuments, rpc.getProxy(ExtHostDocumentsProxy), getExtension);
  rpc.set(MainThreadDocumentsProxy, documents);
  const editors = instantiation.createInstance(MainThreadEditors, rpc.getProxy(ExtHostEditorsProxy), documents);
  rpc.set(MainThreadEditorsProxy, editors);
  const lifetime = new DisposableStore();
  lifetime.add(editors);
  lifetime.add(documents);
  return { remove: key => documents.remove(key), dispose: () => lifetime.dispose() };
});
