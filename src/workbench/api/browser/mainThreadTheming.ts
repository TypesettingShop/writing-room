import type { IDisposable } from '../../../base/common/lifecycle.js';
import { ColorScheme, IThemeService } from '../../../platform/theme/common/themeService.js';
import type { IColorTheme } from '../../../platform/theme/common/themeService.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { ExtHostThemingProxy, MainThreadThemingProxy } from '../common/extHost.protocol.theming.js';
import type { ColorThemeKindDto, ExtHostThemingShape, MainThreadThemingShape } from '../common/extHost.protocol.theming.js';

export function colorThemeKind(theme: IColorTheme): ColorThemeKindDto {
  switch (theme.type) {
    case ColorScheme.LIGHT: return 1;
    case ColorScheme.HIGH_CONTRAST_DARK: return 3;
    case ColorScheme.HIGH_CONTRAST_LIGHT: return 4;
    default: return 2;
  }
}

/** Tells the extension host the kind of the color theme when it asks at start, then at every change of theme. */
export class MainThreadTheming implements MainThreadThemingShape, IDisposable {
  private readonly listener: IDisposable;

  constructor(proxy: ExtHostThemingShape, private readonly themes: IThemeService) {
    this.listener = themes.onDidColorThemeChange(theme => {
      void proxy.$onColorThemeChange(colorThemeKind(theme)).catch(() => {});
    });
  }

  async $getColorThemeKind(): Promise<ColorThemeKindDto> {
    return colorThemeKind(this.themes.getColorTheme());
  }

  dispose(): void {
    this.listener.dispose();
  }
}

mainThreadCustomers.register('theming', ({ rpc, instantiation }) => {
  const themes = instantiation.invokeFunction(accessor => accessor.get(IThemeService));
  const main = new MainThreadTheming(rpc.getProxy(ExtHostThemingProxy), themes);
  rpc.set(MainThreadThemingProxy, main);
  return main;
});
