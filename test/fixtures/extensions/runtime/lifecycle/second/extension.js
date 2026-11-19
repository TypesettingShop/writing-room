const vscode = require('vscode');

exports.activate = async function (context) {
  const first = await vscode.commands.executeCommand('runtime.first');
  context.subscriptions.push(vscode.commands.registerCommand('runtime.second', () => 'second got ' + first));
};
