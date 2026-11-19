import { Schemas } from '../../../../base/common/network.js';
import { BrowserFileDatabase, IndexedDBFileSystemProvider } from '../../../../platform/files/browser/indexedDBFileSystemProvider.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { FetchFileSystemProvider } from '../../extensions/browser/webWorkerFileSystemProvider.js';

export class BrowserFileService extends FileService {
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
