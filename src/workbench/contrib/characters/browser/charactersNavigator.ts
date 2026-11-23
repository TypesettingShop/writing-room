import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import type { CharacterNode } from '../../../../platform/characters/common/characters.js';
import type { CharactersStore } from '../../../../platform/characters/common/charactersStore.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CharactersDragAndDropObserver } from '../../../browser/dnd.js';
import { NavigatorView } from '../../../browser/navigator/navigatorView.js';
import { characterTypeIcon } from './characterIcons.js';
import { ICharactersViewState, type CharactersViewState } from './charactersViewState.js';

export const CHARACTERS_SELECTION_KIND = 'charactersSelectionKind';
export const CHARACTERS_SELECTION_TYPE = 'charactersSelectionType';
export const CHARACTERS_HAS_SELECTED_CHARACTER = 'charactersHasSelectedCharacter';

export class CharactersNavigator extends NavigatorView<CharacterNode, CharactersStore> {
  constructor(
    parent: HTMLElement,
    @ICharactersViewState state: CharactersViewState,
    @IContextKeyService contextKeys: IContextKeyService,
    @IMenuService menus: IMenuService,
    @IContextMenuService contextMenus: IContextMenuService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(parent, state, {
      cssPrefix: 'characters',
      treeLabel: 'Characters Navigator',
      rowIcon: node => node.kind === 'folder' ? { id: 'folder' } : characterTypeIcon(node.type),
      keyboardMultiSelect: true,
      emptyHint: 'This Work has no characters yet.',
      emptyActions: [['character', 'New Character'], ['folder', 'New Folder']],
      loadingMessage: 'Loading characters…',
      invalidTitle: 'Enter a name of up to 200 characters on one line.',
      titleReloaded: 'The character tree was reloaded. Press Enter to save your name again.',
      menuId: MenuId.CharactersNavigatorContext,
      selectionKindKey: CHARACTERS_SELECTION_KIND,
      setMenuContext: context => {
        const characters = state.selectedCharacters();
        const firstType = characters[0]?.type;
        const commonType = characters.every(character => character.type === firstType) ? firstType : undefined;
        context.createKey(CHARACTERS_HAS_SELECTED_CHARACTER, characters.length > 0);
        context.createKey(CHARACTERS_SELECTION_TYPE, commonType ?? '');
      },
      drag: { observer: CharactersDragAndDropObserver.INSTANCE, dropDatasetKey: 'charactersDrop' },
    }, contextKeys, menus, contextMenus, instantiation);
  }
}
