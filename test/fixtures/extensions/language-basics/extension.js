// The language basics fixture: its languages, grammars and snippets come from the manifest alone. The
// code reports the activation that `onLanguage:fixturelang` causes, the language ids the API lists, and
// the scopes the workbench gives a line.
exports.activate = context => {
  const vscode = require('vscode');
  void vscode.window.showInformationMessage('Language basics fixture activated');
  context.subscriptions.push(vscode.commands.registerCommand('languageBasics.reportLanguages', async () => {
    const languages = await vscode.languages.getLanguages();
    const wanted = ['fixturelang', 'markdown', 'plaintext'].filter(id => languages.includes(id));
    void vscode.window.showInformationMessage('Language ids: ' + wanted.join(', '));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('languageBasics.reportScopes', async () => {
    const language = await vscode.window.showInputBox({ placeHolder: 'Language id' });
    const line = language && await vscode.window.showInputBox({ placeHolder: 'Line' });
    if (!language || line === undefined) {
      return;
    }
    const tokens = await vscode.commands.executeCommand('_workbench.textMate.tokenizeLine', language, line);
    void vscode.window.showInformationMessage('Scopes: ' + JSON.stringify(tokens));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('languageBasics.fixtureAction', () => {
    void vscode.window.showInformationMessage('Fixture language action ran');
  }));
};
