const vscode = require('vscode');

const fruit = [
  { label: 'Apple', description: 'red' },
  { label: 'Banana', description: 'yellow' },
  { label: 'Citrus', kind: vscode.QuickPickItemKind.Separator },
  { label: 'Lemon', detail: 'sour' },
];

const notes = ['Draft', 'Diary', 'Recipe', 'Reading list'].map(label => ({ label }));
const refresh = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh notes' };

function say(text) {
  void vscode.window.showInformationMessage(text);
}

module.exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('windowUi.pickFruit', async () => {
    const picked = await vscode.window.showQuickPick(fruit, { placeHolder: 'Pick a fruit', matchOnDescription: true });
    say(picked ? 'Picked: ' + picked.label + (fruit.includes(picked) ? ' (same object)' : ' (copy)') : 'Picked: nothing');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('windowUi.pickMany', async () => {
    const items = [{ label: 'Tea', picked: true }, { label: 'Coffee' }, { label: 'Water', picked: true }];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Pick drinks', canPickMany: true });
    say(Array.isArray(picked) ? 'Drinks: ' + picked.map(item => item.label).join(', ') : 'Drinks: none');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('windowUi.askName', async () => {
    const name = await vscode.window.showInputBox({
      title: 'Name the note',
      prompt: 'At least three letters.',
      value: 'N',
      validateInput: async value => value.length < 3 ? 'Too short' : undefined,
    });
    say(name === undefined ? 'Name: cancelled' : 'Name: ' + name);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('windowUi.search', () => {
    // Refreshing replaces the items a moment later, with a new one at the top, as a search would.
    const pick = vscode.window.createQuickPick();
    pick.placeholder = 'Search notes';
    pick.items = notes;
    pick.buttons = [refresh];
    pick.onDidTriggerButton(button => {
      if (button !== refresh) {
        return;
      }
      pick.busy = true;
      setTimeout(() => {
        pick.items = [{ label: 'New note', alwaysShow: true }, ...notes];
        pick.busy = false;
      }, 50);
    });
    pick.onDidAccept(() => {
      const item = pick.selectedItems[0];
      pick.hide();
      say('Opened: ' + (item ? item.label : 'nothing'));
    });
    pick.onDidHide(() => pick.dispose());
    pick.show();
  }));
};
