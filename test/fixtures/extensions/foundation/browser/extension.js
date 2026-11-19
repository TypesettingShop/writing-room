const vscode = require('vscode');
const quickFixKind = vscode.CodeActionKind.QuickFix.value;

module.exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('foundation.reportResource', async resource => {
    const label = resource instanceof vscode.Uri ? resource.path : 'No fixture resource';
    await vscode.window.showInformationMessage('Fixture resource: ' + label);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('foundation.reportKind', () =>
    vscode.window.showInformationMessage('Fixture code action kind: ' + quickFixKind)));
  const item = { label: 'Fixture Item' };
  context.subscriptions.push(vscode.window.registerTreeDataProvider('foundation.tree', {
    getChildren: () => [item],
    getTreeItem: element => new vscode.TreeItem(element.label),
  }));
  context.subscriptions.push(vscode.commands.registerCommand('foundation.reportTreeItem', element =>
    vscode.window.showInformationMessage(element === item ? 'Fixture tree item received' : 'Fixture tree item missing')));
};
