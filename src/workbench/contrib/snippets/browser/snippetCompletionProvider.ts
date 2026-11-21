import type { MonacoNamespace } from '../../../../editor/browser/monaco.js';
import type { SnippetsService } from './snippetsService.js';

type Monaco = MonacoNamespace;
type CompletionItemProvider = Parameters<Monaco['languages']['registerCompletionItemProvider']>[1];
type CompletionItem = Awaited<ReturnType<CompletionItemProvider['provideCompletionItems']>> extends infer List
  ? List extends { suggestions: (infer Item)[] } ? Item : never : never;

/**
 * The completion provider of one language's contributed snippets, as VS Code's `SnippetCompletionProvider`
 * gives them: the prefix as the label with the snippet's name beside it, the description and the source
 * extension as the detail, inserted as a snippet over the word before the cursor. The files are read on
 * the first request.
 */
export function createSnippetCompletionProvider(monaco: Monaco, snippets: SnippetsService, languageId: string): CompletionItemProvider {
  return {
    async provideCompletionItems(model, position, _context, token) {
      const found = await snippets.getSnippets(languageId);
      if (token.isCancellationRequested || model.isDisposed()) {
        return { suggestions: [] };
      }
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber, startColumn: word.startColumn,
        endLineNumber: position.lineNumber, endColumn: position.column,
      };
      const suggestions: CompletionItem[] = found.map(snippet => ({
        label: { label: snippet.prefix, description: snippet.name },
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: `${snippet.description || snippet.name} (${snippet.source})`,
        documentation: snippet.body,
        insertText: snippet.body,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        // After the language's own completions, as VS Code sorts extension snippets.
        sortText: 'z-' + snippet.prefix,
        range,
      }));
      return { suggestions };
    },
  };
}
