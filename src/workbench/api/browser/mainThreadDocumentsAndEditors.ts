import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadDocuments } from './mainThreadDocuments.js';
import { ExtHostDocumentsProxy, MainThreadDocumentsProxy } from '../common/extHost.protocol.documents.js';

mainThreadCustomers.register('documents', ({ rpc, instantiation, getExtension }) => {
  const documents = instantiation.createInstance(MainThreadDocuments, rpc.getProxy(ExtHostDocumentsProxy), getExtension);
  rpc.set(MainThreadDocumentsProxy, documents);
  return documents;
});
