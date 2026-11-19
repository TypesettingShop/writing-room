const vscode = require('vscode');

exports.activate = function (context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('runtime.store', async () => {
      await Promise.all([
        context.globalState.update('saved', { count: 1 }),
        context.globalState.update('__proto__', 'stored safely'),
        context.workspaceState.update('workspace', true),
        context.secrets.store('session', 'secret'),
      ]);
      const copy = context.globalState.get('saved');
      copy.count = 9;
      void vscode.window.showInformationMessage('Runtime stored. Copy isolated: ' + (context.globalState.get('saved').count === 1)).then(undefined, () => {});
    }),
    vscode.commands.registerCommand('runtime.restore', async () => {
      void vscode.window.showInformationMessage('Runtime state: ' + [
        context.globalState.get('saved')?.count ?? 'empty',
        context.globalState.get('__proto__', 'empty'),
        context.workspaceState.get('workspace', false),
        await context.secrets.get('session') || 'no secret',
      ].join(', ')).then(undefined, () => {});
    }),
    vscode.commands.registerCommand('runtime.inspect', async () => {
      const extension = vscode.extensions.getExtension('Test.Runtime-Context');
      const exported = await vscode.extensions.getExtension('test.runtime-export').activate();
      let sent = false;
      const logger = vscode.env.createTelemetryLogger({
        sendEventData() { sent = true; },
        sendErrorData() { sent = true; },
        flush() { sent = true; },
      });
      logger.logUsage('unused');
      logger.logError(new Error('unused'));
      logger.dispose();
      void vscode.window.showInformationMessage([
        vscode.version, vscode.env.appName, vscode.env.uiKind,
        extension.isActive, exported, sent, context.storageUri.toString(), context.globalStorageUri.toString(),
      ].join(' | ')).then(undefined, () => {});
    }),
  );
};
