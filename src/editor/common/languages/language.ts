import type { Event } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../platform/instantiation/common/instantiation.js';

export const PLAINTEXT_LANGUAGE_ID = 'plaintext';

export const ILanguageService = createDecorator<ILanguageService>('languageService');

export interface ILanguageNameIdPair {
  readonly languageName: string;
  readonly languageId: string;
}

/**
 * The languages the workbench knows: their ids, names, and the file names that pick them. The editor
 * part registers an implementation that knows only `plaintext`; the language contribution member
 * registers the real one under the same identifier, and consumers that keep a value listen to
 * `onDidChange` rather than reading it once.
 */
export interface ILanguageService extends BrandedService {
  /** The set of languages, or what one of them says about itself, changed. */
  readonly onDidChange: Event<void>;

  isRegisteredLanguageId(languageId: string): boolean;
  getRegisteredLanguageIds(): string[];
  /** The registered languages by their display name, sorted by it. */
  getSortedRegisteredLanguageNames(): ILanguageNameIdPair[];
  /** The display name (the first alias), or `null` for an unknown language. */
  getLanguageName(languageId: string): string | null;
  getExtensions(languageId: string): readonly string[];
  getFilenames(languageId: string): readonly string[];
  /** The id of the language with that display name or alias, compared without case. */
  getLanguageIdByLanguageName(languageName: string): string | null;
  /**
   * The language a resource's path, or its first line, names; `null` when none does. Callers fall
   * back to `plaintext`.
   */
  guessLanguageIdByFilepathOrFirstLine(resource: URI | null, firstLine?: string): string | null;
}
