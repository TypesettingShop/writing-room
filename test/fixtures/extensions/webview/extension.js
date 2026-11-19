const vscode = require('vscode');

exports.activate = function (context) {
  const panels = new Map();
  const transitions = new Map();
  function register(name, callback) {
    context.subscriptions.push(vscode.commands.registerCommand('fixture.webview.' + name, callback));
  }
  function open(name, retainContextWhenHidden) {
    let panel = panels.get(name);
    if (panel) {
      panel.reveal();
      return panel;
    }
    panel = vscode.window.createWebviewPanel('fixture.' + name, 'Fixture ' + name,
      vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden });
    panels.set(name, panel);
    const log = [];
    transitions.set(name, log);
    panel.onDidChangeViewState(({ webviewPanel }) => {
      log.push([webviewPanel.visible, webviewPanel.active, webviewPanel.viewColumn]);
    });
    panel.onDidDispose(() => {
      log.push('disposed');
      panels.delete(name);
    });
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'panel.js'));
    panel.webview.html = `<!doctype html>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}">
      <button data-vscode-context='{"webviewSection":"counter"}'>Count</button>
      <output id="count">0</output>
      <output id="output"></output>
      <script src="${script}"></script>`;
    for (let value = 0; value < 100; value++) {
      void panel.webview.postMessage({ value });
    }
    return panel;
  }

  register('retained', () => { open('retained', true); });
  register('transient', () => { open('transient', false); });
  register('reveal', () => { panels.get('retained')?.reveal(vscode.ViewColumn.Two); });
  register('probe', async () => {
    const transient = panels.get('transient');
    const delivered = await transient?.webview.postMessage({ value: 'test' });
    await panels.get('retained')?.webview.postMessage({
      text: JSON.stringify({ delivered, transient: transitions.get('transient'), retained: transitions.get('retained') }),
    });
  });
  register('dispose', () => {
    const transient = panels.get('transient');
    transient?.dispose();
    transient?.dispose();
  });
  register('context', () => panels.get('retained')?.webview.postMessage({ text: 'Context action ran' }));
  register('active', () => panels.get('retained')?.webview.postMessage({ text: 'Active action ran' }));
};
