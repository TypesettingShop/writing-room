import { asCssVariableName, isColorIdentifier } from '../../../../platform/theme/common/colorRegistry.js';

/**
 * The CSS value for a `ThemeIcon`'s color, or `undefined` for an id that is not a color id. Only an id
 * that passes the color id pattern becomes a `var(--vscode-…)` reference, so the extension's string
 * cannot end the declaration or add another one.
 */
export function treeIconColor(id: string): string | undefined {
  return isColorIdentifier(id) ? `var(${asCssVariableName(id)})` : undefined;
}
