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
  // Explorer context menu entries: what they are given is shown as a message.
  for (const id of ['filesFixture.markdownItem', 'filesFixture.folderItem']) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async uri => {
      const kind = uri instanceof vscode.Uri ? 'Uri' : typeof uri;
      await vscode.window.showInformationMessage(id + ' gave ' + kind + ' ' + (uri ? uri.scheme + ':' + uri.path : ''));
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand('filesFixture.revealDeep', () =>
    vscode.commands.executeCommand('revealInExplorer', vscode.Uri.parse('vscode-vfs://writing-room/workspace/deep/inner/note.md'))));
};
