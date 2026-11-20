const vscode = require('vscode');

// Like markdownlint 0.62.1, a subscription reads the workspace while the extension is removed (wr-eycu.u4t).
exports.activate = function (context) {
  const ping = vscode.commands.registerCommand('runtime.cleanup.ping', () =>
    vscode.window.showInformationMessage('Runtime cleanup is active'));
  context.subscriptions.push({
    dispose() {
      const folders = vscode.workspace.workspaceFolders;
      ping.dispose();
      console.info('Runtime cleanup disposed after reading ' + (folders ? folders.length : 0) + ' workspace folders');
    },
  });
};
