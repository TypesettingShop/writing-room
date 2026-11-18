const vscode = require('vscode');

exports.activate = function (context) {
  const status = vscode.window.createStatusBarItem();
  status.text = 'Remote fixture active';
  status.show();
  context.subscriptions.push(status, vscode.commands.registerCommand('fixture.remote.hello', () =>
    vscode.window.showInformationMessage('Cross-origin extension ran.', 'OK')));
};
