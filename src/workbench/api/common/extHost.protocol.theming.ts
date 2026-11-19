import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

/** `vscode.ColorThemeKind`: Light 1, Dark 2, HighContrast 3, HighContrastLight 4. */
export type ColorThemeKindDto = 1 | 2 | 3 | 4;

export interface MainThreadThemingShape {
  /** The kind of the current color theme, as of the moment the request is handled. */
  $getColorThemeKind(): Promise<ColorThemeKindDto>;
}

export interface ExtHostThemingShape {
  /** Sent once for every change of color theme, whether or not its kind changed. */
  $onColorThemeChange(kind: ColorThemeKindDto): Promise<void>;
}

export const MainThreadThemingProxy = createProxyIdentifier<MainThreadThemingShape>('MainThreadTheming');
export const ExtHostThemingProxy = createProxyIdentifier<ExtHostThemingShape>('ExtHostTheming');
