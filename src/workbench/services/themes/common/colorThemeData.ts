import { parseJSONC } from '../../../../base/common/jsonc.js';
import type { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import { colorRegistry, isColorIdentifier, isHexColor, normalizeHexColor } from '../../../../platform/theme/common/colorRegistry.js';
import { ColorScheme } from '../../../../platform/theme/common/themeService.js';
import type { ColorIdentifier, IColorTheme, ITokenColorizationRule } from '../../../../platform/theme/common/themeService.js';
import { extensionResourceLimits, resolveExtensionResource } from '../../extensions/common/extensionResources.js';

/** The four `uiTheme` values of `contributes.themes`. */
export type UiTheme = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';

export function isUiTheme(value: unknown): value is UiTheme {
  return value === 'vs' || value === 'vs-dark' || value === 'hc-black' || value === 'hc-light';
}

export function uiThemeToScheme(uiTheme: UiTheme): ColorScheme {
  switch (uiTheme) {
    case 'vs': return ColorScheme.LIGHT;
    case 'hc-black': return ColorScheme.HIGH_CONTRAST_DARK;
    case 'hc-light': return ColorScheme.HIGH_CONTRAST_LIGHT;
    default: return ColorScheme.DARK;
  }
}

export function schemeToUiTheme(scheme: ColorScheme): UiTheme {
  switch (scheme) {
    case ColorScheme.LIGHT: return 'vs';
    case ColorScheme.HIGH_CONTRAST_DARK: return 'hc-black';
    case ColorScheme.HIGH_CONTRAST_LIGHT: return 'hc-light';
    default: return 'vs-dark';
  }
}

/** A theme file includes another at most this deep; a deeper include, such as a file that includes itself, is not read. */
export const MAX_INCLUDE_DEPTH = 5;

/**
 * A color theme: its own colors, already validated, and the registry for the colors it leaves out.
 * `getColor` follows a default that names another color through this theme's colors.
 */
export class ColorThemeData implements IColorTheme {
  constructor(
    readonly id: string,
    readonly label: string,
    readonly type: ColorScheme,
    /** The value `workbench.colorTheme` takes to choose this theme. */
    readonly settingsId: string,
    private readonly colors: ReadonlyMap<ColorIdentifier, string>,
    readonly tokenColors: readonly ITokenColorizationRule[],
    readonly semanticHighlighting: boolean,
    /** The extension that contributed it; built-in themes have none. */
    readonly extensionId?: string,
  ) {}

  getColor(color: ColorIdentifier): string | undefined {
    return colorRegistry.resolve(color, this.type, id => this.colors.get(id));
  }

  defines(color: ColorIdentifier): boolean {
    return this.colors.has(color);
  }

  /** The colors the theme itself gives, which may include ids nothing registered. */
  ownColors(): ReadonlyMap<ColorIdentifier, string> {
    return this.colors;
  }
}

/** What a theme file gives, after validation. */
export interface IColorThemeContent {
  readonly colors: ReadonlyMap<ColorIdentifier, string>;
  readonly tokenColors: readonly ITokenColorizationRule[];
  readonly semanticHighlighting: boolean;
}

const FONT_STYLES = new Set(['italic', 'bold', 'underline', 'strikethrough']);

/** A token rule as a theme file gives it, with only valid fields kept; `undefined` when nothing of it is usable. */
function readTokenRule(value: unknown, path: string, warn: (message: string) => void): ITokenColorizationRule | undefined {
  if (!isRecord(value) || !isRecord(value.settings)) {
    warn(`${path}: a token color rule needs a 'settings' object; the rule is ignored.`);
    return undefined;
  }
  let scope: string | string[] | undefined;
  if (typeof value.scope === 'string') {
    scope = value.scope;
  } else if (Array.isArray(value.scope) && value.scope.every(item => typeof item === 'string')) {
    scope = [...value.scope as string[]];
  } else if (value.scope !== undefined) {
    warn(`${path}.scope: expected a string or an array of strings; the rule is ignored.`);
    return undefined;
  }
  const settings: { foreground?: string; background?: string; fontStyle?: string } = {};
  for (const key of ['foreground', 'background'] as const) {
    const color = value.settings[key];
    if (isHexColor(color)) {
      settings[key] = normalizeHexColor(color);
    } else if (color !== undefined) {
      warn(`${path}.settings.${key}: '${String(color)}' is not a hex color; it is ignored.`);
    }
  }
  const fontStyle = value.settings.fontStyle;
  if (typeof fontStyle === 'string' && fontStyle.split(' ').every(style => !style || FONT_STYLES.has(style))) {
    settings.fontStyle = fontStyle.trim();
  } else if (fontStyle !== undefined) {
    warn(`${path}.settings.fontStyle: '${String(fontStyle)}' is not a font style; it is ignored.`);
  }
  if (settings.foreground === undefined && settings.background === undefined && settings.fontStyle === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...typeof value.name === 'string' ? { name: value.name } : {},
    ...scope !== undefined ? { scope: Object.freeze(scope) } : {},
    settings: Object.freeze(settings),
  });
}

/**
 * `include` taken relative to the directory of `path`, both relative to the extension, with `.` and inner
 * `..` segments folded. A `..` that climbs above the extension stays, and resolving refuses it.
 */
function includedPath(path: string, include: string): string {
  const segments: string[] = [];
  for (const segment of [...path.split('/').slice(0, -1), ...include.split('/')]) {
    if (segment === '..' && segments.length && segments.at(-1) !== '..') {
      segments.pop();
    } else if (segment && segment !== '.') {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

/**
 * Reads the theme file at `path` (relative to the extension, as the manifest gives it) and the files it
 * includes, at most 8 MiB each and never outside the extension. Comments are allowed. A color whose id or
 * value is not valid, a token rule that is not, an include that leaves the extension or goes deeper than
 * five files, `.tmTheme` token files and `semanticTokenColors` are left out with a warning; the rest of
 * the theme stands. A file that cannot be read or parsed fails the whole theme.
 */
export async function readColorThemeFile(
  fileService: IFileService, extensionLocation: URI, path: string, warn: (message: string) => void,
): Promise<IColorThemeContent> {
  const colors = new Map<ColorIdentifier, string>();
  const tokenColors: ITokenColorizationRule[] = [];
  let semanticHighlighting = false;

  async function read(relativePath: string, location: URI, depth: number): Promise<void> {
    const { value } = await fileService.readFile(location, { limits: { size: extensionResourceLimits.resource } });
    const content = parseJSONC(new TextDecoder().decode(value));
    if (!isRecord(content)) {
      throw new Error(`${relativePath} is not a JSON object.`);
    }
    if (content.include !== undefined) {
      const include = content.include;
      if (typeof include !== 'string' || !include) {
        warn(`${relativePath}: 'include' must be a relative path; it is ignored.`);
      } else if (depth >= MAX_INCLUDE_DEPTH) {
        warn(`${relativePath}: '${include}' is not read: includes go at most ${MAX_INCLUDE_DEPTH} files deep.`);
      } else {
        const target = include.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(include)
          ? undefined : includedPath(relativePath, include);
        const included = target === undefined ? undefined : resolveExtensionResource(extensionLocation, target);
        if (!included || target === undefined) {
          warn(`${relativePath}: '${include}' is not a relative path inside the extension; it is not read.`);
        } else {
          // What the file includes comes first, so the file's own values win.
          await read(target, included, depth + 1);
        }
      }
    }
    if (content.colors !== undefined) {
      if (!isRecord(content.colors)) {
        warn(`${relativePath}: 'colors' must be an object; it is ignored.`);
      } else {
        for (const [id, color] of Object.entries(content.colors)) {
          if (!isColorIdentifier(id)) {
            warn(`${relativePath}: '${id}' is not a color id; it is ignored.`);
          } else if (color === 'default') {
            // As in VS Code: back to the registered default, over what an included file gave.
            colors.delete(id);
          } else if (!isHexColor(color)) {
            warn(`${relativePath}: the value of '${id}' is not a hex color (#RGB, #RGBA, #RRGGBB or #RRGGBBAA); it is ignored.`);
          } else {
            colors.set(id, normalizeHexColor(color));
          }
        }
      }
    }
    const rules = content.tokenColors;
    if (typeof rules === 'string') {
      warn(`${relativePath}: token colors from a TextMate theme file ('${rules}') are not supported; they are ignored.`);
    } else if (Array.isArray(rules)) {
      rules.forEach((rule, index) => {
        const valid = readTokenRule(rule, `${relativePath}: tokenColors[${index}]`, warn);
        if (valid) {
          tokenColors.push(valid);
        }
      });
    } else if (rules !== undefined) {
      warn(`${relativePath}: 'tokenColors' must be an array; it is ignored.`);
    }
    if (typeof content.semanticHighlighting === 'boolean') {
      semanticHighlighting = content.semanticHighlighting;
    }
    if (content.semanticTokenColors !== undefined) {
      warn(`${relativePath}: semantic token colors are not supported; they are ignored.`);
    }
  }

  const location = resolveExtensionResource(extensionLocation, path);
  if (!location) {
    throw new Error(`'${path}' is not a relative path inside the extension.`);
  }
  await read(path, location, 0);
  return { colors, tokenColors, semanticHighlighting };
}

/** Warnings past this many for one theme are counted, not printed one by one. */
const MAX_WARNINGS = 20;

/** A warning function for one theme that prints at most twenty, and then how many more there were. */
export function boundedWarnings(prefix: string): { warn(message: string): void; flush(): void } {
  let count = 0;
  return {
    warn(message: string) {
      if (++count <= MAX_WARNINGS) {
        console.warn(prefix + message);
      }
    },
    flush() {
      if (count > MAX_WARNINGS) {
        console.warn(`${prefix}${count - MAX_WARNINGS} more problems were ignored.`);
      }
    },
  };
}
