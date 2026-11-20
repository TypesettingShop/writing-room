exports.activate = context => {
  const { commands, window, workspace } = require('vscode');
  const events = [];
  function record(event, document) {
    if (document.uri.path.endsWith('/notes.fixture.md')) {
      events.push(event + ' ' + document.languageId);
    }
  }
  context.subscriptions.push(
    workspace.onDidCloseTextDocument(document => record('close', document)),
    workspace.onDidOpenTextDocument(document => record('open', document)),
    commands.registerCommand('languageBasics.reportLanguageEvents', () => {
      void window.showInformationMessage('Language events: ' + (events.splice(0).join(', ') || 'none'));
    }),
  );
};
