// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { colorRegistry } from '../../../../../platform/theme/common/colorRegistry.js';
import { ColorScheme, DefaultThemeService } from '../../../../../platform/theme/common/themeService.js';

const srcRoot = join(process.cwd(), 'src');
const workbenchCss = readFileSync(join(srcRoot, 'workbench/browser/workbench.css'), 'utf8');
const firstPaintRule = /\.workbench\s*\{[^}]*\}/;

/** Variables the stylesheets read that are not colors; the theme service does not set them. */
const NON_COLOR_VARIABLES = new Set(['--vscode-editor-font-family']);

function stylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? stylesheets(path) : entry.name.endsWith('.css') ? [path] : [];
  });
}

function firstPaintColors(): Map<string, string> {
  const [rule] = workbenchCss.match(firstPaintRule)!;
  return new Map([...rule.matchAll(/--vscode-([\w-]+):\s*([^;]+);/g)]
    .map(([, name, value]) => [name.replace(/-/g, '.'), value.trim()]));
}

test('every color variable a stylesheet reads is registered and set by both built-in themes', () => {
  const used = new Map<string, string>();
  for (const file of stylesheets(srcRoot)) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/var\(\s*(--vscode-[\w-]+)/g)) {
      used.set(name, relative(srcRoot, file));
    }
  }
  expect(used.size).toBeGreaterThan(20);
  for (const [name, file] of used) {
    if (NON_COLOR_VARIABLES.has(name)) {
      continue;
    }
    // A color id has no dashes, so the variable's dashes are the id's dots.
    const id = name.slice('--vscode-'.length).replace(/-/g, '.');
    expect(colorRegistry.getColor(id), `${name} in ${file} is not a registered color`).toBeDefined();
    for (const scheme of [ColorScheme.DARK, ColorScheme.LIGHT]) {
      expect(colorRegistry.resolve(id, scheme), `${name} in ${file} has no ${scheme} value`).toBeDefined();
    }
  }
});

test('the variables workbench.css sets for the first paint are the dark theme\'s values', () => {
  const colors = firstPaintColors();
  expect(colors.size).toBeGreaterThan(0);
  for (const [id, value] of colors) {
    expect(colorRegistry.resolve(id, ColorScheme.DARK), id).toBe(value);
  }
  // Colors come from variables: no hex color is written into a rule of the workbench's own stylesheet.
  const rules = workbenchCss.replace(firstPaintRule, '');
  expect(rules.match(/#[\da-f]{3,8}\b/gi)).toBeNull();
});

test('DefaultThemeService uses the workbench first-paint colors', () => {
  const theme = new DefaultThemeService().getColorTheme();
  const colors = firstPaintColors();
  expect(colors.size).toBeGreaterThan(0);
  for (const [id, value] of colors) {
    expect(theme.getColor(id), id).toBe(value);
  }
});
