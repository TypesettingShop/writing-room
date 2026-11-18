import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';

export const IExtensionService = createDecorator<IExtensionService>('extensionService');

export interface IExtensionService extends BrandedService {
  initialize?(): void;
  restartExtensionHost?(): Promise<void>;
  dispose?: IDisposable['dispose'];
  activateByEvent(event: string): Promise<void>;
  activationEventIsDone(event: string): boolean;
  whenInstalledExtensionsRegistered(): Promise<boolean>;
}

export class NullExtensionService implements IExtensionService {
  declare readonly _serviceBrand: undefined;

  async activateByEvent(): Promise<void> {}
  activationEventIsDone(): boolean { return true; }
  async whenInstalledExtensionsRegistered(): Promise<boolean> { return true; }
}

registerSingleton(IExtensionService, NullExtensionService);
