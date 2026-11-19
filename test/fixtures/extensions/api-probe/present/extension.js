// Uses only members the API has had since v0.1.0.
const vscode = require('vscode');
const { Disposable } = vscode;
exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('api-probe-present.run', () => 'ran'));
  context.subscriptions.push(new Disposable(() => {}));
};
