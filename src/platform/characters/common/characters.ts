import { ManuscriptStoreError, type ManuscriptStoreErrorCode } from '../../manuscript/common/manuscript.js';

export type CharacterStoreErrorCode = Exclude<ManuscriptStoreErrorCode, 'precondition_failed'>;

const characterErrorMessages: Record<CharacterStoreErrorCode, string> = {
  not_found: 'Character resource not found.',
  conflict: 'The character tree has changed.',
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
