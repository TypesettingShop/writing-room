import type { IColorTheme } from '../../../platform/theme/common/themeService.js';
import { ColorScheme } from '../../../platform/theme/common/themeService.js';

type Options = Record<string, unknown>;

export function decorationOptions(value: unknown): Options {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Options : {};
}

const invalidCss = /[;{}<>\\\x00-\x1f\x7f]|\/\*|url\s*\(|var\s*\(/i;
const color = /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?)\([\d.,% /+-]+\))$/i;
const length = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:px|em|rem|ch|ex|%|pt)?';
const sizes = new RegExp('^' + length + '(?: +' + length + '){0,3}$', 'i');
const names = /^[a-z0-9%#(),. /+-]+$/i;
const styles: Readonly<Record<string, [string, RegExp]>> = {
  color: ['color', color],
  backgroundColor: ['background-color', color],
  outlineColor: ['outline-color', color],
  borderColor: ['border-color', color],
  borderRadius: ['border-radius', sizes],
  borderSpacing: ['border-spacing', sizes],
  outlineWidth: ['outline-width', sizes],
  borderWidth: ['border-width', sizes],
  letterSpacing: ['letter-spacing', sizes],
  outlineStyle: ['outline-style', /^(?:none|solid|dotted|dashed|double|groove|ridge|inset|outset)$/i],
  borderStyle: ['border-style', /^(?:none|hidden|solid|dotted|dashed|double|groove|ridge|inset|outset)(?: +[a-z]+){0,3}$/i],
  outline: ['outline', names],
  border: ['border', names],
  fontStyle: ['font-style', /^(?:normal|italic|oblique)$/i],
  fontWeight: ['font-weight', /^(?:normal|bold|lighter|bolder|[1-9]00)$/i],
  textDecoration: ['text-decoration', names],
  opacity: ['opacity', /^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/],
  cursor: ['cursor', /^(?:auto|default|pointer|text|crosshair|help|move|not-allowed|wait|grab|grabbing)$/i],
};
const attachmentStyles = {
  ...styles,
  margin: ['margin', sizes],
  width: ['width', sizes],
  height: ['height', sizes],
} satisfies Record<string, [string, RegExp]>;

function cssValue(value: unknown, grammar: RegExp): string | undefined {
  if (typeof value === 'string' && value.length <= 200 && !invalidCss.test(value) && grammar.test(value.trim())) {
    return value.trim();
  }
  return undefined;
}

export function decorationColor(value: unknown, theme: IColorTheme): string | undefined {
  const id = decorationOptions(value).id;
  return cssValue(typeof id === 'string' ? theme.getColor(id) : value, color);
}

export function cssString(value: string): string {
  return '"' + value.replace(/["\\\x00-\x1f\x7f<>]/g, char => '\\' + char.charCodeAt(0).toString(16) + ' ') + '"';
}

export function decorationCss(options: Options, theme: IColorTheme, attachment = false): string {
  const properties = attachment ? attachmentStyles : styles;
  const declarations = [];
  for (const [key, [property, grammar]] of Object.entries(properties)) {
    const value = grammar === color ? decorationColor(options[key], theme) : cssValue(options[key], grammar);
    if (value) {
      declarations.push(property + ':' + value);
    }
  }
  return declarations.join(';');
}

export function themedDecoration(options: Options, theme: IColorTheme): Options {
  const variant = decorationOptions(theme.type === ColorScheme.LIGHT || theme.type === ColorScheme.HIGH_CONTRAST_LIGHT
    ? options.light : options.dark);
  return {
    ...options, ...variant,
    before: { ...decorationOptions(options.before), ...decorationOptions(variant.before) },
    after: { ...decorationOptions(options.after), ...decorationOptions(variant.after) },
  };
}

export function decorationIconSize(value: unknown): string | undefined {
  return value === 'contain' || value === 'cover' ? value : cssValue(value, sizes);
}
