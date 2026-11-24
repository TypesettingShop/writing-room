import type { Event } from '../../../../base/common/event.js';
import type { CharactersStore } from '../../../../platform/characters/common/charactersStore.js';
import { createDecorator, type BrandedService } from '../../../../platform/instantiation/common/instantiation.js';

export const ICharactersService = createDecorator<ICharactersService>('charactersService');

export interface DeletedCharacters {
  readonly workId: string;
  readonly nodeIds: readonly string[];
}

export interface WindowCharactersStore extends CharactersStore {
  /** Checks on a card's next save and broadcasts a newer template to this window. */
  checkTemplateChanges(workId: string): Promise<void>;
}

export interface ICharactersService extends BrandedService {
  readonly store: WindowCharactersStore;
  readonly usesMemory: boolean;
  readonly onDidChangeTree: Event<string>;
  readonly onDidChangeTemplate: Event<string>;
  readonly onDidDeleteCharacters: Event<DeletedCharacters>;
}
