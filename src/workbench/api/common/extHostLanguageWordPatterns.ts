import { toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';

/**
 * The word patterns that `languages.setLanguageConfiguration` gave, by language: a document's
 * `getWordRangeAtPosition` without a pattern of its own uses the pattern of its language. The latest
 * configuration of a language wins; disposing it gives the language the one before it back.
 */
const patterns = new Map<string, RegExp[]>();

export function setLanguageWordPattern(language: string, pattern: RegExp | undefined): IDisposable {
  if (!(pattern instanceof RegExp)) {
    return toDisposable(() => {});
  }
  const list = patterns.get(language) ?? [];
  list.push(pattern);
  patterns.set(language, list);
  return toDisposable(() => {
    const index = list.lastIndexOf(pattern);
    if (index !== -1) {
      list.splice(index, 1);
    }
    if (!list.length && patterns.get(language) === list) {
      patterns.delete(language);
    }
  });
}

export function languageWordPattern(language: string): RegExp | undefined {
  return patterns.get(language)?.at(-1);
}
