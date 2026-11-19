import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { SYMBOLS_PREFIX } from './symbolsQuickAccess.js';

export const SHOW_ALL_SYMBOLS_ID = 'workbench.action.showAllSymbols';

registerAction2(class ShowAllSymbolsAction extends Action2 {
  constructor() {
    super({
      id: SHOW_ALL_SYMBOLS_ID,
      title: 'Go to Symbol in Workspace...',
      f1: true,
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyCode.KeyT,
      },
    });
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IQuickInputService).quickAccess.show(SYMBOLS_PREFIX);
  }
});
