import { parse as parseGlob } from '../../../../base/common/glob.js';
import { basename } from '../../../../base/common/path.js';
import type { URI } from '../../../../base/common/uri.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../editor/common/languages/language.js';
import type { ILanguageNameIdPair } from '../../../../editor/common/languages/language.js';

/**
 * One registration of a language: Monaco's built-in definition or an extension's `contributes.languages`
 * entry. A language registered more than once is the union of its registrations, as in VS Code.
 */
export interface ILanguageDefinition {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly extensions?: readonly string[];
  readonly filenames?: readonly string[];
  readonly filenamePatterns?: readonly string[];
  /** A regular expression the first line of a file of the language matches. */
  readonly firstLine?: string;
  readonly mimetypes?: readonly string[];
  /** The language configuration file, already resolved inside the contributing extension. */
  readonly configuration?: URI;
}

/** The text plain text has before Monaco is loaded, as Monaco names it. */
export const PLAINTEXT_DEFINITION: ILanguageDefinition = {
  id: PLAINTEXT_LANGUAGE_ID,
  aliases: ['Plain Text', 'text'],
  extensions: ['.txt'],
  mimetypes: ['text/plain'],
};

interface Association {
  readonly id: string;
  readonly filename?: string;
  readonly extension?: string;
  readonly filepattern?: string;
  readonly matchesPattern?: (path: string) => boolean;
  /** A pattern with a `/` matches the whole path, as in VS Code; otherwise the file name. */
  readonly patternOnPath?: boolean;
  readonly firstline?: RegExp;
}

interface ResolvedLanguage {
  readonly id: string;
  readonly aliases: string[];
  readonly extensions: string[];
  readonly filenames: string[];
  readonly configurations: URI[];
}

/**
 * The languages of a set of definitions and the associations that pick one for a path. It is
 * immutable: the language service builds another one when the definitions change.
 *
 * Picking follows VS Code's `getAssociationByPath`: an exact file name wins, then the longest file
 * name pattern, then the longest extension, then the first line; among equals the definition
 * registered last wins. Comparisons ignore case.
 */
export class LanguagesRegistry {
  private readonly languages = new Map<string, ResolvedLanguage>();
  private readonly associations: Association[] = [];
  private readonly lowercaseNames = new Map<string, string>();

  /**
   * @param report Receives a message for each part of a definition that cannot be used, such as a
   * first line that is not a regular expression. The rest of the definition still counts.
   */
  constructor(definitions: readonly ILanguageDefinition[], report: (message: string) => void = () => {}) {
    for (const definition of definitions) {
      this.add(definition, report);
    }
    for (const language of this.languages.values()) {
      for (const alias of language.aliases) {
        this.lowercaseNames.set(alias.toLowerCase(), language.id);
      }
    }
    for (const language of this.languages.values()) {
      if (!this.lowercaseNames.has(language.id.toLowerCase())) {
        this.lowercaseNames.set(language.id.toLowerCase(), language.id);
      }
    }
  }

  private add(definition: ILanguageDefinition, report: (message: string) => void): void {
    const { id } = definition;
    let language = this.languages.get(id);
    if (!language) {
      language = { id, aliases: [], extensions: [], filenames: [], configurations: [] };
      this.languages.set(id, language);
    }
    for (const alias of definition.aliases ?? []) {
      if (alias && !language.aliases.includes(alias)) {
        language.aliases.push(alias);
      }
    }
    for (const extension of definition.extensions ?? []) {
      if (extension && !language.extensions.includes(extension)) {
        language.extensions.push(extension);
      }
      this.associations.push({ id, extension: extension.toLowerCase() });
    }
    for (const filename of definition.filenames ?? []) {
      if (filename && !language.filenames.includes(filename)) {
        language.filenames.push(filename);
      }
      this.associations.push({ id, filename: filename.toLowerCase() });
    }
    for (const filepattern of definition.filenamePatterns ?? []) {
      try {
        const pattern = filepattern.toLowerCase();
        this.associations.push({
          id, filepattern: pattern, matchesPattern: parseGlob(pattern), patternOnPath: pattern.includes('/'),
        });
      } catch (error) {
        report(`The file name pattern '${filepattern}' of '${id}' is not valid: ${String(error)}`);
      }
    }
    if (definition.firstLine) {
      try {
        this.associations.push({ id, firstline: new RegExp(definition.firstLine) });
      } catch (error) {
        report(`The first line pattern '${definition.firstLine}' of '${id}' is not a regular expression: ${String(error)}`);
      }
    }
    if (definition.configuration) {
      language.configurations.push(definition.configuration);
    }
  }

  isRegisteredLanguageId(languageId: string): boolean {
    return this.languages.has(languageId);
  }

  getRegisteredLanguageIds(): string[] {
    return [...this.languages.keys()];
  }

  getSortedRegisteredLanguageNames(): ILanguageNameIdPair[] {
    return [...this.languages.values()]
      .map(language => ({ languageName: language.aliases[0] ?? language.id, languageId: language.id }))
      .sort((a, b) => a.languageName.localeCompare(b.languageName) || a.languageId.localeCompare(b.languageId));
  }

  getLanguageName(languageId: string): string | null {
    const language = this.languages.get(languageId);
    return language ? language.aliases[0] ?? language.id : null;
  }

  getExtensions(languageId: string): readonly string[] {
    return this.languages.get(languageId)?.extensions ?? [];
  }

  getFilenames(languageId: string): readonly string[] {
    return this.languages.get(languageId)?.filenames ?? [];
  }

  /** The configuration files of a language, in registration order: the last one wins where they overlap. */
  getConfigurationFiles(languageId: string): readonly URI[] {
    return this.languages.get(languageId)?.configurations ?? [];
  }

  getLanguageIdByLanguageName(languageName: string): string | null {
    return this.lowercaseNames.get(languageName.toLowerCase()) ?? null;
  }

  /** The language `path` (a URI path) or `firstLine` names, or `null`. */
  guessLanguageId(path: string | undefined, firstLine?: string): string | null {
    if (!path) {
      return null;
    }
    const lowercasePath = path.toLowerCase();
    const filename = basename(lowercasePath);
    let filenameMatch: Association | undefined;
    let patternMatch: Association | undefined;
    let extensionMatch: Association | undefined;
    // The association registered last wins over the others of its kind (VS Code issue 20074).
    for (let i = this.associations.length - 1; i >= 0; i--) {
      const association = this.associations[i];
      if (association.filename !== undefined && association.filename === filename) {
        filenameMatch = association;
        break;
      }
      if (association.filepattern && (!patternMatch || association.filepattern.length > patternMatch.filepattern!.length)
        && association.matchesPattern!(association.patternOnPath ? lowercasePath : filename)) {
        patternMatch = association;
      }
      if (association.extension && (!extensionMatch || association.extension.length > extensionMatch.extension!.length)
        && filename.endsWith(association.extension)) {
        extensionMatch = association;
      }
    }
    const byPath = filenameMatch ?? patternMatch ?? extensionMatch;
    if (byPath) {
      return byPath.id;
    }
    let line = firstLine;
    if (line?.charCodeAt(0) === 0xfeff) {
      line = line.slice(1);
    }
    if (line) {
      for (let i = this.associations.length - 1; i >= 0; i--) {
        const { firstline, id } = this.associations[i];
        if (firstline?.test(line)) {
          return id;
        }
      }
    }
    return null;
  }
}
