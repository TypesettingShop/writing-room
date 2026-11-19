import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { ColorScheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import '../common/colorExtensionPoint.js';
import { COLOR_THEME_SETTING, isWorkbenchThemeService, WorkbenchThemeService } from './workbenchThemeService.js';
import type { IColorThemeOption } from './workbenchThemeService.js';

// Color themes: the `themes` and `colors` contribution points, the theme service that applies the chosen
// theme, and the command that chooses one. This module is imported after the editor part, so its theme service replaces
// the one that has only the dark palette.
registerSingleton(IThemeService, WorkbenchThemeService);

interface ThemeItem extends IQuickPickItem {
  readonly id: string;
}

const groups: readonly { readonly label: string; readonly types: readonly ColorScheme[] }[] = [
  { label: 'light themes', types: [ColorScheme.LIGHT] },
  { label: 'dark themes', types: [ColorScheme.DARK] },
  { label: 'high contrast themes', types: [ColorScheme.HIGH_CONTRAST_DARK, ColorScheme.HIGH_CONTRAST_LIGHT] },
];

/** The picker's rows: the themes grouped as light, dark and high contrast, each group sorted by label. */
export function themePickItems(themes: readonly IColorThemeOption[]): (ThemeItem | IQuickPickSeparator)[] {
  const items: (ThemeItem | IQuickPickSeparator)[] = [];
  for (const { label, types } of groups) {
    const members = themes.filter(theme => types.includes(theme.type)).sort((a, b) => a.label.localeCompare(b.label));
    if (members.length) {
      items.push({ type: 'separator', label });
      items.push(...members.map(theme => ({ id: theme.settingsId, label: theme.label, description: theme.extensionName })));
    }
  }
  return items;
}

registerAction2(class SelectColorThemeAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.selectTheme', title: 'Color Theme', category: 'Preferences', f1: true,
      menu: { id: MenuId.MenubarPreferencesMenu, group: '4_themes' },
    });
  }

  override run(accessor: ServicesAccessor): Promise<void> {
    const themes = accessor.get(IThemeService);
    if (!isWorkbenchThemeService(themes)) {
      return Promise.resolve();
    }
    const configuration = accessor.get(IConfigurationService);
    const pick = accessor.get(IQuickInputService).createQuickPick<ThemeItem>();
    const items = themePickItems(themes.getColorThemes());
    pick.placeholder = 'Select Color Theme (Up/Down Keys to Preview)';
    pick.items = items;
    // The theme on screen: while the chosen one is missing, that is the default, not the setting's value.
    const applied = themes.getAppliedThemeId();
    const current = items.find((item): item is ThemeItem => item.type !== 'separator' && item.id === applied);
    if (current) {
      pick.activeItems = [current];
    }
    let accepted = false;
    return new Promise<void>(resolve => {
      // Moving through the list shows each theme; only accepting one writes the setting.
      pick.onDidChangeActive(([item]) => themes.previewColorTheme(item?.id));
      pick.onDidAccept(() => {
        const [item] = pick.selectedItems;
        if (!item) {
          return;
        }
        accepted = true;
        pick.hide();
        // The preview holds the theme until the setting names it, so nothing flickers back.
        themes.previewColorTheme(item.id);
        void configuration.updateValue(COLOR_THEME_SETTING, item.id)
          .catch(error => console.error('The color theme could not be saved:', error))
          .finally(() => themes.previewColorTheme(undefined));
      });
      pick.onDidHide(() => {
        if (!accepted) {
          themes.previewColorTheme(undefined);
        }
        pick.dispose();
        resolve();
      });
      pick.show();
    });
  }
});
