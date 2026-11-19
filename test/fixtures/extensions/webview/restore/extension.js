const vscode = require('vscode');

exports.activate = function (context) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let restores = 0;

  function register(id, handler) {
    context.subscriptions.push(vscode.commands.registerCommand('fixture.webview.' + id, handler));
  }

  function render(panel, state, label) {
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'state.js'));
    panel.webview.html = [
      '<button id="increment">Increment</button>',
      '<button id="oversize">Save Oversize State</button>',
      '<output id="counter">0</output>',
      '<p>' + label + '</p>',
      '<output id="serializer">' + (state?.count ?? '-') + '</output>',
      '<script src="' + script + '"></script>',
    ].join('');
  }

  function open(id, title, column) {
    const panel = vscode.window.createWebviewPanel('fixture.' + id, title, column, { enableScripts: true });
    render(panel, undefined, 'Opened');
  }

  register('restore', () => open('restore', 'Restorable', vscode.ViewColumn.One));
  register('restore-fail', () => open('restore-fail', 'Failing Restore', vscode.ViewColumn.Two));
  register('restore-late', () => open('restore-late', 'Late Restore', vscode.ViewColumn.One));
  register('restore-release', () => { release(); });
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('fixture.restore', {
      async deserializeWebviewPanel(panel, state) {
        render(panel, state, 'Restored ' + ++restores);
      },
    }),
    vscode.window.registerWebviewPanelSerializer('fixture.restore-fail', {
      async deserializeWebviewPanel() {
        throw new Error('Fixture restore failure');
      },
    }),
    vscode.window.registerWebviewPanelSerializer('fixture.restore-late', {
      async deserializeWebviewPanel(panel, state) {
        render(panel, state, 'Waiting for release');
        await pending;
        if (panel.visible) {
          try { render(panel, state, 'Late completion'); } catch { /* disposed while waiting */ }
        }
      },
    }),
  );
};
