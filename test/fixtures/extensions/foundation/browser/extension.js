const vscode = require('vscode');

module.exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('foundation.reportResource', async resource => {
    const label = resource instanceof vscode.Uri ? resource.path : 'No fixture resource';
    await vscode.window.showInformationMessage('Fixture resource: ' + label);
  }));
};
