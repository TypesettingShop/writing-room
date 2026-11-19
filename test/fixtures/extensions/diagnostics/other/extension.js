const vscode = require('vscode');

module.exports.activate = context => {
  // The same name as the first fixture's collection.
  const collection = vscode.languages.createDiagnosticCollection('fixture');
  context.subscriptions.push(collection);
  context.subscriptions.push(vscode.commands.registerCommand('otherDiagnosticsFixture.set', () => {
    const item = new vscode.Diagnostic(new vscode.Range(4, 0, 4, 3), 'Other fixture error');
    item.source = 'other';
    collection.set(vscode.Uri.parse('vscode-userdata:/User/settings.json'), [item]);
  }));
};
