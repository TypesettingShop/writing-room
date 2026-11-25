import type { Event } from '../../../../base/common/event.js';
import { createDecorator, type BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import type { WorldStore } from '../../../../platform/world/common/worldStore.js';

export const IWorldService = createDecorator<IWorldService>('worldService');

export interface DeletedWorldNodes {
  readonly workId: string;
  readonly nodeIds: readonly string[];
}

export interface IWorldService extends BrandedService {
  readonly store: WorldStore;
  readonly usesMemory: boolean;
  readonly onDidChangeTree: Event<string>;
  readonly onDidChangeCalendar: Event<string>;
  readonly onDidDeleteNodes: Event<DeletedWorldNodes>;
}
