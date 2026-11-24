import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ManuscriptNode } from '../../../../platform/manuscript/common/manuscript.js';
import type { ManuscriptStore } from '../../../../platform/manuscript/common/manuscriptStore.js';
import { ManuscriptDragAndDropObserver } from '../../../browser/dnd.js';
import { NavigatorView as TreeNavigatorView } from '../../../browser/navigator/navigatorView.js';
import { IManuscriptOpener, type ManuscriptOpener } from './manuscriptOpener.js';
import { IManuscriptViewState, type ManuscriptViewState } from './manuscriptViewState.js';

export class NavigatorView extends TreeNavigatorView<ManuscriptNode, ManuscriptStore> {
  constructor(
    parent: HTMLElement,
    @IManuscriptViewState state: ManuscriptViewState,
    @IContextKeyService contextKeys: IContextKeyService,
    @IMenuService menus: IMenuService,
    @IManuscriptOpener opener: ManuscriptOpener,
    @IContextMenuService contextMenus: IContextMenuService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(parent, state, {
      cssPrefix: 'manuscript',
      treeLabel: 'Manuscript Navigator',
      rowIcon: (_node, dir) => ({ id: dir ? 'folder' : 'file' }),
      emptyHint: 'This Work has no parts yet.',
      emptyActions: [['part', 'New Part'], ['chapter', 'New Chapter'], ['document', 'New Document']],
      loadingMessage: 'Loading manuscript…',
      invalidTitle: 'Enter a title of up to 200 characters on one line.',
      titleReloaded: 'The manuscript was reloaded. Press Enter to save your title again.',
      menuId: MenuId.ManuscriptNavigatorContext,
      selectionKindKey: 'manuscriptSelectionKind',
      activate: node => { void opener.openDocuments([node.id]); },
      drag: { observer: ManuscriptDragAndDropObserver.INSTANCE, dropDatasetKey: 'manuscriptDrop' },
    }, contextKeys, menus, contextMenus, instantiation);
  }
}
