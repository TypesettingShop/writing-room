import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { WorldNode } from '../../../../platform/world/common/world.js';
import type { WorldStore } from '../../../../platform/world/common/worldStore.js';
import { WorldDragAndDropObserver } from '../../../browser/dnd.js';
import { NavigatorView } from '../../../browser/navigator/navigatorView.js';
import { openWorldItem } from './worldOpener.js';
import { renderWorldPresetPicker } from './worldPresetPicker.js';
import { IWorldViewState, type WorldViewState } from './worldViewState.js';

export const WORLD_SELECTION_KIND = 'worldSelectionKind';
export const WorldCanCreateItem = new RawContextKey<boolean>('worldCanCreateItem', false);

export class WorldNavigator extends NavigatorView<WorldNode, WorldStore> {
  constructor(
    parent: HTMLElement,
    @IWorldViewState state: WorldViewState,
    @IContextKeyService contextKeys: IContextKeyService,
    @IMenuService menus: IMenuService,
    @IContextMenuService contextMenus: IContextMenuService,
    @IInstantiationService instantiation: IInstantiationService,
    @ICommandService commands: ICommandService,
    @INotificationService notifications: INotificationService,
  ) {
    super(parent, state, {
      cssPrefix: 'world',
      treeLabel: 'World Navigator',
      rowIcon: node => ({ id: 'world-' + node.kind }),
      keyboardMultiSelect: true,
      activate: node => {
        if (node.kind === 'item') {
          void instantiation.invokeFunction(openWorldItem, node.id);
        } else if (node.kind === 'calendar' && CommandsRegistry.getCommand('world.editCalendar')) {
          void commands.executeCommand('world.editCalendar').catch(error => {
            notifications.error(error instanceof Error ? error.message : 'Could not open the calendar.');
          });
        }
      },
      renderEmpty: parent => renderWorldPresetPicker(parent, state),
      loadingMessage: 'Loading the world…',
      invalidTitle: 'Enter a name of up to 200 characters on one line.',
      titleReloaded: 'The world tree was reloaded. Press Enter to save your name again.',
      menuId: MenuId.WorldNavigatorContext,
      selectionKindKey: WORLD_SELECTION_KIND,
      drag: { observer: WorldDragAndDropObserver.INSTANCE, dropDatasetKey: 'worldDrop' },
    }, contextKeys, menus, contextMenus, instantiation);

    const canCreateItem = WorldCanCreateItem.bindTo(contextKeys.getScopedContextKeyService(parent));
    const updateCanCreateItem = () => canCreateItem.set(!state.busy && state.creationParent('item') !== undefined);
    this._register(state.onDidChange(updateCanCreateItem));
    this._register(toDisposable(() => canCreateItem.reset()));
    updateCanCreateItem();
  }
}
