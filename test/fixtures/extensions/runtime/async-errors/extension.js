const vscode = require('vscode');

exports.activate = context => {
  const diagnostics = vscode.languages.createDiagnosticCollection('runtime-async-errors');
  diagnostics.dispose();
  context.subscriptions.push(
    vscode.commands.registerCommand('runtime.asyncErrors.run', () => {
      setTimeout(() => diagnostics.clear(), 0);
      void Promise.reject(new Error('Fixture rejected callback'));
      setTimeout(() => { throw new Error('Fixture timer callback'); }, 0);
    }),
    vscode.commands.registerCommand('runtime.asyncErrors.ping', () =>
      vscode.window.showInformationMessage('Runtime async error fixture is still running')),
    {
      dispose() {
        setTimeout(() => {
          try {
            diagnostics.clear();
          } catch (error) {
            throw new Error('Fixture timer after removal: ' + error.message);
          }
        }, 0);
      },
    },
  );
};
