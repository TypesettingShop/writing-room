import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { MonacoNamespace } from '../../../../editor/browser/monaco.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { configurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { onDidLoadEditor } from '../../../../platform/theme/browser/editorThemeHook.js';
import { asCssVariableName, colorRegistry, isColorIdentifier } from '../../../../platform/theme/common/colorRegistry.js';
import { ColorScheme, DefaultThemeService } from '../../../../platform/theme/common/themeService.js';
import type { ColorIdentifier, IColorTheme, IThemeService, ITokenColorizationRule } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchLayoutService } from '../../layout/browser/layoutService.js';
import { boundedWarnings, ColorThemeData, readColorThemeFile, schemeToUiTheme, uiThemeToScheme } from '../common/colorThemeData.js';
import { reserveThemeSettingsId, themeContributionKey, themeContributions } from '../common/themeExtensionPoints.js';
import type { IThemeContribution } from '../common/themeExtensionPoints.js';

export const COLOR_THEME_SETTING = 'workbench.colorTheme';
export const DEFAULT_DARK_THEME_SETTINGS_ID = 'Writing Room Dark';
export const DEFAULT_LIGHT_THEME_SETTINGS_ID = 'Writing Room Light';

reserveThemeSettingsId(DEFAULT_DARK_THEME_SETTINGS_ID);
reserveThemeSettingsId(DEFAULT_LIGHT_THEME_SETTINGS_ID);

configurationRegistry.registerConfiguration({
  id: 'workbench.appearance',
  title: 'Appearance',
  properties: {
    [COLOR_THEME_SETTING]: {
      type: 'string', default: DEFAULT_DARK_THEME_SETTINGS_ID,
      description: 'The color theme of the workbench and the editor: a built-in theme\'s name, or the id (else the label) of a theme an extension contributes.',
    },
  },
});

/** Token colors of the built-in light theme, enough to tell comments, strings, keywords and numbers apart. */
const LIGHT_TOKEN_COLORS: readonly ITokenColorizationRule[] = [
  { settings: { foreground: '#1f2633', background: '#fbfcfe' } },
  { scope: 'comment', settings: { foreground: '#5f7f4a' } },
  { scope: ['string', 'markup.inline.raw'], settings: { foreground: '#a33a2a' } },
  { scope: ['keyword', 'storage', 'markup.heading'], settings: { foreground: '#2457c5' } },
  { scope: 'constant.numeric', settings: { foreground: '#18794e' } },
  { scope: 'markup.bold', settings: { fontStyle: 'bold' } },
  { scope: 'markup.italic', settings: { fontStyle: 'italic' } },
];

/** A built-in theme gives every built-in color a value of its kind, so it defines each of them. */
function builtinTheme(id: string, label: string, type: ColorScheme, tokenColors: readonly ITokenColorizationRule[]): ColorThemeData {
  const colors = new Map<ColorIdentifier, string>();
  for (const { id: color, extensionId } of colorRegistry.getColors()) {
    const value = extensionId ? undefined : colorRegistry.resolve(color, type);
    if (value !== undefined) {
      colors.set(color, value);
    }
  }
  return new ColorThemeData(id, label, type, label, colors, tokenColors, false);
}

/** One theme the picker offers. */
export interface IColorThemeOption {
  readonly settingsId: string;
  readonly label: string;
  readonly type: ColorScheme;
  /** The display name of the extension that contributed it. */
  readonly extensionName?: string;
}

/** The kind classes on the workbench container: VS Code's names, which Webview bodies and decorations read. */
const KIND_CLASSES = ['vs', 'vs-dark', 'hc-black', 'hc-light'];

/** The one name every non-default theme is defined under in Monaco: only letters, digits and dashes. */
export const MONACO_THEME_NAME = 'writing-room-theme';

/** Monaco token rules for the simple scopes (`comment`, `string.quoted`) of a theme's token colors. */
export function monacoTokenRules(tokenColors: readonly ITokenColorizationRule[]): { token: string; foreground?: string; background?: string; fontStyle?: string }[] {
  // Monaco takes six hex digits, without the `#` and without alpha.
  const hex = (value: string | undefined) => value === undefined ? undefined : value.slice(1, 7);
  const rules: { token: string; foreground?: string; background?: string; fontStyle?: string }[] = [];
  for (const { scope, settings } of tokenColors) {
    const scopes = scope === undefined ? [''] : (typeof scope === 'string' ? scope.split(',') : [...scope]).map(item => item.trim());
    for (const token of scopes) {
      if (token === '' && scope !== undefined) {
        continue;
      }
      if (token && !/^[\w-]+(?:\.[\w-]+)*$/.test(token)) {
        continue;
      }
      rules.push({
        token,
        ...settings.foreground ? { foreground: hex(settings.foreground) } : {},
        ...settings.background ? { background: hex(settings.background) } : {},
        ...settings.fontStyle !== undefined ? { fontStyle: settings.fontStyle } : {},
      });
    }
  }
  return rules;
}

/**
 * The workbench's color themes: two built in, a dark one (v0.1.0's palette) and a light one, and those
 * extensions contribute. `workbench.colorTheme` names the chosen one. While it names a theme that is not
 * there — its extension is not registered yet, or was removed — the default dark theme shows and the
 * setting stays as it is, so the theme comes back with its extension.
 *
 * Applying a theme sets every registered color, and the colors the theme names that nothing registered,
 * as CSS variables on the workbench container, with a kind class; gives Monaco its colors; and then fires
 * `onDidColorThemeChange`, once per change of theme. Applying the same theme again fires nothing.
 */
export class WorkbenchThemeService extends Disposable implements IThemeService {
  declare readonly _serviceBrand: undefined;

  private readonly changed = this._register(new Emitter<IColorTheme>());
  readonly onDidColorThemeChange: Event<IColorTheme> = this.changed.event;

  private readonly builtinThemes: readonly ColorThemeData[];
  private current: ColorThemeData;
  private preview: string | undefined;
  private contributions = new Map<string, IThemeContribution>();
  private contributionsKey = '';
  /** Theme files read so far, by contribution key. A failed read stays failed until the contribution changes. */
  private readonly loaded = new Map<string, Promise<ColorThemeData | undefined>>();
  /** Bumped by each request for a theme; a file read for an earlier one is dropped when it arrives. */
  private request = 0;
  private readonly cssVariables = new Set<string>();
  private monaco: MonacoNamespace | undefined;

  constructor(
    @IConfigurationService private readonly configuration: IConfigurationService,
    @IFileService private readonly fileService: IFileService,
    @IWorkbenchLayoutService private readonly layout: Pick<IWorkbenchLayoutService, 'mainContainer'>,
  ) {
    super();
    const dark = new DefaultThemeService().getColorTheme();
    this.builtinThemes = [
      builtinTheme(dark.id, DEFAULT_DARK_THEME_SETTINGS_ID, ColorScheme.DARK, dark.tokenColors),
      builtinTheme('writing-room-light', DEFAULT_LIGHT_THEME_SETTINGS_ID, ColorScheme.LIGHT, LIGHT_TOKEN_COLORS),
    ];
    this.current = this.builtinThemes[0];
    this.applyCss(this.current);
    this.readContributions();
    this.update();

    this._register(configuration.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(COLOR_THEME_SETTING)) {
        this.update();
      }
    }));
    this._register(themeContributions.onDidChange(() => {
      // The extension service applies every contribution again when the theme changes; unchanged, they change nothing.
      if (this.readContributions()) {
        this.update();
      }
    }));
    // A contributed color changes what the CSS variables are, not which theme is current.
    this._register(colorRegistry.onDidChangeSchema(() => this.applyCss(this.current)));
    this._register(this.watchMonaco(monaco => {
      this.monaco = monaco;
      this.applyMonaco(this.current);
    }));
  }

  /** Overridden by tests, which have no editor package. */
  protected watchMonaco(listener: (monaco: MonacoNamespace) => void): IDisposable {
    return onDidLoadEditor<MonacoNamespace>(listener);
  }

  getColorTheme(): IColorTheme {
    return this.current;
  }

  /** The themes there are now: the built-in ones, then the contributed ones in extension order. */
  getColorThemes(): readonly IColorThemeOption[] {
    return [
      ...this.builtinThemes.map(({ settingsId, label, type }) => ({ settingsId, label, type })),
      ...[...this.contributions.values()].map(({ settingsId, label, uiTheme, extensionName }) =>
        ({ settingsId, label, type: uiThemeToScheme(uiTheme), extensionName })),
    ];
  }

  /** The settings id of the theme applied now, which is not the setting's value while that theme is missing. */
  getAppliedThemeId(): string {
    return this.current.settingsId;
  }

  /** The setting's value: the chosen theme, whether or not it is there now. */
  getConfiguredThemeId(): string {
    const value = this.configuration.getValue<unknown>(COLOR_THEME_SETTING);
    return typeof value === 'string' && value ? value : DEFAULT_DARK_THEME_SETTINGS_ID;
  }

  /** Shows the theme `settingsId` without writing the setting; `undefined` goes back to the setting's theme. */
  previewColorTheme(settingsId: string | undefined): void {
    if (this.preview !== settingsId) {
      this.preview = settingsId;
      this.update();
    }
  }

  /** Reads the contributions; `true` when they differ from those read before. */
  private readContributions(): boolean {
    const current = themeContributions.current;
    const key = JSON.stringify(current.map(themeContributionKey));
    if (key === this.contributionsKey) {
      return false;
    }
    this.contributionsKey = key;
    this.contributions = new Map(current.map(theme => [theme.settingsId, theme]));
    const live = new Set(current.map(themeContributionKey));
    for (const loadedKey of [...this.loaded.keys()]) {
      if (!live.has(loadedKey)) {
        this.loaded.delete(loadedKey);
      }
    }
    return true;
  }

  private update(): void {
    const mine = ++this.request;
    const wanted = this.preview ?? this.getConfiguredThemeId();
    const builtin = this.builtinThemes.find(theme => theme.settingsId === wanted);
    const contribution = builtin ? undefined : this.contributions.get(wanted);
    if (!contribution) {
      // Missing or built in: the setting is left as it is, so the theme returns with its extension.
      this.apply(builtin ?? this.builtinThemes[0]);
      return;
    }
    void this.load(contribution).then(theme => {
      if (mine === this.request) {
        this.apply(theme ?? this.builtinThemes[0]);
      }
    });
  }

  private load(contribution: IThemeContribution): Promise<ColorThemeData | undefined> {
    const key = themeContributionKey(contribution);
    let theme = this.loaded.get(key);
    if (!theme) {
      const { extensionId, extensionLocation, path, label, settingsId, uiTheme } = contribution;
      const warnings = boundedWarnings(`[${extensionId}] `);
      theme = readColorThemeFile(this.fileService, extensionLocation, path, warnings.warn).then(
        content => new ColorThemeData(`${extensionId}-${settingsId}`, label, uiThemeToScheme(uiTheme), settingsId,
          content.colors, content.tokenColors, content.semanticHighlighting, extensionId),
        error => {
          warnings.warn(`${path}: the color theme '${label}' could not be read: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }).finally(() => warnings.flush());
      this.loaded.set(key, theme);
    }
    return theme;
  }

  private apply(theme: ColorThemeData): void {
    if (theme === this.current) {
      return;
    }
    this.current = theme;
    this.applyCss(theme);
    // Synchronously, before the event: TextMate tokenization reads Monaco's colors a task after it.
    this.applyMonaco(theme);
    this.changed.fire(theme);
  }

  private applyCss(theme: ColorThemeData): void {
    const container = this.layout.mainContainer;
    const values = new Map<string, string>();
    for (const { id } of colorRegistry.getColors()) {
      const value = theme.getColor(id);
      if (value !== undefined) {
        values.set(asCssVariableName(id), value);
      }
    }
    for (const [id, value] of theme.ownColors()) {
      // Ids nothing registered are published too, as VS Code does; they were checked when the file was read.
      if (isColorIdentifier(id)) {
        values.set(asCssVariableName(id), value);
      }
    }
    for (const name of this.cssVariables) {
      if (!values.has(name)) {
        container.style.removeProperty(name);
      }
    }
    this.cssVariables.clear();
    for (const [name, value] of values) {
      container.style.setProperty(name, value);
      this.cssVariables.add(name);
    }
    const kind = schemeToUiTheme(theme.type);
    container.classList.remove(...KIND_CLASSES.filter(name => name !== kind));
    container.classList.add(kind);
  }

  private applyMonaco(theme: ColorThemeData): void {
    const monaco = this.monaco;
    if (!monaco) {
      return;
    }
    try {
      if (theme === this.builtinThemes[0]) {
        // The default dark theme is v0.1.0's editor: Monaco's own `vs-dark`, untouched.
        monaco.editor.setTheme('vs-dark');
        return;
      }
      monaco.editor.defineTheme(MONACO_THEME_NAME, {
        base: schemeToUiTheme(theme.type),
        inherit: true,
        colors: Object.fromEntries(theme.ownColors()),
        rules: monacoTokenRules(theme.tokenColors),
      });
      monaco.editor.setTheme(MONACO_THEME_NAME);
    } catch (error) {
      console.error(`The editor could not take the color theme '${theme.label}':`, error);
      monaco.editor.setTheme(schemeToUiTheme(theme.type));
    }
  }
}

/** Whether `service` is the workbench's theme service, which can list and preview themes. */
export function isWorkbenchThemeService(service: IThemeService): service is WorkbenchThemeService {
  return service instanceof WorkbenchThemeService;
}
