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

// --- Formatting, code actions and rename -----------------------------------------------------------

/** What the edit providers saw and did, for `languageFeaturesFixture.reportEdits`. */
const editReport = { formatted: 0, ranges: [], only: 'none', organizeImportsCancelled: 0 };

/** The document formatter: runs of spaces become one. A document holding `slowformat` answers late. */
const documentFormatter = {
  async provideDocumentFormattingEdits(document, options) {
    const slow = document.getText().includes('slowformat');
    if (slow) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    editReport.formatted++;
    const edits = [];
    for (let line = 0; line < document.lineCount; line++) {
      const text = document.lineAt(line).text;
      for (const match of text.matchAll(/ {2,}/g)) {
        edits.push(vscode.TextEdit.replace(new vscode.Range(line, match.index, line, match.index + match[0].length), ' '));
      }
    }
    editReport.options = options.tabSize + '/' + options.insertSpaces;
    return edits;
  },
};

/** The range formatter: `fmt` becomes `FMT` on the lines of the range. */
const rangeFormatter = {
  provideDocumentRangeFormattingEdits(document, range) {
    editReport.ranges.push(range.start.line + '-' + range.end.line);
    const edits = [];
    for (let line = range.start.line; line <= range.end.line; line++) {
      for (const match of document.lineAt(line).text.matchAll(/\bfmt\b/g)) {
        edits.push(vscode.TextEdit.replace(new vscode.Range(line, match.index, line, match.index + 3), 'FMT'));
      }
    }
    return edits;
  },
};

const lintSource = 'fixture-lint';
const lintRule = { value: 'FX1', target: vscode.Uri.parse('https://example.test/rules/FX1') };
const diagnostics = vscode.languages.createDiagnosticCollection('language-features-fixture');

/** Flags each `teh` of an `lftest` document. */
function lint(document) {
  if (document.languageId !== 'lftest') {
    return;
  }
  const found = [];
  for (let line = 0; line < document.lineCount; line++) {
    for (const match of document.lineAt(line).text.matchAll(/\bteh\b/g)) {
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, match.index, line, match.index + 3), 'Misspelled: teh', vscode.DiagnosticSeverity.Warning);
      diagnostic.source = lintSource;
      diagnostic.code = lintRule;
      found.push(diagnostic);
    }
  }
  diagnostics.set(document.uri, found);
}

const slowActionDocuments = new WeakSet();
const slowOrganizeDocuments = new WeakSet();

function waitForCodeActions(token, delay) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      cancellation.dispose();
      resolve(false);
    }, delay);
    const cancellation = token.onCancellationRequested(() => {
      clearTimeout(timer);
      cancellation.dispose();
      resolve(true);
    });
  });
}

/**
 * Quick fixes for the fixture's own diagnostics, found by source and code in the context: a preferred
 * fix listed second (Monaco shows it first), and one whose edit is computed when picked, after the
 * document changed, so it must not apply nor run its command. When a kind is asked for, a source action,
 * a disabled refactoring and a disabled organize imports.
 */
const codeActionProvider = {
  async provideCodeActions(document, range, context, token) {
    const slowOrganize = context.only?.value === 'source.organizeImports' && document.getText().includes('sloworganize');
    if (slowOrganize && !slowOrganizeDocuments.has(document) && !token.isCancellationRequested) {
      slowOrganizeDocuments.add(document);
      void vscode.window.showInformationMessage('Slow Organize Imports started');
      if (await waitForCodeActions(token, 2000)) {
        editReport.organizeImportsCancelled++;
        return [];
      }
    }
    // Only the first manual quick fix stalls, so the replacement can open its menu.
    if (context.triggerKind === vscode.CodeActionTriggerKind.Invoke
      && document.getText().includes('slowaction') && !slowActionDocuments.has(document)) {
      if (token.isCancellationRequested) {
        return [];
      }
      slowActionDocuments.add(document);
      void vscode.window.showInformationMessage('Slow code action started');
      await waitForCodeActions(token, 1250);
      if (token.isCancellationRequested) {
        return [];
      }
    }
    // Automatic light-bulb queries must not overwrite the kind of an explicit invocation.
    if (context.triggerKind === vscode.CodeActionTriggerKind.Invoke) {
      editReport.only = context.only?.value ?? 'none';
    }
    const actions = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== lintSource || typeof diagnostic.code !== 'object' || diagnostic.code.value !== 'FX1'
        || diagnostic.code.target.toString() !== lintRule.target.toString()) {
        continue;
      }
      const other = new vscode.CodeAction('Replace with ten', vscode.CodeActionKind.QuickFix);
      other.diagnostics = [diagnostic];
      other.edit = new vscode.WorkspaceEdit();
      other.edit.replace(document.uri, diagnostic.range, 'ten');
      const fix = new vscode.CodeAction('Fix typo: the', vscode.CodeActionKind.QuickFix);
      fix.diagnostics = [diagnostic];
      fix.isPreferred = true;
      fix.edit = new vscode.WorkspaceEdit();
      fix.edit.replace(document.uri, diagnostic.range, 'the');
      fix.command = { command: 'languageFeaturesFixture.fixed', title: 'Fixed', arguments: [{ callback: () => 'kept' }] };
      const stale = new vscode.CodeAction('Stale fix', vscode.CodeActionKind.QuickFix);
      stale.diagnostics = [diagnostic];
      stale.data = { uri: document.uri, range: diagnostic.range };
      actions.push(other, fix, stale);
    }
    if (context.only) {
      // Offered when a kind is asked for, whatever kind: Monaco shows only those of that kind.
      const organize = new vscode.CodeAction('Organize fixture', vscode.CodeActionKind.Source.append('organizeFixture'));
      organize.command = { command: 'languageFeaturesFixture.fixed', title: 'Organized' };
      const extract = new vscode.CodeAction('Extract fixture block', vscode.CodeActionKind.RefactorExtract);
      extract.disabled = { reason: 'Select a fixture block first' };
      const imports = new vscode.CodeAction('Organize fixture imports', vscode.CodeActionKind.SourceOrganizeImports);
      imports.disabled = { reason: 'Nothing to organize in the fixture' };
      actions.push(organize, extract, imports);
    }
    return actions;
  },
  async resolveCodeAction(action) {
    if (action.data) {
      // The document changes before the edit is made: the edit was computed for the old version.
      const before = new vscode.WorkspaceEdit();
      before.insert(action.data.uri, new vscode.Position(0, 0), '#');
      await vscode.workspace.applyEdit(before);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(action.data.uri, action.data.range, 'stale');
      action.command = { command: 'languageFeaturesFixture.fixed', title: 'Stale' };
    }
    return action;
  },
};

const renamedFile = vscode.Uri.parse('vscode-vfs://writing-room/workspace/renamed.lft');

/** Renames a word in the document and in the workspace file `renamed.lft`; `locked` cannot be renamed. */
const renameProvider = {
  prepareRename(document, position) {
    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      throw new Error('Nothing to rename here');
    }
    const word = document.getText(range);
    if (word === 'locked') {
      throw new Error('The fixture cannot rename locked');
    }
    return { range, placeholder: word + 'Placeholder' };
  },
  async provideRenameEdits(document, position, newName) {
    const word = document.getText(document.getWordRangeAtPosition(position));
    const edit = new vscode.WorkspaceEdit();
    const replaceAll = target => {
      for (let line = 0; line < target.lineCount; line++) {
        for (const match of target.lineAt(line).text.matchAll(new RegExp('\\b' + word + '\\b', 'g'))) {
          edit.replace(target.uri, new vscode.Range(line, match.index, line, match.index + word.length), newName);
        }
      }
    };
    replaceAll(document);
    if (document.uri.toString() !== renamedFile.toString()) {
      try {
        replaceAll(await vscode.workspace.openTextDocument(renamedFile));
      } catch {
        // No second file in this workspace.
      }
    }
    return edit;
  },
};


// --- Navigation: symbols, links, definitions, folding, code lenses --------------------------------

const workspaceFile = name => vscode.Uri.parse('vscode-vfs://writing-room/workspace/' + name);

/** Headings (`#`, `##`, ...) as a symbol tree: a heading holds the deeper ones below it. */
const documentSymbolProvider = {
  provideDocumentSymbols(document) {
    const roots = [];
    const open = [];
    for (let line = 0; line < document.lineCount; line++) {
      const match = /^(#+)\s+(.+)$/.exec(document.lineAt(line).text);
      if (!match) {
        continue;
      }
      const depth = match[1].length;
      while (open.length && open[open.length - 1].depth >= depth) {
        open.pop();
      }
      const range = new vscode.Range(line, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
      const symbol = new vscode.DocumentSymbol(match[2], 'level ' + depth, vscode.SymbolKind.String, range,
        new vscode.Range(line, depth + 1, line, depth + 1 + match[2].length));
      (open.length ? open[open.length - 1].symbol.children : roots).push(symbol);
      open.push({ depth, symbol });
    }
    return roots;
  },
};

/**
 * `[[name]]` links to the workspace file `name` (line 2), `{external}` to a web address,
 * `{run}` to the fixture's own command and `{other}` to a command the fixture does not contribute.
 */
const documentLinkProvider = {
  provideDocumentLinks(document) {
    const links = [];
    for (let line = 0; line < document.lineCount; line++) {
      const text = document.lineAt(line).text;
      for (const match of text.matchAll(/\[\[([\w.]+)\]\]|\{(external|run|other)\}/g)) {
        const range = new vscode.Range(line, match.index, line, match.index + match[0].length);
        const link = new vscode.DocumentLink(range);
        if (match[1]) {
          // Resolved when followed.
          link.data = match[1];
        } else if (match[2] === 'external') {
          // A label rather than a URL in the buffer gets only the extension's link.
          link.target = vscode.Uri.parse('https://example.com/');
        } else {
          link.target = vscode.Uri.parse(match[2] === 'run' ? 'command:languageFeaturesFixture.lensRan?%5B%22link%22%5D' : 'command:workbench.action.closeActiveEditor');
        }
        link.tooltip = 'Fixture link ' + match[0];
        links.push(link);
      }
    }
    return links;
  },
  resolveDocumentLink(link) {
    link.target = workspaceFile(link.data).with({ fragment: 'L2' });
    return link;
  },
};

/** `target` is defined on the second line of the workspace file `defs.lft`. */
const definitionProvider = {
  provideDefinition(document, position) {
    const range = document.getWordRangeAtPosition(position);
    if (!range || document.getText(range) !== 'target') {
      return undefined;
    }
    return [{ originSelectionRange: range, targetUri: workspaceFile('defs.lft'), targetRange: new vscode.Range(1, 0, 1, 15), targetSelectionRange: new vscode.Range(1, 4, 1, 10) }];
  },
};

/** A `begin` line folds down to the line before the next `end` line (0-based lines, as the API's). */
const foldingRangeProvider = {
  provideFoldingRanges(document) {
    const ranges = [];
    for (let line = 0; line < document.lineCount; line++) {
      if (document.lineAt(line).text === 'begin') {
        for (let end = line + 1; end < document.lineCount; end++) {
          if (document.lineAt(end).text === 'end') {
            ranges.push(new vscode.FoldingRange(line, end - 1, vscode.FoldingRangeKind.Region));
            break;
          }
        }
      }
    }
    return ranges;
  },
};

let lensGeneration = 1;
const lensesChanged = new vscode.EventEmitter();

/** A lens on each heading; `bumpLenses` changes their titles and says so. */
const codeLensProvider = {
  onDidChangeCodeLenses: lensesChanged.event,
  provideCodeLenses(document) {
    const lenses = [];
    for (let line = 0; line < document.lineCount; line++) {
      const match = /^#+\s+(.+)$/.exec(document.lineAt(line).text);
      if (match) {
        lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0)));
        lenses[lenses.length - 1].heading = match[1];
      }
    }
    return lenses;
  },
  resolveCodeLens(lens) {
    lens.command = { title: 'Lens ' + lensGeneration + ': ' + lens.heading, command: 'languageFeaturesFixture.lensRan', arguments: [lens.heading] };
    return lens;
  },
};

/** What `vscode.executeDocumentSymbolProvider` gives for the active document: names nested by depth, and whether they are `DocumentSymbol`s. */
async function reportSymbols() {
  const document = vscode.window.activeTextEditor?.document;
  const symbols = document ? await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) : undefined;
  const describe = list => list.map(symbol => symbol.name + (symbol.children.length ? '(' + describe(symbol.children) + ')' : '')).join(' ');
  const instances = (symbols ?? []).every(function check(symbol) {
    return symbol instanceof vscode.DocumentSymbol && symbol.children.every(check);
  });
  return vscode.window.showInformationMessage('Symbols: ' + describe(symbols ?? []) + '; DocumentSymbol ' + instances);
}

// --- Workspace symbols -------------------------------------------------------------------------------

/** How the second workspace symbol provider answers: 'slow' (late for `stale`), 'throw' (fails for `alpha`), or at once. */
let symbolMode = 'normal';
const symbolReport = { asked: 0, cancelled: 0 };
/** Whether `query`'s characters appear in `name` in order, ignoring case (as the Markdown language server does). */
const fuzzy = (query, name) => {
  let at = 0;
  for (const character of name.toLowerCase()) {
    if (at < query.length && character === query[at].toLowerCase()) {
      at++;
    }
  }
  return at === query.length;
};

/** The headings (`# ...` lines) of every `.lft` file of the workspace folder, open or not. */
const headingSymbolProvider = {
  async provideWorkspaceSymbols(query) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
      return [];
    }
    const symbols = [];
    for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
      if (type !== vscode.FileType.File || !name.endsWith('.lft')) {
        continue;
      }
      const uri = vscode.Uri.joinPath(folder, name);
      const lines = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).split('\n');
      lines.forEach((text, line) => {
        if (/^#+\s/.test(text) && fuzzy(query, text)) {
          symbols.push(new vscode.SymbolInformation(text, vscode.SymbolKind.String, 'Headings', new vscode.Location(uri, new vscode.Range(line, 0, line, text.length))));
        }
      });
    }
    return symbols;
  },
};

/**
 * A second provider: its rows are `query:<the query>`; in 'slow' mode the query `stale` answers late, in
 * 'throw' mode the query `alpha` throws (once per typed query, so a test can expect exactly one error).
 */
const echoSymbolProvider = {
  async provideWorkspaceSymbols(query, token) {
    symbolReport.asked++;
    if (symbolMode === 'throw' && query === 'alpha') {
      throw new Error('The echo symbol provider failed on purpose.');
    }
    if (symbolMode === 'slow' && query === 'stale') {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (token.isCancellationRequested) {
        symbolReport.cancelled++;
      }
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return folder ? [new vscode.SymbolInformation('query:' + query, vscode.SymbolKind.Key, '', new vscode.Location(vscode.Uri.joinPath(folder, 'echo.lft'), new vscode.Position(0, 0)))] : [];
  },
};

/** What `vscode.executeWorkspaceSymbolProvider` gives, whether the results are API instances, and the extension host's kept answers. */
async function reportWorkspaceSymbols() {
  const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', '');
  const instances = symbols.every(symbol => symbol instanceof vscode.SymbolInformation && symbol.location instanceof vscode.Location);
  const cached = await vscode.commands.executeCommand('_workbench.languageFeatures.workspaceSymbolCacheSize');
  return vscode.window.showInformationMessage('Workspace symbols: ' + symbols.map(symbol => symbol.name).sort().join(' | ')
    + '; SymbolInformation ' + instances + '; asked ' + symbolReport.asked + '; cancelled ' + symbolReport.cancelled + '; cached ' + cached);
}

/** Registers every provider of the fixture; the disposables take them back. */
const providers = () => [
  vscode.languages.registerCompletionItemProvider(selector, completionProvider, '.'),
  vscode.languages.registerHoverProvider(selector, hoverProvider),
  vscode.languages.registerHoverProvider(selector, secondHoverProvider),
  vscode.languages.registerSignatureHelpProvider(selector, signatureHelpProvider, { triggerCharacters: ['('], retriggerCharacters: [','] }),
  vscode.languages.registerDocumentFormattingEditProvider(selector, documentFormatter),
  vscode.languages.registerDocumentRangeFormattingEditProvider(selector, rangeFormatter),
  vscode.languages.registerCodeActionsProvider(selector, codeActionProvider, {
    providedCodeActionKinds: [
      vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Source, vscode.CodeActionKind.SourceOrganizeImports, vscode.CodeActionKind.RefactorExtract,
    ],
  }),
  vscode.languages.registerRenameProvider(selector, renameProvider),
  vscode.languages.registerDocumentSymbolProvider(selector, documentSymbolProvider),
  vscode.languages.registerDocumentLinkProvider(selector, documentLinkProvider),
  vscode.languages.registerDefinitionProvider(selector, definitionProvider),
  vscode.languages.registerFoldingRangeProvider(selector, foldingRangeProvider),
  vscode.languages.registerCodeLensProvider(selector, codeLensProvider),
  vscode.languages.registerWorkspaceSymbolProvider(headingSymbolProvider),
  vscode.languages.registerWorkspaceSymbolProvider(echoSymbolProvider),
];

module.exports.activate = context => {
  let registered = providers();
  context.subscriptions.push({ dispose: () => registered.forEach(registration => registration.dispose()) });
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.unregister', () => {
    registered.forEach(registration => registration.dispose());
    registered = [];
    void vscode.window.showInformationMessage('Language feature providers unregistered');
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
  context.subscriptions.push(diagnostics);
  vscode.workspace.textDocuments.forEach(lint);
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(lint));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => lint(event.document)));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.fixed', first =>
    vscode.window.showInformationMessage('Fixed by command: ' + (typeof first?.callback === 'function' ? first.callback() : 'no argument'))));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.reportEdits', async () => {
    const cached = await vscode.commands.executeCommand('_workbench.languageFeatures.codeActionCacheSize');
    return vscode.window.showInformationMessage('Edits: formatted ' + editReport.formatted + '; ranges ' + editReport.ranges.join(',')
      + '; options ' + editReport.options + '; only ' + editReport.only
      + '; organize imports cancelled ' + editReport.organizeImportsCancelled + '; code actions cached ' + cached);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.lensRan', heading =>
    vscode.window.showInformationMessage('Lens ran: ' + heading)));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.bumpLenses', () => {
    lensGeneration++;
    lensesChanged.fire();
  }));
  // Which documents of defs.lft the extension host saw open and close: a peek of the file opens one.
  const documentEvents = [];
  const defs = workspaceFile('defs.lft').toString();
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    if (document.uri.toString() === defs) documentEvents.push('open');
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    if (document.uri.toString() === defs) documentEvents.push('close');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.reportDocuments', () =>
    vscode.window.showInformationMessage('Documents: defs.lft ' + documentEvents.join(' ') + '; open now '
      + vscode.workspace.textDocuments.some(document => document.uri.toString() === defs))));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.reportSymbols', reportSymbols));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.reportWorkspaceSymbols', reportWorkspaceSymbols));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.slowSymbols', () => { symbolMode = 'slow'; }));
  context.subscriptions.push(vscode.commands.registerCommand('languageFeaturesFixture.throwingSymbols', () => { symbolMode = 'throw'; }));
  // Not awaited: the message stays until it is dismissed, and activation must not wait for that.
  void vscode.window.showInformationMessage('Language features fixture activated');
};
