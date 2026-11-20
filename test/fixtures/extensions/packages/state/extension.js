exports.activate = async context => {
  const { commands, window } = require('vscode');
  const { globalState, workspaceState } = context;
  const key = 'fixtureValue';
  // Preserve any existing value so reinstall only reads the defaults if uninstall cleared both scopes.
  await globalState.update(key, globalState.get(key, 'global initial'));
  await workspaceState.update(key, workspaceState.get(key, 'workspace initial'));

  context.subscriptions.push(
    commands.registerCommand('fixture.stateStorage.read', () =>
      window.showInformationMessage(`State Storage Fixture read ${globalState.get(key)} and ${workspaceState.get(key)}`)),
    commands.registerCommand('fixture.stateStorage.change', async () => {
      await globalState.update(key, 'global changed');
      await workspaceState.update(key, 'workspace changed');
      void window.showInformationMessage('State Storage Fixture changed both values');
    }),
  );
  void window.showInformationMessage('State Storage Fixture activated');
};
