import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { ActivityBarVisibleContext, SideBarVisibleContext, StatusBarVisibleContext } from '../../common/contextkeys.js';
import { IWorkbenchLayoutService, Parts } from '../../services/layout/browser/layoutService.js';

export function registerTogglePartAction(
  id: string, part: Parts, title: string, menuTitle: string, context: RawContextKey<boolean>, order: number, key?: string,
): void {
  const toggled = context.isEqualTo(true);
  registerAction2(class extends Action2 {
    constructor() {
      super({
        id, title, f1: true, category: 'View', toggled,
        keybinding: key ? { primary: key, weight: KeybindingWeight.WorkbenchContrib } : undefined,
      });
    }

    override run(accessor: ServicesAccessor): void {
      const layout = accessor.get(IWorkbenchLayoutService);
      layout.setPartHidden(layout.isVisible(part), part);
    }
  });
  // Appearance uses the name of the part, while the command palette uses the action title.
  MenuRegistry.appendMenuItem(MenuId.MenubarAppearanceMenu, {
    command: { id, title: menuTitle, toggled }, group: '2_workbench_layout', order,
  });
}

registerTogglePartAction(
  'workbench.action.toggleSidebarVisibility', Parts.SIDEBAR_PART,
  'Toggle Primary Side Bar Visibility', 'Primary Side Bar', SideBarVisibleContext, 1, 'ctrl+b',
);
registerTogglePartAction(
  'workbench.action.toggleActivityBarVisibility', Parts.ACTIVITYBAR_PART,
  'Toggle Activity Bar Visibility', 'Activity Bar', ActivityBarVisibleContext, 2,
);
registerTogglePartAction(
  'workbench.action.toggleStatusbarVisibility', Parts.STATUSBAR_PART,
  'Toggle Status Bar Visibility', 'Status Bar', StatusBarVisibleContext, 4,
);
