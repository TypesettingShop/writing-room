import { Event } from '../../../base/common/event.js';
import { basename } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { PLAINTEXT_LANGUAGE_ID } from '../languages/language.js';
import type { ILanguageNameIdPair, ILanguageService } from '../languages/language.js';

const PLAINTEXT_NAME = 'Plain Text';
const PLAINTEXT_EXTENSIONS = ['.txt'] as const;

/**
 * The language service the workbench starts with: it knows `plaintext` alone, as v0.1.0 did. The
 * language contribution member replaces it with a registry of contributed languages.
 */
export class PlaintextLanguageService implements ILanguageService {
  declare readonly _serviceBrand: undefined;

  /** Nothing is ever registered here, so nothing changes. */
  readonly onDidChange: Event<void> = Event.None;

  isRegisteredLanguageId(languageId: string): boolean {
    return languageId === PLAINTEXT_LANGUAGE_ID;
  }

  getRegisteredLanguageIds(): string[] {
    return [PLAINTEXT_LANGUAGE_ID];
  }

  getSortedRegisteredLanguageNames(): ILanguageNameIdPair[] {
    return [{ languageName: PLAINTEXT_NAME, languageId: PLAINTEXT_LANGUAGE_ID }];
  }

  getLanguageName(languageId: string): string | null {
    return languageId === PLAINTEXT_LANGUAGE_ID ? PLAINTEXT_NAME : null;
  }

  getExtensions(languageId: string): readonly string[] {
    return languageId === PLAINTEXT_LANGUAGE_ID ? PLAINTEXT_EXTENSIONS : [];
  }

  getFilenames(): readonly string[] {
    return [];
  }

  getLanguageIdByLanguageName(languageName: string): string | null {
    const name = languageName.toLowerCase();
    return name === PLAINTEXT_NAME.toLowerCase() || name === PLAINTEXT_LANGUAGE_ID ? PLAINTEXT_LANGUAGE_ID : null;
  }

  guessLanguageIdByFilepathOrFirstLine(resource: URI | null): string | null {
    const name = resource ? basename(resource).toLowerCase() : '';
    return PLAINTEXT_EXTENSIONS.some(extension => name.endsWith(extension)) ? PLAINTEXT_LANGUAGE_ID : null;
  }
}
