import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment } from '../../statusbar/browser/statusbar.js';
import { IManuscriptService } from '../common/manuscriptService.js';
import { HttpManuscriptStore } from './httpManuscriptStore.js';
import { WindowManuscriptService } from './windowManuscriptService.js';

class BrowserManuscriptService extends WindowManuscriptService {
  constructor() {
    super(window.location.search, import.meta.env.VITE_WRITING_ROOM_STORE, status => new HttpManuscriptStore(status));
  }
}

registerSingleton(IManuscriptService, BrowserManuscriptService);

class ManuscriptMemoryStatus extends Disposable {
  constructor(@IManuscriptService manuscript: IManuscriptService, @IStatusbarService statusbar: IStatusbarService) {
    super();
    if (manuscript.usesMemory) {
      const warning = 'In-memory store: changes are lost on reload.';
      this._register(statusbar.addEntry({
        name: warning, text: warning, backgroundColor: { id: 'statusBarItem.warningBackground' },
      }, 'manuscript.memory', StatusbarAlignment.LEFT, 100));
    }
  }
}

registerWorkbenchContribution2('workbench.contrib.manuscriptMemoryStatus', ManuscriptMemoryStatus);
