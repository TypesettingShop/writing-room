import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { loadMonaco } from '../../../../editor/browser/monaco.js';
import type { MonacoNamespace } from '../../../../editor/browser/monaco.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { watchRequestedLanguages } from '../../../services/language/common/requestedLanguages.js';
import { createSnippetCompletionProvider } from './snippetCompletionProvider.js';
import { snippetContributions, SnippetsService } from './snippetsService.js';

/**
 * Gives each language its contributed snippets as completions, from the moment a model of the language
 * exists, and takes them away with the extension that contributed them.
 */
export class SnippetsContribution extends Disposable {
  static readonly ID = 'workbench.contrib.snippets';

  private readonly snippets: SnippetsService;
  private readonly requested = new Set<string>();
  private readonly providers = new Map<string, IDisposable>();
  private monaco: MonacoNamespace | undefined;

  constructor(
    @IModelService modelService: IModelService,
    @IFileService fileService: IFileService,
  ) {
    super();
    this.snippets = new SnippetsService(fileService);
    this._register(snippetContributions.onDidChange(() => {
      this.snippets.prune();
      for (const languageId of this.requested) {
        void this.update(languageId);
      }
    }));
    this._register(watchRequestedLanguages(modelService, languageId => {
      this.requested.add(languageId);
      void this.update(languageId);
    }));
    this._register({ dispose: () => {
      for (const provider of this.providers.values()) {
        provider.dispose();
      }
      this.providers.clear();
    } });
  }

  /** Overridden by tests, which have no editor package. */
  protected loadMonaco(): Promise<MonacoNamespace> {
    return loadMonaco();
  }

  private async update(languageId: string): Promise<void> {
    const wanted = this.snippets.contributionsFor(languageId).length > 0;
    if (!wanted) {
      this.providers.get(languageId)?.dispose();
      this.providers.delete(languageId);
      return;
    }
    if (this.providers.has(languageId)) {
      return;
    }
    const monaco = this.monaco ??= await this.loadMonaco();
    if (this.providers.has(languageId) || !this.snippets.contributionsFor(languageId).length) {
      return;
    }
    this.providers.set(languageId, monaco.languages.registerCompletionItemProvider(languageId,
      createSnippetCompletionProvider(monaco, this.snippets, languageId)));
  }
}

registerWorkbenchContribution2(SnippetsContribution.ID, SnippetsContribution);
