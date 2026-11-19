import { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { extensionResourceLimits, resolveExtensionResource } from '../../../services/extensions/common/extensionResources.js';
import { ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';
import { ContributionSlot } from '../../../services/language/common/languageService.js';
import { parseSnippetFile } from './snippetsFile.js';
import type { ISnippet } from './snippetsFile.js';

/** A `contributes.snippets` entry: a snippet file for one language, resolved inside the extension. */
export interface IContributedSnippets {
  readonly extensionId: string;
  /** The extension's display name, which the completion detail names as the source. */
  readonly source: string;
  readonly language: string;
  readonly location: URI;
}

export const snippetContributions = new ContributionSlot<IContributedSnippets>();

ExtensionsRegistry.registerExtensionPoint<unknown[]>({
  name: 'snippets',
  after: ['languages'],
  validate: (value): value is unknown[] => Array.isArray(value),
  accept(users, registrations) {
    const contributions: IContributedSnippets[] = [];
    for (const { description, value, collector } of users) {
      const extensionId = description.identifier.value;
      const { displayName, name } = description.manifest;
      const source = typeof displayName === 'string' && displayName ? displayName : name;
      value.forEach((entry, index) => {
        const path = `contributes.snippets[${index}]`;
        if (!isRecord(entry) || typeof entry.language !== 'string' || !entry.language) {
          collector.error(path + '.language', 'Expected `language` to be a language id.');
          return;
        }
        if (typeof entry.path !== 'string' || !entry.path) {
          collector.error(path + '.path', 'Expected `path` to be a relative path to the snippet file.');
          return;
        }
        const location = resolveExtensionResource(URI.parse(description.location), entry.path);
        if (!location) {
          collector.warn(path + '.path', `'${entry.path}' is not a relative path inside the extension. The snippets are ignored.`);
          return;
        }
        contributions.push({ extensionId, source, language: entry.language, location });
      });
    }
    registrations.add(snippetContributions.replace(contributions));
  },
});

/** The snippets of one contributed file, with the file's source. */
export interface ISourcedSnippet extends ISnippet {
  readonly source: string;
}

/**
 * Reads contributed snippet files when their language first asks for completions, at most 8 MiB each,
 * and keeps them while the contribution stands. A file that cannot be read or parsed gives no snippets
 * and one warning; the other files of the language still give theirs.
 */
export class SnippetsService {
  private readonly files = new Map<string, Promise<readonly ISourcedSnippet[]>>();

  constructor(private readonly fileService: IFileService) {}

  /** The contributions for `languageId` right now. */
  contributionsFor(languageId: string): readonly IContributedSnippets[] {
    return snippetContributions.current.filter(contribution => contribution.language === languageId);
  }

  async getSnippets(languageId: string): Promise<ISourcedSnippet[]> {
    const lists = await Promise.all(this.contributionsFor(languageId).map(contribution => this.read(contribution)));
    return lists.flat();
  }

  /** Forgets the files no contribution names any more, so a removed extension's snippets are gone. */
  prune(): void {
    const live = new Set(snippetContributions.current.map(contribution => this.key(contribution)));
    for (const key of [...this.files.keys()]) {
      if (!live.has(key)) {
        this.files.delete(key);
      }
    }
  }

  private key({ extensionId, location }: IContributedSnippets): string {
    return extensionId + '\n' + location.toString();
  }

  private read(contribution: IContributedSnippets): Promise<readonly ISourcedSnippet[]> {
    const key = this.key(contribution);
    let snippets = this.files.get(key);
    if (!snippets) {
      const warn = (message: string) => console.warn(`[${contribution.extensionId}] ${contribution.location.toString()}: ${message}`);
      snippets = this.fileService.readFile(contribution.location, { limits: { size: extensionResourceLimits.resource } }).then(
        ({ value }) => parseSnippetFile(new TextDecoder().decode(value), warn).map(snippet => ({ ...snippet, source: contribution.source })),
        error => {
          warn(`the snippets could not be read: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        });
      this.files.set(key, snippets);
    }
    return snippets;
  }
}
