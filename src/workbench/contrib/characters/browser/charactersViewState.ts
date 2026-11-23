import {
  characterLimits, characterNodeTypes, CharacterStoreError, normalizeCharacterTitle, type CharacterNode,
} from '../../../../platform/characters/common/characters.js';
import type { CharactersStore } from '../../../../platform/characters/common/charactersStore.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { isManuscriptId, isManuscriptRevision } from '../../../../platform/manuscript/common/manuscript.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { NavigatorViewState } from '../../../browser/navigator/navigatorViewState.js';
import { ICharactersService } from '../../../services/characters/common/charactersService.js';
import { IWorkService } from '../../../services/work/common/work.js';

export const ICharactersViewState = createDecorator<CharactersViewState>('charactersViewState');

export class CharactersViewState extends NavigatorViewState<CharacterNode, CharactersStore> {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkService work: IWorkService,
    @ICharactersService characters: ICharactersService,
    @IStorageService storage: IStorageService,
    @INotificationService notifications: INotificationService,
    @IDialogService dialogs: IDialogService,
  ) {
    super(work.current?.id, characters, {
      tree: {
        types: characterNodeTypes,
        label: node => node.title || 'Untitled',
        maxNodes: characterLimits.nodes,
        isId: isManuscriptId,
        invalidTree: 'The character tree is invalid.',
      },
      storageKey: 'workbench.characters.navigator',
      isRevision: isManuscriptRevision,
      normalizeTitle: normalizeCharacterTitle,
      isConflict: error => error instanceof CharacterStoreError && error.code === 'conflict',
      messages: {
        loadFailed: 'Could not load characters.',
        writeFailed: 'Could not update characters.',
        conflictReloadFailed: 'The character tree changed elsewhere and could not be reloaded. Use Refresh to try again.',
        conflictReloaded: 'The character tree changed elsewhere. It has been reloaded.',
      },
    }, storage, notifications, dialogs);
  }
}

registerSingleton(ICharactersViewState, CharactersViewState);
