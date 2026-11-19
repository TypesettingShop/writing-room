const vscode = require('vscode');

exports.activate = async function (context) {
  context.subscriptions.push(vscode.commands.registerCommand('runtime.first', () => 'first'));
  const second = await vscode.commands.executeCommand('runtime.second');
  context.subscriptions.push(vscode.commands.registerCommand('runtime.run', () =>
    vscode.window.showInformationMessage('Lifecycle result: ' + second)));
};

exports.deactivate = async function () {
  const label = await vscode.commands.executeCommand('runtime.first');
  console.info('Lifecycle deactivated: ' + label);
};
