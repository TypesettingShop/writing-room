import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import type { KeybindingSpec } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { ActivityBarVisibleContext, SideBarVisibleContext, StatusBarVisibleContext } from '../../common/contextkeys.js';
import { IViewDescriptorService, ViewContainerLocation, ViewContainerLocationContext } from '../../common/views.js';
import { IViewsService } from '../../services/views/browser/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../services/layout/browser/layoutService.js';

export function registerTogglePartAction(
  id: string, part: Parts, title: string, menuTitle: string, context: RawContextKey<boolean>, order: number, key?: KeybindingSpec,
): void {
  const toggled = context.isEqualTo(true);
  registerAction2(class extends Action2 {
    constructor() {
      super({
        id, title, f1: true, category: 'View', toggled,
        keybinding: key !== undefined ? { primary: key, weight: KeybindingWeight.WorkbenchContrib } : undefined,
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
  'Toggle Primary Side Bar Visibility', 'Primary Side Bar', SideBarVisibleContext, 1, KeyMod.CtrlCmd | KeyCode.KeyB,
);
registerTogglePartAction(
  'workbench.action.toggleActivityBarVisibility', Parts.ACTIVITYBAR_PART,
  'Toggle Activity Bar Visibility', 'Activity Bar', ActivityBarVisibleContext, 2,
);
registerTogglePartAction(
  'workbench.action.toggleStatusbarVisibility', Parts.STATUSBAR_PART,
  'Toggle Status Bar Visibility', 'Status Bar', StatusBarVisibleContext, 4,
);

registerAction2(class extends Action2 {
  constructor() {
    super({ id: 'workbench.action.resetViewLocations', title: 'Reset View Locations', category: 'View', f1: true });
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IViewDescriptorService).resetViewLocations();
  }
});

for (const move of [
  { from: ViewContainerLocation.Sidebar, to: ViewContainerLocation.Panel, id: 'workbench.action.moveViewContainerToPanel', title: 'Move to Panel' },
  { from: ViewContainerLocation.Panel, to: ViewContainerLocation.Sidebar, id: 'workbench.action.moveViewContainerToSidebar', title: 'Move to Side Bar' },
]) {
  registerAction2(class extends Action2 {
    constructor() {
      super({ id: move.id, title: move.title, menu: {
        id: MenuId.ViewContainerTitleContext, when: ViewContainerLocationContext.isEqualTo(move.from),
      } });
    }

    override async run(accessor: ServicesAccessor, id: string): Promise<void> {
      const descriptors = accessor.get(IViewDescriptorService);
      const container = descriptors.getViewContainerById(id);
      if (container && descriptors.getViewContainerLocation(container) === move.from) {
        const views = accessor.get(IViewsService);
        descriptors.moveViewContainerToLocation(container, move.to);
        await views.openViewContainer(id, true);
      }
    }
  });
}
