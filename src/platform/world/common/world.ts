import { characterLimits, type CharacterStoreErrorCode } from '../../characters/common/characters.js';
import type { CharacterTemplate, CharacterValues } from '../../characters/common/characterFields.js';
import {
  isManuscriptRevision, manuscriptLimits, ManuscriptStoreError, normalizeManuscriptTitle,
} from '../../manuscript/common/manuscript.js';

export type WorldNodeKind = 'category' | 'item' | 'calendar';

interface WorldNodeType {
  readonly id: WorldNodeKind;
  readonly container: boolean;
  readonly allowedParents: readonly (WorldNodeKind | null)[];
}

export const worldNodeTypes: Readonly<Record<WorldNodeKind, WorldNodeType>> = {
  category: { id: 'category', container: true, allowedParents: [null, 'category'] },
  item: { id: 'item', container: false, allowedParents: ['category'] },
  calendar: { id: 'calendar', container: false, allowedParents: [null] },
};

interface WorldNodeBase {
  id: string;
  parentId: string | null;
  title: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorldCategory extends WorldNodeBase {
  kind: 'category';
  fields: CharacterTemplate;
  values?: never;
}

export interface WorldItem extends WorldNodeBase {
  kind: 'item';
  fields?: never;
  values: CharacterValues;
}

export interface WorldCalendarNode extends WorldNodeBase {
  kind: 'calendar';
  fields?: never;
  values?: never;
}

export type WorldNode = WorldCategory | WorldItem | WorldCalendarNode;

export interface WorldTree {
  revision: number;
  nodes: WorldNode[];
}

export const worldLimits = {
  nodes: manuscriptLimits.nodes,
  title: manuscriptLimits.title,
  // normalizeCharacterValues enforces this per-item limit.
  values: characterLimits.values,
  workData: manuscriptLimits.workMetadata,
} as const;

export function normalizeWorldTitle(value: unknown): string {
  try {
    return normalizeManuscriptTitle(value, true);
  } catch (error) {
    if (error instanceof ManuscriptStoreError) {
      throw new WorldStoreError('invalid');
    }
    throw error;
  }
}

export type WorldStoreErrorCode = CharacterStoreErrorCode;

const messages: Record<WorldStoreErrorCode, string> = {
  not_found: 'World resource not found.',
  conflict: 'The world data has changed.',
  invalid: 'Invalid world input.',
  too_large: 'World input exceeds the size limit.',
  limit: 'The work has reached the world node limit.',
  unauthorized: 'Sign-in is required.',
};

export class WorldStoreError extends ManuscriptStoreError {
  declare readonly code: WorldStoreErrorCode;

  constructor(code: WorldStoreErrorCode, currentRevision?: number) {
    super(code, currentRevision);
    this.name = 'WorldStoreError';
    this.message = messages[code];
  }
}

export function checkWorldRevision(current: number, expected: number): void {
  if (!isManuscriptRevision(expected)) {
    throw new WorldStoreError('invalid');
  }
  if (current !== expected) {
    throw new WorldStoreError('conflict', current);
  }
}
