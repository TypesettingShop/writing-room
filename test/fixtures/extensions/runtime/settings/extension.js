const vscode = require('vscode');

// Like the Markdown language client, a settings listener reads the extension's own section while it is removed
// (wr-eycu.4bd). Without the section the read throws, as the Markdown server did.
exports.activate = function (context) {
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => {
    const level = vscode.workspace.getConfiguration().get('runtimeRemoval').server.level;
    console.info('Runtime settings read ' + level);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('runtime.settings.show', () =>
    vscode.window.showInformationMessage('Runtime settings level: '
      + vscode.workspace.getConfiguration().get('runtimeRemoval').server.level)));
};
