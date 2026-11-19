import { match } from '../../base/common/glob.js';
import type { IRelativePattern } from '../../base/common/glob.js';
import { normalize } from '../../base/common/path.js';
import type { URI } from '../../base/common/uri.js';

/**
 * Which documents a language feature provider answers for (VS Code's `LanguageFilter`). A pattern is
 * matched against the document's file system path (`URI.fsPath`); a relative pattern only below its base.
 */
export interface LanguageFilter {
  readonly language?: string;
  readonly scheme?: string;
  readonly pattern?: string | IRelativePattern;
  /** Notebook cells are not documents here: a filter that names a notebook type matches nothing. */
  readonly notebookType?: string;
}

export type LanguageSelector = string | LanguageFilter | ReadonlyArray<string | LanguageFilter>;

/**
 * How well a selector matches a document, as VS Code scores it (`languageSelector.ts`): 10 for a
 * language, scheme or pattern that is named exactly, 5 for `*`, 0 when any part of a filter does not
 * match. An array scores as its best entry. A document that is not synchronized with extensions scores 0.
 */
export function score(selector: LanguageSelector | undefined, candidateUri: URI, candidateLanguage: string, candidateIsSynchronized: boolean): number {
  if (Array.isArray(selector)) {
    let result = 0;
    for (const filter of selector as ReadonlyArray<string | LanguageFilter>) {
      const value = score(filter, candidateUri, candidateLanguage, candidateIsSynchronized);
      if (value === 10) {
        return value;
      }
      result = Math.max(result, value);
    }
    return result;
  }
  if (typeof selector === 'string') {
    if (!candidateIsSynchronized) {
      return 0;
    }
    return selector === '*' ? 5 : selector === candidateLanguage ? 10 : 0;
  }
  if (!selector || typeof selector !== 'object' || !candidateIsSynchronized) {
    return 0;
  }
  const { language, scheme, pattern, notebookType } = selector as LanguageFilter;
  let result = 0;
  if (scheme) {
    if (scheme === candidateUri.scheme) {
      result = 10;
    } else if (scheme === '*') {
      result = 5;
    } else {
      return 0;
    }
  }
  if (language) {
    if (language === candidateLanguage) {
      result = 10;
    } else if (language === '*') {
      result = Math.max(result, 5);
    } else {
      return 0;
    }
  }
  if (notebookType) {
    // No document here belongs to a notebook.
    return 0;
  }
  if (pattern) {
    const normalized = typeof pattern === 'string' ? pattern : { ...pattern, base: normalize(pattern.base) };
    const path = candidateUri.fsPath;
    let matched: boolean;
    try {
      matched = normalized === path || match(normalized, path);
    } catch {
      // A pattern the matcher refuses (too long, say) matches nothing.
      matched = false;
    }
    if (!matched) {
      return 0;
    }
    result = 10;
  }
  return result;
}
