import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import '../../../../platform/quickinput/browser/quickInputService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../services/storage/browser/storageService.js';
import { CommandsQuickAccessProvider } from './commandsQuickAccess.js';

const showCommands = 'workbench.action.showCommands';
const firefox = /Firefox\//i.test(globalThis.navigator?.userAgent ?? '');

registerSingleton(IStorageService, BrowserStorageService);

registerAction2(class ShowAllCommandsAction extends Action2 {
  constructor() {
    super({
      id: showCommands,
      title: 'Show All Commands',
      f1: true,
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: firefox ? KeyCode.F1 : KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP,
        secondary: firefox ? undefined : [KeyCode.F1],
      },
    });
  }

  override run(accessor: ServicesAccessor): Promise<void> {
    return accessor.get(IInstantiationService).createInstance(CommandsQuickAccessProvider).show();
  }
});

MenuRegistry.appendMenuItem(MenuId.MenubarViewMenu, {
  command: { id: showCommands, title: 'Command Palette' },
  group: '1_open',
  order: 1,
});
