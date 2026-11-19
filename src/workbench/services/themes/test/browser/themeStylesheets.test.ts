// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { colorRegistry } from '../../../../../platform/theme/common/colorRegistry.js';
import { ColorScheme } from '../../../../../platform/theme/common/themeService.js';

const srcRoot = join(process.cwd(), 'src');

/** Variables the stylesheets read that are not colors; the theme service does not set them. */
const NON_COLOR_VARIABLES = new Set(['--vscode-editor-font-family']);

function stylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? stylesheets(path) : entry.name.endsWith('.css') ? [path] : [];
  });
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
  const css = readFileSync(join(srcRoot, 'workbench/browser/workbench.css'), 'utf8');
  const block = /\.workbench\s*\{([^}]*)\}/.exec(css)![1];
  const variables = [...block.matchAll(/(--vscode-[\w-]+):\s*([^;]+);/g)];
  expect(variables.length).toBeGreaterThan(0);
  for (const [, name, value] of variables) {
    expect(colorRegistry.resolve(name.slice('--vscode-'.length).replace(/-/g, '.'), ColorScheme.DARK), name).toBe(value.trim());
  }
  // Colors come from variables: no hex color is written into a rule of the workbench's own stylesheet.
  const rules = css.replace(/\.workbench\s*\{[^}]*\}/, '');
  expect(rules.match(/#[\da-f]{3,8}\b/gi)).toBeNull();
});
