import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { resolveExtensionResource } from '../../extensions/common/extensionResources.js';
import { ExtensionsRegistry } from '../../extensions/common/extensionsRegistry.js';
import type { ExtensionMessageCollector } from '../../extensions/common/extensionsRegistry.js';
import { ContributionSlot, isStringArray } from '../../language/common/languageService.js';

/** VS Code's `StandardTokenType`, which a grammar's `tokenTypes` name by word. */
export const enum StandardTokenType {
  Other = 0,
  Comment = 1,
  String = 2,
  RegEx = 3,
}

/** A `contributes.grammars` entry that passed validation, its path resolved inside the extension. */
export interface IContributedGrammar {
  readonly extensionId: string;
  /** The language the grammar tokenizes; a grammar without one is only included or injected. */
  readonly language?: string;
  readonly scopeName: string;
  readonly location: URI;
  /** Scope name to language id: the language a token inside that scope belongs to. */
  readonly embeddedLanguages: Readonly<Record<string, string>>;
  readonly tokenTypes: Readonly<Record<string, StandardTokenType>>;
  readonly injectTo: readonly string[];
  readonly balancedBracketSelectors?: readonly string[];
  readonly unbalancedBracketSelectors?: readonly string[];
}

/** The grammars extensions contribute right now, in extension order. */
export const grammarContributions = new ContributionSlot<IContributedGrammar>();

const tokenTypeNames: Readonly<Record<string, StandardTokenType>> = {
  string: StandardTokenType.String,
  comment: StandardTokenType.Comment,
  other: StandardTokenType.Other,
};

/** VS Code's `TMGrammars` validation: a wrong field rejects the entry, with a message naming it. */
function readGrammar(
  value: unknown, path: string, extensionId: string, location: string, collector: ExtensionMessageCollector,
): IContributedGrammar | undefined {
  if (!isRecord(value)) {
    collector.error(path, 'Expected a grammar object.');
    return undefined;
  }
  const { language, scopeName, path: grammarPath, embeddedLanguages, tokenTypes, injectTo } = value;
  if (language !== undefined && (typeof language !== 'string' || !language)) {
    collector.error(path + '.language', 'Expected `language` to be a language id.');
    return undefined;
  }
  if (typeof scopeName !== 'string' || !scopeName) {
    collector.error(path + '.scopeName', 'Expected `scopeName` to be a string, such as `source.js`.');
    return undefined;
  }
  if (typeof grammarPath !== 'string' || !grammarPath) {
    collector.error(path + '.path', 'Expected `path` to be a relative path to the grammar file.');
    return undefined;
  }
  if (embeddedLanguages !== undefined && !(isRecord(embeddedLanguages) && Object.values(embeddedLanguages).every(id => typeof id === 'string'))) {
    collector.error(path + '.embeddedLanguages', 'Expected `embeddedLanguages` to map scope names to language ids.');
    return undefined;
  }
  if (tokenTypes !== undefined && !(isRecord(tokenTypes) && Object.values(tokenTypes).every(type => typeof type === 'string' && Object.hasOwn(tokenTypeNames, type)))) {
    collector.error(path + '.tokenTypes', "Expected `tokenTypes` to map scope names to 'string', 'comment' or 'other'.");
    return undefined;
  }
  if (injectTo !== undefined && !isStringArray(injectTo)) {
    collector.error(path + '.injectTo', 'Expected `injectTo` to be an array of scope names.');
    return undefined;
  }
  for (const key of ['balancedBracketScopes', 'unbalancedBracketScopes'] as const) {
    if (value[key] !== undefined && !isStringArray(value[key])) {
      collector.error(`${path}.${key}`, `Expected \`${key}\` to be an array of scope selectors.`);
      return undefined;
    }
  }
  const resolved = resolveExtensionResource(URI.parse(location), grammarPath);
  if (!resolved) {
    collector.warn(path + '.path', `'${grammarPath}' is not a relative path inside the extension. The grammar is ignored.`);
    return undefined;
  }
  return {
    extensionId,
    language: language as string | undefined,
    scopeName,
    location: resolved,
    embeddedLanguages: Object.assign(Object.create(null), embeddedLanguages) as Record<string, string>,
    tokenTypes: Object.fromEntries(Object.entries((tokenTypes ?? {}) as Record<string, string>)
      .map(([scope, type]) => [scope, tokenTypeNames[type]])),
    injectTo: (injectTo as string[] | undefined) ?? [],
    balancedBracketSelectors: value.balancedBracketScopes as string[] | undefined,
    unbalancedBracketSelectors: value.unbalancedBracketScopes as string[] | undefined,
  };
}

ExtensionsRegistry.registerExtensionPoint<unknown[]>({
  name: 'grammars',
  after: ['languages'],
  validate: (value): value is unknown[] => Array.isArray(value),
  accept(users, registrations) {
    const grammars: IContributedGrammar[] = [];
    for (const { description, value, collector } of users) {
      const extensionId = description.identifier.value;
      value.forEach((entry, index) => {
        const grammar = readGrammar(entry, `contributes.grammars[${index}]`, extensionId, description.location, collector);
        if (grammar) {
          grammars.push(grammar);
        }
      });
    }
    registrations.add(grammarContributions.replace(grammars));
  },
});

/**
 * A stable text for a set of grammars, so a refresh that changes nothing can be told apart. `URI.toJSON`
 * writes a location as its components.
 */
export function grammarsSignature(grammars: readonly IContributedGrammar[]): string {
  return JSON.stringify(grammars);
}
