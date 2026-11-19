const vscode = require('vscode');

function report(prefix) {
  const configuration = vscode.workspace.getConfiguration('configurationApi');
  const markdown = vscode.workspace.getConfiguration('configurationApi', { languageId: 'markdown' });
  return vscode.window.showInformationMessage(prefix + ' greeting=' + configuration.get('greeting')
    + ' markdown=' + markdown.get('greeting') + ' count=' + configuration.get('count'));
}

module.exports.activate = context => {
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('configurationApi.count')) {
      // The listener reads the new value.
      void report('Changed:');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('configurationApi.report', () => report('Fixture configuration:')));
  context.subscriptions.push(vscode.commands.registerCommand('configurationApi.update', async () => {
    await vscode.workspace.getConfiguration('configurationApi').update('count', 5, vscode.ConfigurationTarget.Global);
    await report('Updated:');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('configurationApi.updateWorkspace', async () => {
    try {
      await vscode.workspace.getConfiguration('configurationApi').update('count', 6, vscode.ConfigurationTarget.Workspace);
      await vscode.window.showInformationMessage('Workspace update succeeded');
    } catch (error) {
      await vscode.window.showInformationMessage('Workspace update refused: ' + error.message);
    }
  }));
};
