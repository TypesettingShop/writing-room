import type { IConfigurationData, IConfigurationKeyData } from '../../../platform/configuration/common/configurationModels.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

/** `vscode.ConfigurationTarget`, or `null` when the extension named none. */
export type ConfigurationTargetDto = 1 | 2 | 3 | null;

export interface ConfigurationOverridesDto {
  readonly overrideIdentifier?: string;
}

/** Changed keys with their new layers; `null` for a key that is no longer registered. */
export type ConfigurationChangeDto = readonly (readonly [string, IConfigurationKeyData | null])[];

export interface MainThreadConfigurationShape {
  /** Every registered key, as of the moment the request is handled. */
  $getConfigurationData(): Promise<IConfigurationData>;
  $updateConfigurationOption(
    extension: string, target: ConfigurationTargetDto, key: string, value: unknown,
    overrides: ConfigurationOverridesDto | undefined, scopeToLanguage: boolean | undefined,
  ): Promise<void>;
  $removeConfigurationOption(
    extension: string, target: ConfigurationTargetDto, key: string,
    overrides: ConfigurationOverridesDto | undefined, scopeToLanguage: boolean | undefined,
  ): Promise<void>;
}

export interface ExtHostConfigurationShape {
  $acceptConfigurationChanged(changes: ConfigurationChangeDto): Promise<void>;
}

export const MainThreadConfigurationProxy = createProxyIdentifier<MainThreadConfigurationShape>('MainThreadConfiguration');
export const ExtHostConfigurationProxy = createProxyIdentifier<ExtHostConfigurationShape>('ExtHostConfiguration');
