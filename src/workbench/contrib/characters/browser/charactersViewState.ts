import {
  characterLimits, characterNodeTypes, CharacterStoreError, normalizeCharacterTitle, type CharacterEntry, type CharacterNode, type CharacterType,
} from '../../../../platform/characters/common/characters.js';
import type { CharactersStore } from '../../../../platform/characters/common/charactersStore.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { isManuscriptId, isManuscriptRevision } from '../../../../platform/manuscript/common/manuscript.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { NavigatorViewState } from '../../../browser/navigator/navigatorViewState.js';
import { labelOf, preorder } from '../../../common/navigator/navigatorTree.js';
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
      deleteMessage: (node, index) => {
        const name = labelOf(node, index);
        if (node.kind === 'character') {
          return `Delete "${name}"?`;
        }
        let count = 0;
        for (const descendant of preorder(node.id, index)) {
          if (descendant.kind === 'character') {
            count++;
          }
        }
        return `Delete "${name}" and ${count} ${count === 1 ? 'character' : 'characters'} in it?`;
      },
      messages: {
        loadFailed: 'Could not load characters.',
        writeFailed: 'Could not update characters.',
        conflictReloadFailed: 'The character tree changed elsewhere and could not be reloaded. Use Refresh to try again.',
        conflictReloaded: 'The character tree changed elsewhere. It has been reloaded.',
      },
    }, storage, notifications, dialogs);
  }

  selectedCharacters(): CharacterEntry[] {
    const index = this.index;
    const characters: CharacterEntry[] = [];
    for (const id of this.selected) {
      const node = index?.nodes.get(id);
      if (node?.kind === 'character') {
        characters.push(node);
      }
    }
    return characters;
  }

  async setType(type: CharacterType): Promise<void> {
    const changes = this.selectedCharacters().filter(node => node.type !== type);
    if (changes.length === 0) {
      return;
    }
    await this.write(async (store, workId, revision) => {
      // Each successful request advances the expected revision for the next character.
      for (const node of changes) {
        const updated = await store.updateNode(workId, node.id, { type }, revision);
        revision = updated.revision;
      }
      return { revision };
    }, { refreshOnError: true });
  }
}

registerSingleton(ICharactersViewState, CharactersViewState);
