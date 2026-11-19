const vscode = require('vscode');

// Providers of the `lftest` language for the language feature specs. Each group of features adds its
// providers to `providers` below; `languageFeaturesFixture.unregister` and `.register` take them all
// away and bring them back.

const selector = { language: 'lftest' };
/** How many times each completion item was resolved, by label. */
const resolved = new Map();
/** The extension host's completion cache size while an item was resolved, so while the widget was open. */
let cacheWhileOpen;
let hoverCommandRuns = 0;

const labelOf = item => typeof item.label === 'string' ? item.label : item.label.label;
const textBefore = (document, position) => document.lineAt(position.line).text.slice(0, position.character);

function completionItems(document, position) {
  const snippet = new vscode.CompletionItem('fixtureSnippet', vscode.CompletionItemKind.Snippet);
  snippet.insertText = new vscode.SnippetString('snip(${1:first}, ${2:second})$0');
  snippet.sortText = 'a';

  const command = new vscode.CompletionItem({ label: 'fixtureCommand', description: 'runs a command' }, vscode.CompletionItemKind.Function);
  command.sortText = 'b';
  // A function argument cannot be copied: it stays on the extension host and comes back as it was.
  command.command = { command: 'languageFeaturesFixture.accepted', title: 'Accepted', arguments: [{ callback: () => 'kept' }, 'from-item'] };
  command.additionalTextEdits = [vscode.TextEdit.insert(new vscode.Position(0, 0), 'import;\n')];

  const key = new vscode.CompletionItem('fixtureKey', vscode.CompletionItemKind.Keyword);
  key.sortText = 'c';
  key.commitCharacters = ['('];

  // Inserting stops at the cursor; replacing takes the rest of the line.
  const replace = new vscode.CompletionItem('fixtureReplace', vscode.CompletionItemKind.Variable);
  replace.sortText = 'd';
  const word = document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
  replace.range = { inserting: new vscode.Range(word.start, position), replacing: new vscode.Range(word.start, document.lineAt(position.line).range.end) };

  return [snippet, command, key, replace];
}

const completionProvider = {
  async provideCompletionItems(document, position, _token, context) {
    const before = textBefore(document, position);
    if (before.endsWith('slow.')) {
      // A late answer, after the next keystroke asked again: it must never show.
      await new Promise(resolve => setTimeout(resolve, 1500));
      return [new vscode.CompletionItem('staleResult', vscode.CompletionItemKind.Text)];
    }
    if (before.endsWith('.')) {
      const item = new vscode.CompletionItem(before.endsWith('x.') ? 'freshResult' : 'dotMember', vscode.CompletionItemKind.Field);
      item.detail = 'trigger ' + context.triggerKind + ' ' + context.triggerCharacter;
      return [item];
    }
    const range = document.getWordRangeAtPosition(position);
    const word = range ? document.getText(new vscode.Range(range.start, position)) : '';
    if (word.startsWith('inc')) {
      // Incomplete: every keystroke asks again, and the label says how long the word was.
      return new vscode.CompletionList([new vscode.CompletionItem('incomplete' + word.length, vscode.CompletionItemKind.Value)], true);
    }
    return completionItems(document, position);
  },
  async resolveCompletionItem(item) {
    const label = labelOf(item);
    resolved.set(label, (resolved.get(label) ?? 0) + 1);
    cacheWhileOpen = await vscode.commands.executeCommand('_workbench.languageFeatures.completionCacheSize');
    item.documentation = new vscode.MarkdownString('Resolved **' + label + '**');
    return item;
  },
};

const hoverProvider = {
  provideHover(document, position) {
    const range = document.getWordRangeAtPosition(position);
    if (!range || document.getText(range) !== 'hoverme') {
      return undefined;
    }
    // Untrusted, with HTML: the command link must stay dead and the script and handler must never run.
    const markdown = new vscode.MarkdownString('**Fixture hover** [Run hover command](command:languageFeaturesFixture.hoverCommand) '
      + '<details open ontoggle="window.lfHoverScript = 1"><summary>html</summary></details><script>window.lfHoverScript = 2</script>');
    markdown.supportHtml = true;
    return new vscode.Hover([markdown, { language: 'lftest', value: 'fixture code block' }], range);
  },
};

const secondHoverProvider = {
  provideHover(document, position) {
    const range = document.getWordRangeAtPosition(position);
    return range && document.getText(range) === 'hoverme' ? new vscode.Hover(new vscode.MarkdownString('Second hover')) : undefined;
  },
};

const signatureHelpProvider = {
  provideSignatureHelp(document, position) {
    const before = textBefore(document, position);
    const open = before.lastIndexOf('snip(');
    if (open < 0 || before.indexOf(')', open) >= 0) {
      return undefined;
    }
    const signature = new vscode.SignatureInformation('snip(first, second)', new vscode.MarkdownString('Snips.'));
    signature.parameters = [new vscode.ParameterInformation([5, 10], 'The first.'), new vscode.ParameterInformation('second', 'The second.')];
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter = Math.min(before.slice(open).split(',').length - 1, 1);
    return help;
  },
};

/** Registers every provider of the fixture; the disposables take them back. */
const providers = () => [
  vscode.languages.registerCompletionItemProvider(selector, completionProvider, '.'),
  vscode.languages.registerHoverProvider(selector, hoverProvider),
  vscode.languages.registerHoverProvider(selector, secondHoverProvider),
  vscode.languages.registerSignatureHelpProvider(selector, signatureHelpProvider, { triggerCharacters: ['('], retriggerCharacters: [','] }),
];

module.exports.activate = context => {
  let registered = providers();
  context.subscriptions.push({ dispose: () => registered.forEach(registration => registration.dispose()) });
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.unregister', () => {
    registered.forEach(registration => registration.dispose());
    registered = [];
  }));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.register', () => {
    if (!registered.length) {
      registered = providers();
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.accepted', (first, second) =>
    vscode.window.showInformationMessage('Accepted: ' + typeof first?.callback + ' ' + first?.callback?.() + ' ' + second)));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.hoverCommand', () => {
    hoverCommandRuns++;
    return vscode.window.showInformationMessage('Hover command ran');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.report', async () => {
    const cacheNow = await vscode.commands.executeCommand('_workbench.languageFeatures.completionCacheSize');
    const counts = [...resolved].map(([label, count]) => label + '=' + count).join(', ');
    return vscode.window.showInformationMessage('Resolved: ' + counts + '; cache while open: ' + cacheWhileOpen
      + '; cache now: ' + cacheNow + '; hover commands: ' + hoverCommandRuns);
  }));
  // Not awaited: the message stays until it is dismissed, and activation must not wait for that.
  void vscode.window.showInformationMessage('Language features fixture activated');
};
