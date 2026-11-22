import { Emitter } from '../../../base/common/event.js';
import type { Event } from '../../../base/common/event.js';
import { asCssVariableName, ColorScheme } from './themeService.js';
import type { ColorIdentifier } from './themeService.js';

export { asCssVariableName };
export type { ColorIdentifier };

/**
 * A color's default in one kind of theme: a hex color, the id of another color (whatever that color is in
 * the same theme), or `null` for none, which leaves the CSS variable unset.
 */
export type ColorValue = string | null;

/** A default for each kind of theme. */
export interface ColorDefaults {
  readonly dark: ColorValue;
  readonly light: ColorValue;
  readonly hcDark: ColorValue;
  readonly hcLight: ColorValue;
}

export interface ColorContribution {
  readonly id: ColorIdentifier;
  readonly description: string;
  readonly defaults: ColorDefaults;
  /** The extension that contributed the color; built-in colors have none. */
  readonly extensionId?: string;
}

/**
 * The id pattern of VS Code's `contributes.colors` (`colorIdPattern`). It keeps an id to word characters
 * and dots, so the CSS variable made from it is one token: nothing in it can end a declaration or a rule.
 */
const COLOR_ID_PATTERN = /^\w+[.\w+]*$/;

/** Whether `value` is a color id as VS Code accepts one, which may go into a CSS variable name. */
export function isColorIdentifier(value: unknown): value is ColorIdentifier {
  return typeof value === 'string' && value.length <= 256 && COLOR_ID_PATTERN.test(value);
}

const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

/** Whether `value` is `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`: the only color notations a theme or an extension may give. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/** A hex color as `#rrggbb` or `#rrggbbaa`, in lower case. `value` must pass `isHexColor`. */
export function normalizeHexColor(value: string): string {
  const digits = value.slice(1).toLowerCase();
  return '#' + (digits.length <= 4 ? [...digits].map(digit => digit + digit).join('') : digits);
}

function schemeKey(scheme: ColorScheme): keyof ColorDefaults {
  switch (scheme) {
    case ColorScheme.LIGHT: return 'light';
    case ColorScheme.HIGH_CONTRAST_DARK: return 'hcDark';
    case ColorScheme.HIGH_CONTRAST_LIGHT: return 'hcLight';
    default: return 'dark';
  }
}

/** References are followed this deep; a longer chain is a cycle and gives no color. */
const MAX_REFERENCE_DEPTH = 16;

/**
 * `color` frozen, with its hex defaults normalized. An id that is not a color identifier, or a default that
 * is neither a hex color nor a color identifier, throws.
 */
function checkedColor({ id, defaults, description, extensionId }: ColorContribution): ColorContribution {
  if (!isColorIdentifier(id)) {
    throw new Error(`'${id}' is not a color identifier.`);
  }
  for (const value of Object.values(defaults)) {
    if (value !== null && !isHexColor(value) && !isColorIdentifier(value)) {
      throw new Error(`The default '${String(value)}' of '${id}' is neither a hex color nor a color identifier.`);
    }
  }
  const normalize = (value: ColorValue) => value !== null && isHexColor(value) ? normalizeHexColor(value) : value;
  return Object.freeze({
    id, description, extensionId,
    defaults: Object.freeze({
      dark: normalize(defaults.dark), light: normalize(defaults.light),
      hcDark: normalize(defaults.hcDark), hcLight: normalize(defaults.hcLight),
    }),
  });
}

class ColorRegistry {
  private readonly colors = new Map<ColorIdentifier, ColorContribution>();
  private readonly changed = new Emitter<void>();
  /** Fires when a color is registered or removed. */
  readonly onDidChangeSchema: Event<void> = this.changed.event;

  /**
   * Registers a color. An id that is not a color identifier, or a default that is neither a hex color nor
   * a color identifier, throws: built-in colors are code.
   */
  registerColor(id: ColorIdentifier, defaults: ColorDefaults, description: string, extensionId?: string): ColorIdentifier {
    this.colors.set(id, checkedColor({ id, defaults, description, extensionId }));
    this.changed.fire();
    return id;
  }

  deregisterColor(id: ColorIdentifier): void {
    if (this.colors.delete(id)) {
      this.changed.fire();
    }
  }

  /**
   * Removes the colors `remove` names, then registers `add`, with one change event at the end. Ids and
   * defaults are checked as `registerColor` checks them, before anything changes.
   */
  changeColors(remove: readonly ColorIdentifier[], add: readonly ColorContribution[]): void {
    const checked = add.map(checkedColor);
    let changed = false;
    for (const id of remove) {
      changed = this.colors.delete(id) || changed;
    }
    for (const color of checked) {
      this.colors.set(color.id, color);
      changed = true;
    }
    if (changed) {
      this.changed.fire();
    }
  }

  getColor(id: ColorIdentifier): ColorContribution | undefined {
    return this.colors.get(id);
  }

  getColors(): readonly ColorContribution[] {
    return [...this.colors.values()];
  }

  /**
   * The value of `id` in a theme of `scheme` whose own colors `themeColor` gives: the theme's color, or
   * else the registered default, following references through the same theme.
   */
  resolve(id: ColorIdentifier, scheme: ColorScheme, themeColor: (id: ColorIdentifier) => string | undefined = () => undefined): string | undefined {
    let current = id;
    for (let depth = 0; depth < MAX_REFERENCE_DEPTH; depth++) {
      const own = themeColor(current);
      if (own !== undefined) {
        return own;
      }
      const value = this.colors.get(current)?.defaults[schemeKey(scheme)];
      if (value === null || value === undefined) {
        return undefined;
      }
      if (isHexColor(value)) {
        return value;
      }
      current = value;
    }
    return undefined;
  }
}

export const colorRegistry = new ColorRegistry();

/** Registers a built-in color with a default for each kind of theme. */
export function registerColor(id: ColorIdentifier, defaults: ColorDefaults, description: string): ColorIdentifier {
  return colorRegistry.registerColor(id, defaults, description);
}

function color(id: string, dark: ColorValue, light: ColorValue, hcDark: ColorValue, hcLight: ColorValue, description: string): void {
  registerColor(id, { dark, light, hcDark, hcLight }, description);
}

// The dark defaults start from the v0.1.0 palette, including stylesheet fallbacks. Both standard
// themes share a structural border tone within their palette. High contrast defaults serve extension
// themes that leave a color out.
const workbenchBorder = { dark: '#4a596e', light: '#a2aec0' };

function workbenchBorderColor(id: string, description: string, highContrast: ColorValue = 'contrastBorder'): void {
  registerColor(id, { ...workbenchBorder, hcDark: highContrast, hcLight: highContrast }, description);
}

// Base colors
color('foreground', '#d1daea', '#2b3443', '#ffffff', '#292929', 'Overall foreground color.');
color('descriptionForeground', '#a7b6cb', '#5a6577', '#ffffff', '#292929', 'Foreground of description text, such as a label\'s secondary text.');
color('disabledForeground', '#a7b6cb', '#8a94a5', '#a5a5a5', '#7f7f7f', 'Foreground of disabled elements.');
color('errorForeground', '#f48a7a', '#c4342d', '#f48771', '#b5200d', 'Foreground of error messages.');
color('icon.foreground', '#b9c4d6', '#4b5a70', '#ffffff', '#292929', 'Default color of icons.');
color('focusBorder', '#9dc3ff', '#2f6fd6', '#f38518', '#006bbd', 'Border of focused elements.');
color('contrastBorder', '#00000000', '#00000000', '#6fc3df', '#0f4a85', 'An extra border around elements, for high contrast.');
color('contrastActiveBorder', null, null, 'focusBorder', 'focusBorder', 'An extra border around active elements, for high contrast.');
color('selection.background', null, null, null, null, 'Background of text selections in the workbench (not the editor).');
color('widget.shadow', '#0000005c', '#00000029', null, null, 'Shadow of widgets such as the find widget.');
color('widget.border', null, null, 'contrastBorder', 'contrastBorder', 'Border of widgets such as the find widget.');
color('sash.hoverBorder', '#78aaff', '#4b8bf0', 'focusBorder', 'focusBorder', 'Border of draggable sashes on hover.');
color('titleBar.iconForeground', '#a9caff', '#2f6fd6', '#ffffff', '#292929', 'Writing Room\'s own: the product icon in the title bar.');

// Text
color('textLink.foreground', '#7fb2ff', '#1f63c9', '#21a6ff', '#0f4a85', 'Foreground of links in text.');
color('textLink.activeForeground', '#a9caff', '#174ea1', '#21a6ff', '#0f4a85', 'Foreground of links in text when clicked or hovered.');
color('textPreformat.foreground', '#e2b88f', '#a3412f', '#ffffff', '#292929', 'Foreground of preformatted text.');
color('textBlockQuote.background', '#1f2633', '#eef2f8', null, '#f2f2f2', 'Background of block quotes in text.');
color('textBlockQuote.border', '#3d5a80', '#9db5d8', '#ffffff', '#292929', 'Border of block quotes in text.');
color('textCodeBlock.background', '#1f2633', '#eef2f8', '#000000', '#f2f2f2', 'Background of code blocks in text.');
color('textSeparator.foreground', '#ffffff2e', '#0000002e', '#000000', '#292929', 'Color of text separators.');

// Buttons and check boxes
color('button.background', '#2f6fd6', '#2f6fd6', null, '#0f4a85', 'Button background.');
color('button.foreground', '#ffffff', '#ffffff', '#ffffff', '#ffffff', 'Button foreground.');
color('button.hoverBackground', '#3d7fe6', '#255bb3', null, '#0f4a85', 'Button background on hover.');
color('button.border', null, null, 'contrastBorder', 'contrastBorder', 'Button border.');
color('button.secondaryBackground', '#344055', '#dfe5ee', null, '#ffffff', 'Secondary button background.');
color('button.secondaryForeground', '#e0e8f6', '#1f2633', '#ffffff', '#292929', 'Secondary button foreground.');
color('button.secondaryHoverBackground', '#3e4b63', '#d2dae6', null, null, 'Secondary button background on hover.');
color('checkbox.background', '#2a3242', '#ffffff', '#000000', '#ffffff', 'Background of check boxes.');
color('checkbox.foreground', '#d7dfec', '#1f2633', '#ffffff', '#292929', 'Foreground of check boxes.');
color('checkbox.border', '#4a5670', '#9aa7ba', '#6fc3df', '#0f4a85', 'Border of check boxes.');
color('checkbox.selectBackground', '#232b39', '#e8edf5', '#000000', '#ffffff', 'Background of check boxes when the element they are in is selected.');
color('checkbox.selectBorder', 'icon.foreground', 'icon.foreground', 'icon.foreground', 'icon.foreground', 'Border of check boxes when the element they are in is selected.');

// Drop-downs and inputs
color('dropdown.background', '#2a3242', '#ffffff', '#000000', '#ffffff', 'Drop-down background.');
color('dropdown.foreground', '#d7dfec', '#1f2633', '#ffffff', '#292929', 'Drop-down foreground.');
color('dropdown.border', '#465672', '#b8c3d3', 'contrastBorder', 'contrastBorder', 'Drop-down border.');
color('dropdown.listBackground', null, null, '#000000', '#ffffff', 'Drop-down list background.');
color('input.background', '#3c3c3c', '#ffffff', '#000000', '#ffffff', 'Input box background.');
color('input.foreground', '#d1daea', '#1f2633', '#ffffff', '#292929', 'Input box foreground.');
color('input.border', '#465672', '#b8c3d3', 'contrastBorder', 'contrastBorder', 'Input box border.');
color('input.placeholderForeground', '#8b97ab', '#7d8797', '#ffffffb3', '#292929b3', 'Input box placeholder text.');
color('inputOption.activeBackground', '#2f6fd666', '#2f6fd633', '#00000000', '#00000000', 'Background of activated options in input fields.');
color('inputOption.activeBorder', '#78aaff', '#2f6fd6', 'contrastBorder', 'contrastBorder', 'Border of activated options in input fields.');
color('inputOption.activeForeground', '#ffffff', '#1f2633', '#ffffff', '#292929', 'Foreground of activated options in input fields.');
color('inputValidation.errorBackground', '#5a1d1d', '#fbe4e2', '#000000', '#ffffff', 'Background of input validation errors.');
color('inputValidation.errorForeground', null, null, null, '#292929', 'Foreground of input validation errors.');
color('inputValidation.errorBorder', '#be1100', '#c4342d', 'contrastBorder', 'contrastBorder', 'Border of input validation errors.');
color('inputValidation.warningBackground', '#4d3a12', '#fbf0d6', '#000000', '#ffffff', 'Background of input validation warnings.');
color('inputValidation.warningBorder', '#b98a1e', '#c28a12', 'contrastBorder', 'contrastBorder', 'Border of input validation warnings.');
color('inputValidation.infoBackground', '#123a5c', '#dcebfb', '#000000', '#ffffff', 'Background of input validation information.');
color('inputValidation.infoBorder', '#3d7fe6', '#2f6fd6', 'contrastBorder', 'contrastBorder', 'Border of input validation information.');

// Badges, scroll bars, progress
color('badge.background', '#3a4a63', '#c4d3ea', '#000000', '#0f4a85', 'Background of badges, such as a count on a view.');
color('badge.foreground', '#eaf0f9', '#1f2633', '#ffffff', '#ffffff', 'Foreground of badges.');
color('scrollbar.shadow', '#00000066', '#00000026', null, null, 'Shadow that shows a view is scrolled.');
color('scrollbarSlider.background', '#7a87a033', '#64708533', null, '#0f4a8566', 'Scroll bar slider background.');
color('scrollbarSlider.hoverBackground', '#7a87a055', '#64708555', null, '#0f4a8599', 'Scroll bar slider background on hover.');
color('scrollbarSlider.activeBackground', '#7a87a077', '#64708577', 'focusBorder', 'focusBorder', 'Scroll bar slider background when clicked.');
color('progressBar.background', '#78aaff', '#2f6fd6', 'contrastBorder', 'contrastBorder', 'Progress bar background.');

// Lists and trees
color('list.activeSelectionBackground', '#04395e', '#cfe0fa', null, '#0f4a85', 'Background of the selected item when the list is focused.');
color('list.activeSelectionForeground', '#ffffff', '#1f2633', null, '#ffffff', 'Foreground of the selected item when the list is focused.');
color('list.activeSelectionIconForeground', 'icon.foreground', 'icon.foreground', 'icon.foreground', 'list.activeSelectionForeground', 'Icon foreground of the selected item when the list is focused.');
color('list.inactiveSelectionBackground', '#37373d', '#e4e9f1', null, '#e4e9f1', 'Background of the selected item when the list is not focused.');
color('list.inactiveSelectionForeground', 'foreground', 'foreground', 'foreground', 'foreground', 'Foreground of the selected item when the list is not focused.');
color('list.hoverBackground', '#ffffff12', '#e8eef7', null, '#0f4a851a', 'Background of list items under the mouse.');
color('list.hoverForeground', 'foreground', 'foreground', 'foreground', 'foreground', 'Foreground of list items under the mouse.');
color('list.focusBackground', '#2a3446', '#e1e8f3', null, null, 'Background of the focused item when the list is focused.');
color('list.focusForeground', null, null, null, null, 'Foreground of the focused item when the list is focused.');
color('list.focusOutline', 'focusBorder', 'focusBorder', 'contrastActiveBorder', 'contrastActiveBorder', 'Outline of the focused item when the list is focused.');
color('list.inactiveFocusOutline', null, null, null, null, 'Outline of the focused item when the list is not focused.');
color('list.dropBackground', '#383b3d', '#d6e4f7', null, '#0f4a8533', 'Background of a list item while something is dragged over it.');
color('list.highlightForeground', '#7fb2ff', '#1f63c9', 'focusBorder', 'focusBorder', 'Foreground of the matched characters when filtering a list.');
color('list.focusHighlightForeground', 'list.highlightForeground', 'list.highlightForeground', 'list.highlightForeground', 'list.highlightForeground', 'Foreground of the matched characters in the focused item.');
color('list.errorForeground', '#f48a7a', '#c4342d', null, '#b5200d', 'Foreground of list items with errors.');
color('list.warningForeground', '#d9b24f', '#946a0a', null, '#895503', 'Foreground of list items with warnings.');
color('list.invalidItemForeground', '#e06c62', '#c4342d', '#b89500', '#b5200d', 'Foreground of invalid items, such as an unresolved root.');
color('list.deemphasizedForeground', '#8b97ab', '#7d8797', '#a7a8a9', '#666666', 'Foreground of de-emphasized items.');
color('tree.indentGuidesStroke', '#3f4a5e', '#c3cbd8', '#a9a9a9', '#a5a5a5', 'Stroke of tree indent guides.');
color('tree.inactiveIndentGuidesStroke', '#3f4a5e66', '#c3cbd866', '#a9a9a966', '#a5a5a566', 'Stroke of tree indent guides that are not active.');

// Activity bar
color('activityBar.background', '#1a202c', '#eef2f8', '#000000', '#ffffff', 'Activity bar background.');
color('activityBar.foreground', '#a5b3c8', '#4b5a70', '#ffffff', '#292929', 'Activity bar foreground.');
color('activityBar.inactiveForeground', '#a5b3c8', '#4b5a70', '#ffffff', '#292929', 'Foreground of inactive activity bar items.');
workbenchBorderColor('activityBar.border', 'Border between the activity bar and the side bar.');
color('activityBar.activeBorder', '#90baff', '#2f6fd6', null, 'contrastBorder', 'Border of the active activity bar item.');
color('activityBar.activeBackground', null, null, null, null, 'Background of the active activity bar item.');
color('activityBarBadge.background', '#2f6fd6', '#2f6fd6', '#000000', '#0f4a85', 'Background of activity bar badges.');
color('activityBarBadge.foreground', '#ffffff', '#ffffff', '#ffffff', '#ffffff', 'Foreground of activity bar badges.');

// Side bar
color('sideBar.background', '#202735', '#f4f6fa', '#000000', '#ffffff', 'Side bar background.');
color('sideBar.foreground', '#d1daea', '#2b3443', '#ffffff', '#292929', 'Side bar foreground.');
color('sideBar.border', 'panel.border', 'panel.border', 'contrastBorder', 'contrastBorder', 'Border between the side bar and the editor.');
color('sideBarTitle.foreground', 'sideBar.foreground', 'sideBar.foreground', 'sideBar.foreground', 'sideBar.foreground', 'Side bar title foreground.');
color('sideBarSectionHeader.background', '#262f40', '#e7ecf4', null, null, 'Side bar section header background.');
color('sideBarSectionHeader.foreground', 'sideBar.foreground', 'sideBar.foreground', 'sideBar.foreground', 'sideBar.foreground', 'Side bar section header foreground.');
color('sideBarSectionHeader.border', null, null, 'contrastBorder', 'contrastBorder', 'Side bar section header border.');

// Editor groups and tabs
workbenchBorderColor('editorGroup.border', 'Border between editor groups.');
color('editorGroup.dropBackground', '#53595d80', '#9db5d866', null, '#0f4a8533', 'Background of an editor group while an editor is dragged over it.');
color('editorGroupHeader.tabsBackground', '#1c212c', '#e9edf4', null, '#e9edf4', 'Background of the tabs bar.');
workbenchBorderColor('editorGroupHeader.tabsBorder', 'Border below the tabs bar.', null);
color('editorGroupHeader.noTabsBackground', 'editor.background', 'editor.background', 'editor.background', 'editor.background', 'Background of the title of a group without tabs.');
color('tab.activeBackground', 'editor.background', 'editor.background', 'editor.background', 'editor.background', 'Background of the active tab.');
color('tab.activeForeground', '#eaf0f9', '#1f2633', '#ffffff', '#292929', 'Foreground of the active tab.');
color('tab.activeBorder', null, null, null, null, 'Border below the active tab.');
color('tab.activeBorderTop', '#90baff', '#2f6fd6', null, 'contrastBorder', 'Border above the active tab.');
color('tab.inactiveBackground', '#1c212c', '#e9edf4', null, '#e9edf4', 'Background of inactive tabs.');
color('tab.inactiveForeground', '#8b97ab', '#5a6577', '#ffffff', '#292929', 'Foreground of inactive tabs.');
workbenchBorderColor('tab.border', 'Border between tabs.');
color('tab.hoverBackground', null, null, null, null, 'Background of tabs under the mouse.');
color('tab.hoverForeground', null, null, null, null, 'Foreground of tabs under the mouse.');
color('tab.unfocusedActiveForeground', 'tab.activeForeground', 'tab.activeForeground', 'tab.activeForeground', 'tab.activeForeground', 'Foreground of the active tab of an unfocused group.');
color('tab.unfocusedInactiveForeground', 'tab.inactiveForeground', 'tab.inactiveForeground', 'tab.inactiveForeground', 'tab.inactiveForeground', 'Foreground of inactive tabs of an unfocused group.');
color('tab.dragAndDropBorder', '#eaf0f9', '#1f2633', 'contrastActiveBorder', 'contrastActiveBorder', 'Border that shows where a dragged tab goes.');

// Panel
color('panel.background', '#181d27', '#f8f9fc', '#000000', '#ffffff', 'Panel background.');
workbenchBorderColor('panel.border', 'Border between the panel and the editor.');
color('panel.dropBorder', 'panelTitle.activeForeground', 'panelTitle.activeForeground', 'panelTitle.activeForeground', 'panelTitle.activeForeground', 'Border that shows where a dragged panel title goes.');
color('panelTitle.activeBorder', '#90baff', '#2f6fd6', 'contrastBorder', 'contrastBorder', 'Border of the active panel title.');
color('panelTitle.activeForeground', '#eaf0f9', '#1f2633', '#ffffff', '#292929', 'Foreground of the active panel title.');
color('panelTitle.inactiveForeground', '#a5b3c8', '#5a6577', '#ffffff', '#292929', 'Foreground of inactive panel titles.');
color('panelSectionHeader.background', '#262f40', '#e7ecf4', null, null, 'Panel section header background.');
color('panelSectionHeader.foreground', 'foreground', 'foreground', 'foreground', 'foreground', 'Panel section header foreground.');

// Status bar
color('statusBar.background', '#20334e', '#dde8f8', '#000000', '#ffffff', 'Status bar background.');
color('statusBar.foreground', '#d8e8ff', '#1d3354', '#ffffff', '#292929', 'Status bar foreground.');
workbenchBorderColor('statusBar.border', 'Border between the status bar and the editor.');
color('statusBar.noFolderBackground', 'statusBar.background', 'statusBar.background', 'statusBar.background', 'statusBar.background', 'Status bar background without a folder.');
color('statusBarItem.hoverBackground', '#ffffff1f', '#0000001a', null, null, 'Status bar item background on hover.');
color('statusBarItem.activeBackground', '#ffffff2e', '#0000002e', null, null, 'Status bar item background when clicked.');
color('statusBarItem.errorBackground', '#a1260d', '#c4342d', '#b5200d', '#b5200d', 'Background of status bar error items.');
color('statusBarItem.errorForeground', '#ffffff', '#ffffff', '#ffffff', '#ffffff', 'Foreground of status bar error items.');
color('statusBarItem.warningBackground', '#7a5c00', '#b07a00', '#895503', '#895503', 'Background of status bar warning items.');
color('statusBarItem.warningForeground', '#ffffff', '#ffffff', '#ffffff', '#ffffff', 'Foreground of status bar warning items.');
color('statusBarItem.prominentBackground', '#00000080', '#00000033', '#000000', '#ffffff', 'Background of prominent status bar items.');
color('statusBarItem.prominentForeground', 'statusBar.foreground', 'statusBar.foreground', 'statusBar.foreground', 'statusBar.foreground', 'Foreground of prominent status bar items.');
color('statusBarItem.remoteBackground', '#2f6fd6', '#2f6fd6', '#000000', '#0f4a85', 'Background of the remote indicator.');
color('statusBarItem.remoteForeground', '#ffffff', '#ffffff', '#ffffff', '#ffffff', 'Foreground of the remote indicator.');

// Title bar and menus
color('titleBar.activeBackground', '#232b39', '#e8edf5', '#000000', '#ffffff', 'Title bar background.');
color('titleBar.activeForeground', '#eaf0f9', '#1f2633', '#ffffff', '#292929', 'Title bar foreground.');
color('titleBar.inactiveBackground', 'titleBar.activeBackground', 'titleBar.activeBackground', 'titleBar.activeBackground', 'titleBar.activeBackground', 'Title bar background when the window is inactive.');
color('titleBar.inactiveForeground', '#a5b3c8', '#5a6577', '#ffffff', '#292929', 'Title bar foreground when the window is inactive.');
workbenchBorderColor('titleBar.border', 'Title bar border.');
color('menubar.selectionBackground', 'menu.selectionBackground', 'menu.selectionBackground', null, null, 'Background of the selected menu bar item.');
color('menubar.selectionForeground', 'titleBar.activeForeground', 'titleBar.activeForeground', 'titleBar.activeForeground', 'titleBar.activeForeground', 'Foreground of the selected menu bar item.');
color('menu.background', '#232c3d', '#ffffff', '#000000', '#ffffff', 'Menu background.');
color('menu.foreground', '#e0e8f6', '#1f2633', '#ffffff', '#292929', 'Menu foreground.');
color('menu.selectionBackground', '#364663', '#dbe6f7', null, null, 'Background of the selected menu item.');
color('menu.selectionForeground', 'menu.foreground', 'menu.foreground', 'menu.foreground', 'menu.foreground', 'Foreground of the selected menu item.');
color('menu.separatorBackground', 'menu.border', 'menu.border', 'contrastBorder', 'contrastBorder', 'Menu separator.');
color('menu.border', '#465672', '#c6cfdd', 'contrastBorder', 'contrastBorder', 'Menu border.');

// Notifications and quick input
color('notifications.background', '#232c3d', '#ffffff', '#000000', '#ffffff', 'Notification background.');
color('notifications.foreground', '#e0e8f6', '#1f2633', '#ffffff', '#292929', 'Notification foreground.');
color('notifications.border', '#465672', '#c6cfdd', 'contrastBorder', 'contrastBorder', 'Border between notifications.');
color('notificationToast.border', null, null, 'contrastBorder', 'contrastBorder', 'Notification toast border.');
color('notificationCenterHeader.background', '#2a3446', '#eef2f8', null, null, 'Notification center header background.');
color('notificationLink.foreground', 'textLink.foreground', 'textLink.foreground', 'textLink.foreground', 'textLink.foreground', 'Foreground of links in notifications.');
color('notificationsErrorIcon.foreground', '#f48a7a', '#c4342d', '#f48771', '#b5200d', 'Color of the error icon in notifications.');
color('notificationsWarningIcon.foreground', '#d9b24f', '#b07a00', '#cca700', '#895503', 'Color of the warning icon in notifications.');
color('notificationsInfoIcon.foreground', '#78aaff', '#2f6fd6', '#3794ff', '#1a85ff', 'Color of the information icon in notifications.');
color('quickInput.background', '#232c3d', '#ffffff', '#000000', '#ffffff', 'Quick input background.');
color('quickInput.foreground', '#e0e8f6', '#1f2633', '#ffffff', '#292929', 'Quick input foreground.');
color('quickInputTitle.background', '#ffffff1a', '#0000000f', '#000000', '#ffffff', 'Quick input title background.');
color('quickInputList.focusBackground', '#364663', '#dbe6f7', null, null, 'Background of the focused quick input item.');
color('quickInputList.focusForeground', 'quickInput.foreground', 'quickInput.foreground', 'quickInput.foreground', 'quickInput.foreground', 'Foreground of the focused quick input item.');
color('pickerGroup.foreground', '#7fb2ff', '#1f63c9', '#ffffff', '#0f4a85', 'Foreground of quick pick group labels.');
color('pickerGroup.border', '#465672', '#c6cfdd', '#ffffff', '#0f4a85', 'Border of quick pick group labels.');
color('keybindingLabel.background', '#8080802b', '#dddddd66', '#00000000', '#00000000', 'Keybinding label background.');
color('keybindingLabel.foreground', '#d7dfec', '#3c4656', '#ffffff', '#292929', 'Keybinding label foreground.');
color('keybindingLabel.border', '#3340574d', '#ccd3df66', '#6fc3df', '#0f4a85', 'Keybinding label border.');

// Charts, which extensions use for icon colors
color('charts.foreground', 'foreground', 'foreground', 'foreground', 'foreground', 'Foreground of text in charts.');
color('charts.lines', '#d1daea80', '#2b344380', '#ffffff80', '#29292980', 'Lines in charts.');
color('charts.red', '#ef6b62', '#cf3a32', '#f48771', '#b5200d', 'Red in charts and icons.');
color('charts.blue', '#5d9cf5', '#2f6fd6', '#3794ff', '#0f4a85', 'Blue in charts and icons.');
color('charts.yellow', '#d9b24f', '#a67b05', '#cca700', '#895503', 'Yellow in charts and icons.');
color('charts.orange', '#e08a3c', '#c26414', '#d18616', '#a35d0a', 'Orange in charts and icons.');
color('charts.green', '#7ec27a', '#3b8a3a', '#89d185', '#2b7a2b', 'Green in charts and icons.');
color('charts.purple', '#b38ae0', '#7442a8', '#b180d7', '#652d90', 'Purple in charts and icons.');

// Editor
color('editor.background', '#171b24', '#fbfcfe', '#000000', '#ffffff', 'Editor background.');
color('markdownEditor.contentBorder', '#313c50', '#d3dae6', 'contrastBorder', 'contrastBorder', 'Side borders of the centered Markdown editor content.');
color('editor.foreground', '#d7dfec', '#1f2633', '#ffffff', '#292929', 'Editor foreground.');
color('editor.selectionBackground', '#2f4a72', '#c4d8f6', '#ffffff', '#0f4a85', 'Background of the editor selection.');
color('editor.inactiveSelectionBackground', '#2f4a7280', '#c4d8f680', '#ffffff80', '#0f4a8580', 'Background of the selection in an unfocused editor.');
color('editor.selectionHighlightBackground', '#3e5a8255', '#a9c4ec66', null, null, 'Background of text that matches the selection.');
color('editor.findMatchBackground', '#7a5c1e', '#f2c86b', null, null, 'Background of the current search match.');
color('editor.findMatchHighlightBackground', '#7a5c1e80', '#f2c86b80', null, null, 'Background of the other search matches.');
color('editor.lineHighlightBackground', '#1f2533', '#eef2f8', null, null, 'Background of the line with the cursor.');
color('editor.lineHighlightBorder', '#262d3c', '#e3e8f0', '#f38518', '#0f4a85', 'Border around the line with the cursor.');
color('editorCursor.foreground', '#d7dfec', '#1f2633', '#ffffff', '#0f4a85', 'Editor cursor.');
color('editorLineNumber.foreground', '#5c6880', '#8a94a5', '#ffffff', '#292929', 'Editor line numbers.');
color('editorLineNumber.activeForeground', '#c3cee0', '#2b3443', 'focusBorder', 'focusBorder', 'Editor line number of the line with the cursor.');
color('editorWhitespace.foreground', '#3f4a5e', '#c3cbd8', '#7c7c7c', '#cccccc', 'Rendered whitespace in the editor.');
color('editorIndentGuide.background1', '#2c3445', '#dde3ec', '#ffffff', '#292929', 'Editor indentation guides.');
color('editorIndentGuide.activeBackground1', '#4a5670', '#b8c3d3', '#ffffff', '#292929', 'Active editor indentation guide.');
color('editorRuler.foreground', '#2c3445', '#dde3ec', '#ffffff', '#292929', 'Editor rulers.');
color('editorGutter.background', 'editor.background', 'editor.background', 'editor.background', 'editor.background', 'Editor gutter background.');
color('editorBracketMatch.background', '#3e5a8240', '#a9c4ec66', '#0064001a', '#0000000a', 'Background behind matching brackets.');
color('editorBracketMatch.border', '#5c6880', '#9aa7ba', 'contrastBorder', 'contrastBorder', 'Border around matching brackets.');
color('editorOverviewRuler.border', '#7f7f7f4d', '#7f7f7f4d', '#7f7f7f4d', '#666666', 'Overview ruler border.');
color('editorError.foreground', '#f14c4c', '#d0362e', null, '#b5200d', 'Squiggles of errors in the editor.');
color('editorWarning.foreground', '#d9b24f', '#b07a00', null, '#895503', 'Squiggles of warnings in the editor.');
color('editorInfo.foreground', '#5d9cf5', '#2f6fd6', null, '#0f4a85', 'Squiggles of information in the editor.');
color('editorLink.activeForeground', '#7fb2ff', '#1f63c9', '#00ffff', '#0f4a85', 'Active links in the editor.');
color('editorWidget.background', '#232c3d', '#ffffff', '#0c141f', '#ffffff', 'Background of editor widgets such as find and replace.');
color('editorWidget.foreground', 'foreground', 'foreground', 'foreground', 'foreground', 'Foreground of editor widgets.');
color('editorWidget.border', '#465672', '#c6cfdd', 'contrastBorder', 'contrastBorder', 'Border of editor widgets.');
color('editorHoverWidget.background', 'editorWidget.background', 'editorWidget.background', 'editorWidget.background', 'editorWidget.background', 'Background of the editor hover.');
color('editorHoverWidget.border', 'editorWidget.border', 'editorWidget.border', 'editorWidget.border', 'editorWidget.border', 'Border of the editor hover.');
color('editorSuggestWidget.background', 'editorWidget.background', 'editorWidget.background', 'editorWidget.background', 'editorWidget.background', 'Background of the suggestion widget.');
color('editorSuggestWidget.border', 'editorWidget.border', 'editorWidget.border', 'editorWidget.border', 'editorWidget.border', 'Border of the suggestion widget.');
color('editorSuggestWidget.foreground', 'editor.foreground', 'editor.foreground', 'editor.foreground', 'editor.foreground', 'Foreground of the suggestion widget.');
color('editorSuggestWidget.selectedBackground', 'list.activeSelectionBackground', 'list.activeSelectionBackground', null, null, 'Background of the selected suggestion.');
