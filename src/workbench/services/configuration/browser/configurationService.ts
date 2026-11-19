import { Emitter } from '../../../../base/common/event.js';
import { parseJSONC, setJSONCProperty } from '../../../../base/common/jsonc.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { defaultUserSettingsText, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type {
  ConfigurationValue, IConfigurationChangeEvent, IConfigurationOverrides, IConfigurationValue,
} from '../../../../platform/configuration/common/configuration.js';
import { Configuration, configurationChange } from '../../../../platform/configuration/common/configurationModels.js';
import {
  configurationRegistry, keyFromOverrideIdentifiers, validateConfigurationValue,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import type { ConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { isJSONValue } from '../../../../platform/configuration/common/configurationValues.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const userSettingsKey = 'user.settings.json';
const scope = StorageScope.PROFILE;

export class ConfigurationService extends Disposable implements IConfigurationService {
  declare readonly _serviceBrand: undefined;
  private readonly changed = this._register(new Emitter<IConfigurationChangeEvent>());
  readonly onDidChangeConfiguration = this.changed.event;
  private readonly textChanged = this._register(new Emitter<string>());
  readonly onDidChangeUserSettings = this.textChanged.event;
  private text: string;
  private readonly pendingText: string[] = [];
  // Keep unknown keys from the last valid document for configuration registered later.
  private user: Readonly<Record<string, unknown>> = {};
  private configuration: Configuration;

  constructor(
    private readonly registry: ConfigurationRegistry,
    @IStorageService private readonly storage: IStorageService,
  ) {
    super();
    this.text = storage.get(userSettingsKey, scope, defaultUserSettingsText);
    this.readUser();
    this.configuration = this.build();
    const listeners = this._register(new DisposableStore());
    storage.onDidChangeValue(scope, userSettingsKey, listeners)(() => this.acceptText(
      storage.get(userSettingsKey, scope, defaultUserSettingsText),
    ));
    this._register(registry.onDidUpdateConfiguration(() => this.refresh()));
  }

  getValue<T = unknown>(key?: string, overrides?: IConfigurationOverrides): T | undefined {
    return this.configuration.getValue<T>(key, overrides);
  }

  inspect<T = unknown>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> {
    return this.configuration.inspect<T>(key, overrides);
  }

  getConfiguration(): Configuration {
    return this.configuration;
  }

  getUserSettingsText(): string {
    return this.text;
  }

  saveUserSettings(text: string): void {
    this.storage.storeImmediately(userSettingsKey, text, scope, StorageTarget.USER);
  }

  /**
   * Reads the stored text and changes only this key in it, so another writer's keys, comments and
   * unknown keys stay. The change event has fired by the time this returns.
   */
  async updateValue(key: string, value: ConfigurationValue, overrides?: IConfigurationOverrides): Promise<void> {
    const schema = this.registry.getConfigurationProperties().get(key);
    if (!schema) {
      throw new Error(`Unable to write to User Settings because ${key} is not a registered configuration.`);
    }
    if (value !== undefined && (!isJSONValue(value) || !validateConfigurationValue(schema, value))) {
      throw new Error(`Unsupported value for configuration '${key}'.`);
    }
    const language = overrides?.overrideIdentifier;
    const path = language ? [keyFromOverrideIdentifiers([language]), key] : [key];
    this.storage.storeImmediately(userSettingsKey, stored => {
      try {
        return setJSONCProperty(stored ?? defaultUserSettingsText, path, value);
      } catch (cause) {
        throw new Error('Fix the syntax of settings.json before updating a setting.', { cause });
      }
    }, scope, StorageTarget.USER);
  }

  private acceptText(text: string): void {
    this.pendingText.push(text);
    if (this.pendingText.length > 1) {
      return;
    }
    try {
      // A listener may save again synchronously. Publish both events for this text before advancing.
      for (const next of this.pendingText) {
        if (this.text !== next) {
          this.text = next;
          this.readUser();
          this.refresh();
          this.textChanged.fire(next);
        }
      }
    } finally {
      this.pendingText.length = 0;
    }
  }

  private readUser(): void {
    const value = parseJSONC(this.text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      this.user = value as Record<string, unknown>;
    }
  }

  private build(): Configuration {
    return Configuration.build(this.registry.getConfigurationProperties(), this.registry.getLanguageDefaults(), this.user);
  }

  private refresh(): void {
    const next = this.build();
    const change = configurationChange(this.configuration, next);
    this.configuration = next;
    if (change) {
      this.changed.fire(change);
    }
  }
}

registerSingleton(IConfigurationService, new SyncDescriptor(ConfigurationService, [configurationRegistry]));
