import '../platform/actions/common/menuService.js';
import '../platform/contextkey/browser/contextKeyService.js';
import '../platform/contextview/browser/contextMenuService.js';
import './services/commands/common/commandService.js';
import './services/keybinding/browser/keybindingService.js';
import './services/storage/browser/storageService.js';

import { Schemas } from '../base/common/network.js';
import { FileService } from '../platform/files/common/fileService.js';
import { IFileService } from '../platform/files/common/files.js';
import { registerSingleton } from '../platform/instantiation/common/extensions.js';
import { FetchFileSystemProvider } from './services/extensions/browser/webWorkerFileSystemProvider.js';

class BrowserFileService extends FileService {
  constructor() {
    super();
    const remote = new FetchFileSystemProvider();
    this.registerProvider(Schemas.http, remote);
    this.registerProvider(Schemas.https, remote);
  }
}

registerSingleton(IFileService, BrowserFileService);
