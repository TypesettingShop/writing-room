const vscode = require('vscode');

exports.activate = context => {
  const diagnostics = vscode.languages.createDiagnosticCollection('runtime-cleanup-errors');
  context.subscriptions.push(diagnostics, { dispose: () => diagnostics.clear() },
    vscode.commands.registerCommand('runtime.cleanupErrors.ping', () =>
      vscode.window.showInformationMessage('Runtime cleanup error fixture is active')),
    { dispose: () => console.log('Runtime cleanup error fixture disposed its last subscription') });
};

exports.deactivate = async () => {
  throw new Error('Fixture deactivate failure');
};
