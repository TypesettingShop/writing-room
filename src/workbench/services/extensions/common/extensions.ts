import type { Event } from '../../../../base/common/event.js';
import type { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';

export const IExtensionService = createDecorator<IExtensionService>('extensionService');

export interface IExtensionService extends BrandedService {
  readonly extensions?: readonly IExtensionDescription[];
  readonly onDidChangeExtensions?: Event<void>;
  initialize?(): void;
  addExtension?(extension: IExtensionDescription): boolean;
  removeExtension?(identifier: string): boolean;
  clearExtensionStorage?(identifier: string): Promise<void>;
  whenExtensionRemoved?(identifier: string): Promise<void>;
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
