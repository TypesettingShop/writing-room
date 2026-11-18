const vscode = require('vscode');

exports.activate = function (context) {
  const group = { label: 'Greetings' };
  const greeting = { label: 'Hello from Writing Room', count: 0 };
  const changes = new vscode.EventEmitter();
  const tree = vscode.window.createTreeView('hello-world.tree', {
    treeDataProvider: {
      onDidChangeTreeData: changes.event,
      getChildren(element) {
        return element === group ? [greeting] : element ? [] : [group];
      },
      getTreeItem(element) {
        const item = new vscode.TreeItem(element.label, element === group
          ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = element === group ? 'greetings' : 'hello';
        if (element === greeting) {
          item.contextValue = 'greeting';
          item.description = element.count ? 'Viewed ' + element.count : 'Sample';
          item.command = { command: 'hello-world.select', title: 'Describe Greeting', arguments: [element] };
        }
        return item;
      },
    },
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.name = 'Hello World status';
  status.command = 'hello-world.hello';
  status.text = '$(beaker) Hello World';
  status.show();

  context.subscriptions.push(
    tree, status, changes,
    vscode.commands.registerCommand('hello-world.hello', async () => {
      status.text = '$(megaphone) Hello!';
      const result = await vscode.window.showInformationMessage('Hello from the extension host!', 'Greet', 'Later');
      status.text = result === undefined ? '$(beaker) Hello World' : '$(check) ' + result;
      return result;
    }),
    vscode.commands.registerCommand('hello-world.select', element => {
      if (element === greeting) {
        element.count++;
        changes.fire(element);
        return vscode.window.showInformationMessage(element.label, 'OK');
      }
    }),
    vscode.commands.registerCommand('hello-world.where', () =>
      vscode.window.showInformationMessage('Running in the extension Worker.', 'OK')),
  );
};
