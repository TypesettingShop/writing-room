// Uses only members the API has had since v0.1.0.
const vscode = require('vscode');
const { Disposable } = vscode;
exports.activate = context => {
  // A static method has no `prototype`; asking must answer false, not throw from the probe's proxy.
  if ('prototype' in Disposable.from) {
    throw new Error('Disposable.from has a prototype');
  }
  context.subscriptions.push(vscode.commands.registerCommand('api-probe-present.run', () => 'ran'));
  context.subscriptions.push(new Disposable(() => {}));
};
