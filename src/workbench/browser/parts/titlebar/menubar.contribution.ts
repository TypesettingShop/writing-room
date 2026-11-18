import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';

for (const [submenu, title, order] of [
  [MenuId.MenubarFileMenu, 'File', 1],
  [MenuId.MenubarEditMenu, 'Edit', 2],
  [MenuId.MenubarViewMenu, 'View', 4],
  [MenuId.MenubarHelpMenu, 'Help', 8],
] as const) {
  MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, { submenu, title, order });
}

MenuRegistry.appendMenuItem(MenuId.MenubarViewMenu, {
  submenu: MenuId.MenubarAppearanceMenu, title: 'Appearance', group: '2_appearance', order: 1,
});
MenuRegistry.appendMenuItem(MenuId.MenubarViewMenu, {
  submenu: MenuId.MenubarLayoutMenu, title: 'Editor Layout', group: '2_appearance', order: 2,
});
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
  submenu: MenuId.MenubarPreferencesMenu, title: 'Preferences', group: '5_autosave', order: 2,
});
