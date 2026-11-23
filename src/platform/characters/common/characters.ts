import {
  isManuscriptRevision, manuscriptLimits, ManuscriptStoreError, normalizeManuscriptTitle, type ManuscriptStoreErrorCode,
} from '../../manuscript/common/manuscript.js';
import type { CharacterValues } from './characterFields.js';

export type CharacterNodeKind = 'folder' | 'character';
export const characterTypes = ['male', 'female', 'unknown', 'animal'] as const;
export type CharacterType = typeof characterTypes[number];

interface CharacterNodeType {
  readonly id: CharacterNodeKind;
  readonly container: boolean;
  readonly allowedParents: readonly (CharacterNodeKind | null)[];
}

export const characterNodeTypes: Readonly<Record<CharacterNodeKind, CharacterNodeType>> = {
  folder: { id: 'folder', container: true, allowedParents: [null, 'folder'] },
  character: { id: 'character', container: false, allowedParents: [null, 'folder'] },
};

interface CharacterNodeBase {
  id: string;
  parentId: string | null;
  title: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterFolder extends CharacterNodeBase {
  kind: 'folder';
  type?: never;
  values?: never;
}

export interface CharacterEntry extends CharacterNodeBase {
  kind: 'character';
  type: CharacterType;
  values: CharacterValues;
}

export type CharacterNode = CharacterFolder | CharacterEntry;

export interface CharacterTree {
  revision: number;
  nodes: CharacterNode[];
}

export const characterLimits = {
  title: manuscriptLimits.title,
  nodes: manuscriptLimits.nodes,
  values: 64 * 1024,
  workValues: manuscriptLimits.workMetadata,
} as const;

export function isCharacterNodeKind(value: unknown): value is CharacterNodeKind {
  return typeof value === 'string' && Object.hasOwn(characterNodeTypes, value);
}

export function normalizeCharacterType(value: unknown): CharacterType {
  const type = characterTypes.find(type => type === value);
  if (type === undefined) {
    throw new CharacterStoreError('invalid');
  }
  return type;
}

export function normalizeCharacterTitle(value: unknown): string {
  try {
    return normalizeManuscriptTitle(value, true);
  } catch (error) {
    if (error instanceof ManuscriptStoreError) {
      throw new CharacterStoreError('invalid');
    }
    throw error;
  }
}

export function checkCharacterRevision(current: number, expected: number): void {
  if (!isManuscriptRevision(expected)) {
    throw new CharacterStoreError('invalid');
  }
  if (current !== expected) {
    throw new CharacterStoreError('conflict', current);
  }
}

export type CharacterStoreErrorCode = Exclude<ManuscriptStoreErrorCode, 'precondition_failed'>;

const characterErrorMessages: Record<CharacterStoreErrorCode, string> = {
  not_found: 'Character resource not found.',
  conflict: 'The character data has changed.',
  invalid: 'Invalid character input.',
  too_large: 'Character input exceeds the size limit.',
  limit: 'The work has reached the character node limit.',
  unauthorized: 'Sign-in is required.',
};

export function isCharacterStoreErrorCode(value: unknown): value is CharacterStoreErrorCode {
  return typeof value === 'string' && Object.hasOwn(characterErrorMessages, value);
}

export class CharacterStoreError extends ManuscriptStoreError {
  declare readonly code: CharacterStoreErrorCode;

  constructor(code: CharacterStoreErrorCode, currentRevision?: number) {
    super(code, currentRevision);
    this.name = 'CharacterStoreError';
    this.message = characterErrorMessages[code];
  }
}
