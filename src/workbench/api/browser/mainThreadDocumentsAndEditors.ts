import { DisposableStore } from '../../../base/common/lifecycle.js';
import { DocumentApiCommands } from './apiCommands.js';
import { MainThreadEditorContextMenu } from './mainThreadEditorContextMenu.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadBulkEdits } from './mainThreadBulkEdits.js';
import { MainThreadDocuments } from './mainThreadDocuments.js';
import { MainThreadEditorDecorations } from './mainThreadEditorDecorations.js';
import { MainThreadEditorTabs } from './mainThreadEditorTabs.js';
import { MainThreadEditors } from './mainThreadEditors.js';
import { ExtHostDocumentsProxy, ExtHostEditorsProxy, ExtHostEditorTabsProxy, MainThreadEditorTabsProxy, MainThreadBulkEditsProxy, MainThreadDecorationsProxy, MainThreadDocumentsProxy, MainThreadEditorsProxy } from '../common/extHost.protocol.documents.js';

mainThreadCustomers.register('documents', ({ rpc, instantiation, getExtension }) => {
  const documents = instantiation.createInstance(MainThreadDocuments, rpc.getProxy(ExtHostDocumentsProxy), getExtension);
  rpc.set(MainThreadDocumentsProxy, documents);
  const editors = instantiation.createInstance(MainThreadEditors, rpc.getProxy(ExtHostEditorsProxy), documents);
  rpc.set(MainThreadEditorsProxy, editors);
  rpc.set(MainThreadBulkEditsProxy, instantiation.createInstance(MainThreadBulkEdits, documents, editors));
  const decorations = instantiation.createInstance(MainThreadEditorDecorations, editors, getExtension);
  rpc.set(MainThreadDecorationsProxy, decorations);
  const tabs = instantiation.createInstance(MainThreadEditorTabs, rpc.getProxy(ExtHostEditorTabsProxy), documents);
  rpc.set(MainThreadEditorTabsProxy, tabs);
  const lifetime = new DisposableStore();
  lifetime.add(instantiation.createInstance(DocumentApiCommands));
  lifetime.add(instantiation.createInstance(MainThreadEditorContextMenu));
  lifetime.add(tabs);
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
