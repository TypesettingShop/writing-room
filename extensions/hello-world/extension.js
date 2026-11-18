const vscode = require('vscode');

exports.activate = function (context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('hello-world.hello', () => 'Hello from the extension host!'),
    vscode.commands.registerCommand('hello-world.where', () => 'Worker'),
  );
};
