import { expect, test } from 'vitest';
import {
  asCssVariableName, colorRegistry, isColorIdentifier, isHexColor, normalizeHexColor,
} from '../../common/colorRegistry.js';
import { ColorScheme } from '../../common/themeService.js';

/** The colors the tree view's stylesheet reads; both built-in themes must give each a value. */
const TREE_VIEW_COLORS = [
  'foreground', 'descriptionForeground', 'errorForeground', 'disabledForeground', 'icon.foreground', 'focusBorder',
  'contrastBorder', 'textLink.foreground', 'textLink.activeForeground', 'list.hoverBackground', 'list.hoverForeground',
  'list.activeSelectionBackground', 'list.activeSelectionForeground', 'list.inactiveSelectionBackground',
  'list.inactiveSelectionForeground', 'list.focusOutline', 'list.focusBackground', 'list.dropBackground',
  'list.highlightForeground', 'tree.indentGuidesStroke', 'badge.background', 'badge.foreground',
  'activityBarBadge.background', 'activityBarBadge.foreground', 'checkbox.background', 'checkbox.foreground',
  'checkbox.border', 'checkbox.selectBackground', 'sideBar.background', 'sideBar.foreground', 'sideBarTitle.foreground',
  'sideBarSectionHeader.background', 'sideBarSectionHeader.foreground', 'charts.red', 'charts.blue', 'charts.yellow',
  'charts.orange', 'charts.green', 'charts.purple', 'charts.foreground', 'button.background', 'button.foreground',
  'button.hoverBackground', 'input.background', 'input.foreground', 'input.border', 'progressBar.background', 'widget.shadow',
];

/**
 * What v0.1.0 drew: the variables `workbench.css` set, and for variables nothing set, the fallback the
 * stylesheet that reads them gave. The default dark theme must compute the same.
 */
const V010_DARK_COLORS: Readonly<Record<string, string>> = {
  'editor.background': '#171b24', 'editor.foreground': '#d7dfec',
  'titleBar.activeBackground': '#232b39', 'titleBar.activeForeground': '#eaf0f9',
  'activityBar.background': '#1a202c', 'activityBar.foreground': '#a5b3c8', 'activityBar.activeBorder': '#90baff',
  'sideBar.background': '#202735', 'sideBar.foreground': '#d1daea', 'sideBarSectionHeader.background': '#262f40',
  'panel.background': '#181d27', 'panel.border': '#313c50', 'panelTitle.activeBorder': '#90baff',
  'statusBar.background': '#20334e', 'statusBar.foreground': '#d8e8ff',
  'menu.background': '#232c3d', 'menu.foreground': '#e0e8f6', 'menu.selectionBackground': '#364663', 'menu.border': '#465672',
  'focusBorder': '#9dc3ff', 'sash.hoverBorder': '#78aaff',
  // Fallbacks of the other stylesheets.
  'list.activeSelectionBackground': '#04395e', 'list.activeSelectionForeground': '#ffffff',
  'list.hoverBackground': '#ffffff12', 'list.inactiveSelectionBackground': '#37373d', 'list.dropBackground': '#383b3d',
  'input.background': '#3c3c3c', 'inputValidation.errorBorder': '#be1100', 'inputValidation.errorBackground': '#5a1d1d',
  'editorGroupHeader.tabsBackground': '#1c212c', 'tab.inactiveForeground': '#8b97ab', 'tab.inactiveBackground': '#1c212c',
  'tab.border': '#252c3a', 'tab.activeForeground': '#eaf0f9', 'tab.activeBackground': '#171b24',
  'tab.activeBorderTop': '#90baff', 'tab.dragAndDropBorder': '#eaf0f9', 'editorGroup.dropBackground': '#53595d80',
  'textLink.foreground': '#7fb2ff',
  // `inherit` in the side bar, where the explorer draws them.
  'input.foreground': '#d1daea', 'foreground': '#d1daea',
  // Hard-coded colors of workbench.css that became variables.
  'titleBar.iconForeground': '#a9caff', 'descriptionForeground': '#a7b6cb', 'disabledForeground': '#a7b6cb',
};

test('the default dark values are what v0.1.0 drew', () => {
  for (const [id, value] of Object.entries(V010_DARK_COLORS)) {
    expect(colorRegistry.resolve(id, ColorScheme.DARK), id).toBe(value);
  }
});

test('both built-in kinds give every color the tree view reads', () => {
  for (const id of TREE_VIEW_COLORS) {
    for (const scheme of [ColorScheme.DARK, ColorScheme.LIGHT]) {
      expect(colorRegistry.resolve(id, scheme), `${id} in ${scheme}`).toMatch(/^#[\da-f]{6}(?:[\da-f]{2})?$/);
    }
  }
});

test('registers about 150 colors with valid defaults', () => {
  const colors = colorRegistry.getColors().filter(color => !color.extensionId);
  expect(colors.length).toBeGreaterThanOrEqual(150);
  for (const { id, defaults, description } of colors) {
    expect(isColorIdentifier(id), id).toBe(true);
    expect(description, id).not.toBe('');
    for (const value of Object.values(defaults)) {
      if (value !== null && !isHexColor(value)) {
        // A reference names a registered color.
        expect(colorRegistry.getColor(value), `${id} -> ${value}`).toBeDefined();
      }
    }
  }
});

test('color ids follow VS Code\'s pattern and can only make one CSS token', () => {
  for (const id of ['foreground', 'editor.background', 'myExtension.fancy_color', 'a1.b2.c3']) {
    expect(isColorIdentifier(id), id).toBe(true);
  }
  for (const id of ['', '.leading', 'a b', 'red; } body{', 'a-b', 'url(x)', 'a/b', 'é', 42, undefined, 'x'.repeat(257)]) {
    expect(isColorIdentifier(id), String(id)).toBe(false);
  }
  expect(asCssVariableName('editor.background')).toBe('--vscode-editor-background');
});

test('only the four hex notations are colors', () => {
  for (const value of ['#abc', '#ABCD', '#a1b2c3', '#a1b2c3d4']) {
    expect(isHexColor(value), value).toBe(true);
  }
  for (const value of ['red', '#ab', '#abcde', '#abcdefg', 'abc', 'rgb(1,2,3)', 'red; } body{', 'url(x)', ' #abc', '#abc ', '#a1b2c3d4e', null]) {
    expect(isHexColor(value), String(value)).toBe(false);
  }
  expect(normalizeHexColor('#AbC')).toBe('#aabbcc');
  expect(normalizeHexColor('#abcd')).toBe('#aabbccdd');
  expect(normalizeHexColor('#A1B2C3')).toBe('#a1b2c3');
});

test('a theme\'s own color wins, and references follow the theme', () => {
  const theme: Record<string, string> = { 'editor.background': '#102030' };
  const own = (id: string) => theme[id];
  // `tab.activeBackground` defaults to whatever `editor.background` is in the same theme.
  expect(colorRegistry.resolve('tab.activeBackground', ColorScheme.DARK, own)).toBe('#102030');
  expect(colorRegistry.resolve('tab.activeBackground', ColorScheme.LIGHT)).toBe('#fbfcfe');
  theme['tab.activeBackground'] = '#405060';
  expect(colorRegistry.resolve('tab.activeBackground', ColorScheme.DARK, own)).toBe('#405060');
  expect(colorRegistry.resolve('unknown.color', ColorScheme.DARK)).toBeUndefined();
  expect(colorRegistry.resolve('selection.background', ColorScheme.DARK)).toBeUndefined();
});

test('a cycle of references gives no color instead of looping', () => {
  colorRegistry.registerColor('test.cycleA', { dark: 'test.cycleB', light: null, hcDark: null, hcLight: null }, 'a', 'test.ext');
  colorRegistry.registerColor('test.cycleB', { dark: 'test.cycleA', light: null, hcDark: null, hcLight: null }, 'b', 'test.ext');
  try {
    expect(colorRegistry.resolve('test.cycleA', ColorScheme.DARK)).toBeUndefined();
  } finally {
    colorRegistry.deregisterColor('test.cycleA');
    colorRegistry.deregisterColor('test.cycleB');
  }
  expect(() => colorRegistry.registerColor('bad id', { dark: null, light: null, hcDark: null, hcLight: null }, 'x')).toThrow();
  expect(() => colorRegistry.registerColor('test.bad', { dark: 'red;}', light: null, hcDark: null, hcLight: null }, 'x')).toThrow();
});
