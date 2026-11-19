import '../platform/actions/common/menuService.js';
import '../platform/contextkey/browser/contextKeyService.js';
import '../platform/contextview/browser/contextMenuService.js';
import './services/commands/common/commandService.js';
import './services/keybinding/browser/keybindingService.js';
import './services/storage/browser/storageService.js';

import { Schemas } from '../base/common/network.js';
import { BrowserFileDatabase, IndexedDBFileSystemProvider } from '../platform/files/browser/indexedDBFileSystemProvider.js';
import { FileService } from '../platform/files/common/fileService.js';
import { IFileService } from '../platform/files/common/files.js';
import { registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../platform/workspace/common/workspace.js';
import { registerWorkbenchContribution2 } from './common/contributions.js';
import { FetchFileSystemProvider } from './services/extensions/browser/webWorkerFileSystemProvider.js';
import { WorkspaceContextService, WorkspaceStorageContribution } from './services/workspaces/browser/workspaceContextService.js';

class BrowserFileService extends FileService {
  constructor() {
    super();
    const remote = new FetchFileSystemProvider();
    this.registerProvider(Schemas.http, remote);
    this.registerProvider(Schemas.https, remote);

    const database = this._register(new BrowserFileDatabase());
    this.registerProvider(Schemas.vscodeVfs, this._register(new IndexedDBFileSystemProvider(database, Schemas.vscodeVfs)));
    this.registerProvider(Schemas.vscodeUserData, this._register(new IndexedDBFileSystemProvider(database, Schemas.vscodeUserData)));
  }
}

registerSingleton(IFileService, BrowserFileService);
registerSingleton(IWorkspaceContextService, WorkspaceContextService);
registerWorkbenchContribution2('workbench.contrib.workspaceStorage', WorkspaceStorageContribution);
