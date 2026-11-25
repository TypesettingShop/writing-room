import type { CharacterStoreErrorCode } from '../../characters/common/characters.js';
import { isManuscriptRevision, ManuscriptStoreError } from '../../manuscript/common/manuscript.js';

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
