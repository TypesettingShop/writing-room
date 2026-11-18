import { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';

export type ConfigurationValue = boolean | number | string;

export interface IConfigurationChangeEvent {
  affectsConfiguration(key: string): boolean;
}

export const IConfigurationService = createDecorator<IConfigurationService>('configurationService');

export interface IConfigurationService extends BrandedService, IDisposable {
  readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent>;
  readonly onDidChangeUserSettings: Event<string>;
  getValue<T = unknown>(key?: string): T | undefined;
  updateValue(key: string, value: ConfigurationValue): Promise<void>;
  getUserSettingsText(): string;
  saveUserSettings(text: string): void;
}

export const defaultUserSettingsText = '{\n}\n';

export class NullConfigurationService implements IConfigurationService {
  declare readonly _serviceBrand: undefined;
  readonly onDidChangeConfiguration = Event.None;
  readonly onDidChangeUserSettings = Event.None;
  getValue(): undefined { return undefined; }
  getUserSettingsText(): string { return defaultUserSettingsText; }
  async updateValue(): Promise<void> { throw new Error('Configuration is unavailable.'); }
  saveUserSettings(): void { throw new Error('Configuration is unavailable.'); }
  dispose(): void {}
}

registerSingleton(IConfigurationService, NullConfigurationService);
