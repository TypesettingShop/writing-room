import { Event } from '../../../base/common/event.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';

export interface ResolvedKeybinding {
  getLabel(): string | null;
  getAriaLabel(): string | null;
}

export const IKeybindingService = createDecorator<IKeybindingService>('keybindingService');

export interface IKeybindingService extends BrandedService {
  readonly onDidUpdateKeybindings: Event<void>;
  lookupKeybinding(commandId: string): ResolvedKeybinding | undefined;
  /** Lets an editor opt specific commands into dispatch during its own IME composition. */
  dispatchDuringComposition?(event: KeyboardEvent, commands: readonly string[]): boolean;
}

export class NullKeybindingService implements IKeybindingService {
  declare readonly _serviceBrand: undefined;
  readonly onDidUpdateKeybindings = Event.None;
  lookupKeybinding(): undefined { return undefined; }
}

registerSingleton(IKeybindingService, NullKeybindingService);
