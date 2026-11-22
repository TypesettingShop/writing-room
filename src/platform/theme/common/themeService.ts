import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';

/** A color's id in a theme, such as `editor.background`. */
export type ColorIdentifier = string;

export enum ColorScheme {
  DARK = 'dark',
  LIGHT = 'light',
  HIGH_CONTRAST_DARK = 'hcDark',
  HIGH_CONTRAST_LIGHT = 'hcLight',
}

/** One TextMate token color rule, as a color theme's `tokenColors` holds it. */
export interface ITokenColorizationRule {
  readonly name?: string;
  /** Scope selectors; without one the rule sets the defaults. */
  readonly scope?: string | readonly string[];
  readonly settings: {
    readonly foreground?: string;
    readonly background?: string;
    readonly fontStyle?: string;
  };
}

export interface IColorTheme {
  readonly id: string;
  readonly label: string;
  readonly type: ColorScheme;
  /** The CSS color (`#rrggbb` or `#rrggbbaa`) the theme gives `color`, or `undefined` when it gives none. */
  getColor(color: ColorIdentifier): string | undefined;
  defines(color: ColorIdentifier): boolean;
  readonly tokenColors: readonly ITokenColorizationRule[];
  readonly semanticHighlighting: boolean;
}

export const IThemeService = createDecorator<IThemeService>('themeService');

/**
 * The current color theme. The editor part registers an implementation that has the one dark theme
 * the workbench's stylesheet draws; the theme member registers the real one under the same
 * identifier. Whoever paints with a theme's colors listens to `onDidColorThemeChange`.
 */
export interface IThemeService extends BrandedService {
  getColorTheme(): IColorTheme;
  readonly onDidColorThemeChange: Event<IColorTheme>;
}

/** The CSS custom property a color is published as, as VS Code names it: `editor.background` is `--vscode-editor-background`. */
export function asCssVariableName(color: ColorIdentifier): string {
  return `--vscode-${color.replace(/\./g, '-')}`;
}

/**
 * The colors `workbench.css` sets on `.workbench`, by color id. They are the stylesheet's values;
 * a test holds the two together.
 */
const DEFAULT_DARK_COLORS: Readonly<Record<ColorIdentifier, string>> = {
  'editor.background': '#171b24',
  'editor.foreground': '#d7dfec',
  'titleBar.activeBackground': '#232b39',
  'titleBar.activeForeground': '#eaf0f9',
  'activityBar.background': '#1a202c',
  'activityBar.foreground': '#a5b3c8',
  'activityBar.activeBorder': '#90baff',
  'sideBar.background': '#202735',
  'sideBar.foreground': '#d1daea',
  'sideBarSectionHeader.background': '#262f40',
  'panel.background': '#181d27',
  'panel.border': '#4a596e',
  'panelTitle.activeBorder': '#90baff',
  'statusBar.background': '#20334e',
  'statusBar.foreground': '#d8e8ff',
  'menu.background': '#232c3d',
  'menu.foreground': '#e0e8f6',
  'menu.selectionBackground': '#364663',
  'menu.border': '#465672',
  'focusBorder': '#9dc3ff',
  'sash.hoverBorder': '#78aaff',
};

/** Enough token colors to tell comments, strings, keywords and numbers apart, close to Monaco's `vs-dark`. */
const DEFAULT_DARK_TOKEN_COLORS: readonly ITokenColorizationRule[] = [
  { settings: { foreground: '#d7dfec', background: '#171b24' } },
  { scope: 'comment', settings: { foreground: '#6a9955' } },
  { scope: ['string', 'markup.inline.raw'], settings: { foreground: '#ce9178' } },
  { scope: ['keyword', 'storage', 'markup.heading'], settings: { foreground: '#569cd6' } },
  { scope: 'constant.numeric', settings: { foreground: '#b5cea8' } },
  { scope: 'markup.bold', settings: { fontStyle: 'bold' } },
  { scope: 'markup.italic', settings: { fontStyle: 'italic' } },
];

class DefaultDarkColorTheme implements IColorTheme {
  readonly id = 'writing-room-dark';
  readonly label = 'Writing Room Dark';
  readonly type = ColorScheme.DARK;
  readonly tokenColors = DEFAULT_DARK_TOKEN_COLORS;
  readonly semanticHighlighting = false;

  getColor(color: ColorIdentifier): string | undefined {
    return Object.hasOwn(DEFAULT_DARK_COLORS, color) ? DEFAULT_DARK_COLORS[color] : undefined;
  }

  defines(color: ColorIdentifier): boolean {
    return Object.hasOwn(DEFAULT_DARK_COLORS, color);
  }
}

/** The theme service the workbench starts with: the one dark theme of v0.1.0, which never changes. */
export class DefaultThemeService implements IThemeService {
  declare readonly _serviceBrand: undefined;
  private readonly theme = new DefaultDarkColorTheme();
  readonly onDidColorThemeChange: Event<IColorTheme> = Event.None;

  getColorTheme(): IColorTheme {
    return this.theme;
  }
}
