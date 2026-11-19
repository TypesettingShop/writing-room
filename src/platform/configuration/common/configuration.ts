import { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';
import { Configuration } from './configurationModels.js';
import type { IConfigurationChangeEvent, IConfigurationOverrides, IConfigurationValue } from './configurationModels.js';
import { configurationRegistry } from './configurationRegistry.js';

export type { IConfigurationChangeEvent, IConfigurationOverrides, IConfigurationValue } from './configurationModels.js';

/** A setting's value: JSON data. */
export type ConfigurationValue = unknown;

export const IConfigurationService = createDecorator<IConfigurationService>('configurationService');

export interface IConfigurationService extends BrandedService, IDisposable {
  readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent>;
  readonly onDidChangeUserSettings: Event<string>;
  /** The value of a key or section, for a language when `overrides` names one. The caller gets a copy. */
  getValue<T = unknown>(key?: string, overrides?: IConfigurationOverrides): T | undefined;
  inspect<T = unknown>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T>;
  /** Every registered key's layers, as of now. */
  getConfiguration(): Configuration;
  /**
   * Writes `value` for `key` into settings.json, inside `[<language>]` when `overrides` names one; `undefined`
   * removes the key. Only that key's text changes.
   */
  updateValue(key: string, value: ConfigurationValue, overrides?: IConfigurationOverrides): Promise<void>;
  getUserSettingsText(): string;
  saveUserSettings(text: string): void;
}

export const defaultUserSettingsText = '{\n}\n';

/** Without settings.json: every key has its registered default. */
export class NullConfigurationService implements IConfigurationService {
  declare readonly _serviceBrand: undefined;
  readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent> = Event.None;
  readonly onDidChangeUserSettings: Event<string> = Event.None;
  private snapshot: {
    readonly properties: unknown; readonly languageDefaults: unknown; readonly configuration: Configuration;
  } | undefined;

  getConfiguration(): Configuration {
    // The registry replaces both maps on every update, so they tell whether the last snapshot is current.
    const properties = configurationRegistry.getConfigurationProperties();
    const languageDefaults = configurationRegistry.getLanguageDefaults();
    if (this.snapshot?.properties !== properties || this.snapshot.languageDefaults !== languageDefaults) {
      this.snapshot = { properties, languageDefaults, configuration: Configuration.build(properties, languageDefaults, {}) };
    }
    return this.snapshot.configuration;
  }

  getValue<T = unknown>(key?: string, overrides?: IConfigurationOverrides): T | undefined {
    return this.getConfiguration().getValue<T>(key, overrides);
  }

  inspect<T = unknown>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> {
    return this.getConfiguration().inspect<T>(key, overrides);
  }

  getUserSettingsText(): string { return defaultUserSettingsText; }
  async updateValue(_key: string, _value: ConfigurationValue, _overrides?: IConfigurationOverrides): Promise<void> {
    throw new Error('Configuration is unavailable.');
  }

  saveUserSettings(_text: string): void { throw new Error('Configuration is unavailable.'); }
  dispose(): void {}
}

registerSingleton(IConfigurationService, NullConfigurationService);
