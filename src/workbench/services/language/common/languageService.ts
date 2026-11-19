import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { ILanguageNameIdPair, ILanguageService } from '../../../../editor/common/languages/language.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { resolveExtensionResource } from '../../extensions/common/extensionResources.js';
import { ExtensionsRegistry } from '../../extensions/common/extensionsRegistry.js';
import type { ExtensionMessageCollector } from '../../extensions/common/extensionsRegistry.js';
import { LanguagesRegistry, PLAINTEXT_DEFINITION } from './languagesRegistry.js';
import type { ILanguageDefinition } from './languagesRegistry.js';

/** A `contributes.languages` entry that passed validation, with the extension that made it. */
export interface IContributedLanguage extends ILanguageDefinition {
  readonly extensionId: string;
}

/**
 * Swaps one set of contributions for the next. The extension service disposes every point's registrations
 * and calls `accept` again whenever extensions or the theme change; a dispose that no `accept` follows in
 * the same turn is a real removal. Without this, every refresh would send the languages through "none"
 * and back, and listeners would see them flicker.
 */
export class ContributionSlot<T> {
  private generation = 0;
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  current: readonly T[] = [];

  replace(next: readonly T[]): IDisposable {
    const mine = ++this.generation;
    this.current = next;
    this.changed.fire();
    return toDisposable(() => queueMicrotask(() => {
      if (this.generation === mine) {
        this.current = [];
        this.changed.fire();
      }
    }));
  }
}

/** A manifest value that is an array of strings. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** The languages extensions contribute right now, in extension order. */
export const languageContributions = new ContributionSlot<IContributedLanguage>();

/** VS Code's `isValidLanguageExtensionPoint`: a wrong field rejects the entry, with a message naming it. */
function validateLanguage(value: unknown, path: string, collector: ExtensionMessageCollector): boolean {
  if (!isRecord(value)) {
    collector.error(path, 'Expected a language object.');
    return false;
  }
  if (typeof value.id !== 'string' || !value.id) {
    collector.error(path + '.id', 'Property `id` is mandatory and must be of type `string`.');
    return false;
  }
  for (const key of ['extensions', 'filenames', 'filenamePatterns', 'aliases', 'mimetypes'] as const) {
    if (value[key] !== undefined && !isStringArray(value[key])) {
      collector.error(`${path}.${key}`, `Property \`${key}\` can be omitted and must be of type \`string[]\`.`);
      return false;
    }
  }
  for (const key of ['firstLine', 'configuration'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      collector.error(`${path}.${key}`, `Property \`${key}\` can be omitted and must be of type \`string\`.`);
      return false;
    }
  }
  return true;
}

ExtensionsRegistry.registerExtensionPoint<unknown[]>({
  name: 'languages',
  validate: (value): value is unknown[] => Array.isArray(value),
  accept(users, registrations, context) {
    const languages: IContributedLanguage[] = [];
    for (const { description, value, collector } of users) {
      const extensionId = description.identifier.value;
      value.forEach((entry, index) => {
        const path = `contributes.languages[${index}]`;
        if (!validateLanguage(entry, path, collector)) {
          return;
        }
        const language = entry as Record<string, unknown> & { id: string; configuration?: string };
        let configuration: URI | undefined;
        if (language.configuration) {
          configuration = resolveExtensionResource(URI.parse(description.location), language.configuration);
          if (!configuration) {
            collector.warn(path + '.configuration',
              `'${language.configuration}' is not a relative path inside the extension. The language is registered without this configuration.`);
          }
          // As in VS Code, a language that names a configuration activates its extension when it is used.
          context.addActivationEvent(extensionId, `onLanguage:${language.id}`);
        }
        languages.push({
          extensionId,
          id: language.id,
          aliases: language.aliases as string[] | undefined,
          extensions: language.extensions as string[] | undefined,
          filenames: language.filenames as string[] | undefined,
          filenamePatterns: language.filenamePatterns as string[] | undefined,
          firstLine: language.firstLine as string | undefined,
          mimetypes: language.mimetypes as string[] | undefined,
          configuration,
        });
      });
    }
    registrations.add(languageContributions.replace(languages));
  },
});

/** A stable text for a set of definitions: `URI.toJSON` writes a configuration file as its components. */
function signature(definitions: readonly ILanguageDefinition[]): string {
  return JSON.stringify(definitions);
}

function createRegistry(definitions: readonly ILanguageDefinition[]): LanguagesRegistry {
  return new LanguagesRegistry(definitions, message => console.warn(message));
}

/**
 * The workbench's languages: Monaco's built-in ones once the editor package is loaded (only plain text
 * before), and the ones extensions contribute, which extend a built-in language of the same id. It
 * fires `onDidChange` only when the set of definitions really changed.
 */
export class WorkbenchLanguageService extends Disposable implements ILanguageService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChange = this._register(new Emitter<void>());
  readonly onDidChange = this._onDidChange.event;

  private builtin: readonly ILanguageDefinition[] = [PLAINTEXT_DEFINITION];
  private hasMonacoLanguages = false;
  private registry: LanguagesRegistry;
  private registrySignature: string;
  /** Resources guessed as no language before the built-in languages were known, by their text. */
  private readonly unresolvedGuesses = new Map<string, URI>();

  constructor() {
    super();
    const definitions = this.definitions();
    this.registry = createRegistry(definitions);
    this.registrySignature = signature(definitions);
    this._register(languageContributions.onDidChange(() => this.update()));
  }

  /** Monaco's built-in languages, given once the editor package has loaded. */
  setBuiltinLanguages(definitions: readonly ILanguageDefinition[]): void {
    this.builtin = definitions.some(definition => definition.id === PLAINTEXT_DEFINITION.id)
      ? definitions : [PLAINTEXT_DEFINITION, ...definitions];
    this.hasMonacoLanguages = true;
    this.update();
  }

  /**
   * The resources a guess found no language for while the built-in languages were unknown. The guess
   * of a model created then fell back to plain text; the caller can guess again.
   */
  takeUnresolvedGuesses(): URI[] {
    const resources = [...this.unresolvedGuesses.values()];
    this.unresolvedGuesses.clear();
    return resources;
  }

  getConfigurationFiles(languageId: string): readonly URI[] {
    return this.registry.getConfigurationFiles(languageId);
  }

  private definitions(): ILanguageDefinition[] {
    return [...this.builtin, ...languageContributions.current];
  }

  private update(): void {
    const definitions = this.definitions();
    const next = signature(definitions);
    if (next === this.registrySignature) {
      return;
    }
    this.registry = createRegistry(definitions);
    this.registrySignature = next;
    this._onDidChange.fire();
  }

  isRegisteredLanguageId(languageId: string): boolean {
    return this.registry.isRegisteredLanguageId(languageId);
  }

  getRegisteredLanguageIds(): string[] {
    return this.registry.getRegisteredLanguageIds();
  }

  getSortedRegisteredLanguageNames(): ILanguageNameIdPair[] {
    return this.registry.getSortedRegisteredLanguageNames();
  }

  getLanguageName(languageId: string): string | null {
    return this.registry.getLanguageName(languageId);
  }

  getExtensions(languageId: string): readonly string[] {
    return this.registry.getExtensions(languageId);
  }

  getFilenames(languageId: string): readonly string[] {
    return this.registry.getFilenames(languageId);
  }

  getLanguageIdByLanguageName(languageName: string): string | null {
    return this.registry.getLanguageIdByLanguageName(languageName);
  }

  guessLanguageIdByFilepathOrFirstLine(resource: URI | null, firstLine?: string): string | null {
    const languageId = this.registry.guessLanguageId(resource?.path, firstLine);
    if (languageId === null && resource && !this.hasMonacoLanguages && this.unresolvedGuesses.size < 1000) {
      this.unresolvedGuesses.set(resource.toString(), resource);
    }
    return languageId;
  }
}
