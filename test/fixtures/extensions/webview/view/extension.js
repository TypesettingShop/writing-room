const vscode = require('vscode');

exports.activate = function (context) {
  const viewId = 'fixture.webview.view';
  const transitions = [];
  let current;
  let rejected = false;
  try {
    vscode.window.registerWebviewViewProvider('not.an.owned.view', {
      resolveWebviewView() {},
    });
  } catch {
    rejected = true;
  }

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(viewId, {
    resolveWebviewView(view, { state }, token) {
      current = view;
      view.title = 'Webview Counter';
      view.description = 'A Webview view supplied by the fixture';
      view.webview.options = { enableScripts: true };
      view.onDidChangeVisibility(() => {
        transitions.push(view.visible);
        void view.webview.postMessage(transitions);
      });
      const script = view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'view.js'));
      view.webview.html = '<button>Increment view</button><output id="count">0</output>'
        + '<output id="visibility"></output>'
        + '<p id="state">' + (state?.count ?? '-') + '</p>'
        + '<p id="owner">' + (rejected ? 'Ownership checked' : 'Unexpected registration') + '</p>'
        + '<p>' + (token.isCancellationRequested ? 'Cancelled' : 'Resolved') + '</p>'
        + '<script src="' + script + '"></script>';
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand('fixture.webview.showView', () => current?.show()));
};
