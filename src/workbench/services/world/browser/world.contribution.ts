import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { WindowManuscriptService } from '../../manuscript/browser/windowManuscriptService.js';
import { IManuscriptService } from '../../manuscript/common/manuscriptService.js';
import { IWorldService } from '../common/worldService.js';
import { WindowWorldService } from './windowWorldService.js';

class BrowserWorldService extends WindowWorldService {
  constructor(@IManuscriptService manuscript: WindowManuscriptService) {
    super(manuscript);
  }
}

registerSingleton(IWorldService, BrowserWorldService);
