import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { WindowManuscriptService } from '../../manuscript/browser/windowManuscriptService.js';
import { IManuscriptService } from '../../manuscript/common/manuscriptService.js';
import { ICharactersService } from '../common/charactersService.js';
import { WindowCharactersService } from './windowCharactersService.js';

class BrowserCharactersService extends WindowCharactersService {
  constructor(@IManuscriptService manuscript: WindowManuscriptService) {
    super(manuscript);
  }
}

registerSingleton(ICharactersService, BrowserCharactersService);
