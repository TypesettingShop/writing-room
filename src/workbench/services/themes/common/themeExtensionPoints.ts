import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { resolveExtensionResource } from '../../extensions/common/extensionResources.js';
import { ExtensionsRegistry } from '../../extensions/common/extensionsRegistry.js';
import { ContributionSlot } from '../../language/common/languageService.js';
import { isUiTheme } from './colorThemeData.js';
import type { UiTheme } from './colorThemeData.js';

/** A `contributes.themes` entry whose file is inside its extension. */
export interface IThemeContribution {
  readonly extensionId: string;
  /** The extension's display name, which the theme picker shows beside the label. */
  readonly extensionName: string;
  readonly extensionLocation: URI;
  /** The extension's version: a new version at the same location reads the file again. */
  readonly extensionVersion: string;
  /** The value of `workbench.colorTheme` that chooses the theme: the entry's `id`, or else its `label`. */
  readonly settingsId: string;
  readonly label: string;
  readonly uiTheme: UiTheme;
  /** The manifest's path, relative to the extension; includes in the file are relative to it. */
  readonly path: string;
}

export const themeContributions = new ContributionSlot<IThemeContribution>();

/** Theme setting ids that built-in themes have; an extension cannot take one. */
const reservedSettingsIds = new Set<string>();

export function reserveThemeSettingsId(settingsId: string): void {
  reservedSettingsIds.add(settingsId);
}

/** Equal for equal contributions, so a contribution applied again unchanged is seen to be the same. */
export function themeContributionKey(theme: IThemeContribution): string {
  return JSON.stringify([
    theme.extensionId, theme.extensionVersion, theme.extensionLocation.toString(), theme.settingsId, theme.label, theme.uiTheme, theme.path,
  ]);
}

ExtensionsRegistry.registerExtensionPoint<unknown[]>({
  name: 'themes',
  validate: (value): value is unknown[] => Array.isArray(value),
  accept(users, registrations) {
    const contributions: IThemeContribution[] = [];
    const seen = new Set<string>();
    for (const { description, value, collector } of users) {
      const extensionId = description.identifier.value;
      const { displayName, name } = description.manifest;
      const extensionName = typeof displayName === 'string' && displayName ? displayName : name;
      const extensionLocation = URI.parse(description.location);
      const extensionVersion = String(description.manifest.version);
      value.forEach((entry, index) => {
        const path = `contributes.themes[${index}]`;
        if (!isRecord(entry)) {
          collector.error(path, 'Expected a theme object with `label`, `uiTheme` and `path`.');
          return;
        }
        if (typeof entry.label !== 'string' || !entry.label) {
          collector.error(path + '.label', 'Property `label` is mandatory and must be of type `string`.');
          return;
        }
        if (!isUiTheme(entry.uiTheme)) {
          collector.error(path + '.uiTheme', 'Property `uiTheme` is mandatory and must be one of `vs`, `vs-dark`, `hc-black`, `hc-light`.');
          return;
        }
        if (entry.id !== undefined && (typeof entry.id !== 'string' || !entry.id)) {
          collector.error(path + '.id', 'Property `id` can be omitted and must be of type `string`.');
          return;
        }
        if (typeof entry.path !== 'string' || !entry.path) {
          collector.error(path + '.path', 'Property `path` is mandatory and must be of type `string`.');
          return;
        }
        if (/\.tmTheme$/i.test(entry.path)) {
          collector.warn(path + '.path', 'TextMate theme files (.tmTheme) are not supported. The theme is ignored.');
          return;
        }
        if (!resolveExtensionResource(extensionLocation, entry.path)) {
          collector.warn(path + '.path', `'${entry.path}' is not a relative path inside the extension. The theme is ignored.`);
          return;
        }
        const settingsId = typeof entry.id === 'string' ? entry.id : entry.label;
        if (reservedSettingsIds.has(settingsId) || seen.has(settingsId)) {
          collector.warn(path + '.id', `A theme with the id '${settingsId}' already exists. The theme is ignored.`);
          return;
        }
        seen.add(settingsId);
        contributions.push(Object.freeze({
          extensionId, extensionName, extensionLocation, extensionVersion, settingsId, label: entry.label, uiTheme: entry.uiTheme, path: entry.path,
        }));
      });
    }
    registrations.add(themeContributions.replace(contributions));
  },
});
