const vscode = require('vscode');

/** Shows what a dialog gave back: a list's paths, one Uri's path, or nothing. */
function describe(result) {
  if (result === undefined) {
    return 'nothing';
  }
  if (Array.isArray(result)) {
    return 'list ' + result.map(uri => uri.scheme + ':' + uri.path).join(', ');
  }
  return 'uri ' + result.scheme + ':' + result.path;
}

module.exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('filesFixture.openMany', async () => {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: true, title: 'Fixture Open', filters: { Markdown: ['md'] },
    });
    await vscode.window.showInformationMessage('Open dialog gave ' + describe(result));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('filesFixture.saveOutside', async () => {
    const result = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.parse('file:///etc/passwd'), saveLabel: 'Keep Here', title: 'Fixture Save',
    });
    await vscode.window.showInformationMessage('Save dialog gave ' + describe(result));
  }));
};
