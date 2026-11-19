const vscode = require('vscode');

/** What the tests read back through "Fixture: Probe Custom Editor". */
const log = { activations: 0, closed: [], disposed: [], cancelled: [], lateResults: 0 };
let releaseSlow;

function escape(text) {
  return text.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function textEditorProvider(context, label) {
  return {
    resolveCustomTextEditor(document, panel) {
      const shared = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === document.uri.toString());
      panel.webview.options = { enableScripts: true };
      const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'editor.js'));
      panel.webview.html = `<!doctype html>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}">
        <h1>${label}</h1>
        <p id="shared">${shared === document ? 'shared document' : 'other document'}</p>
        <pre id="text">${escape(document.getText())}</pre>
        <button id="append">Append</button>
        <script src="${script}"></script>`;
      const changes = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === document) {
          void panel.webview.postMessage({ text: document.getText() });
        }
      });
      panel.webview.onDidReceiveMessage(message => {
        if (message && message.type === 'append') {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(document.uri, document.positionAt(document.getText().length), '!');
          void vscode.workspace.applyEdit(edit);
        }
      });
      panel.onDidDispose(() => {
        changes.dispose();
        log.disposed.push(document.uri.path.split('/').pop());
      });
    },
  };
}

exports.activate = function (context) {
  log.activations++;
  const subscriptions = context.subscriptions;
  subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => log.closed.push(document.uri.path.split('/').pop())));
  subscriptions.push(vscode.window.registerCustomEditorProvider('fixture.noteView', textEditorProvider(context, 'Note View')));
  subscriptions.push(vscode.window.registerCustomEditorProvider('fixture.mdPreview', textEditorProvider(context, 'Fixture Preview')));
  subscriptions.push(vscode.window.registerCustomEditorProvider('fixture.broken', {
    resolveCustomTextEditor() {
      throw new Error('Fixture failure');
    },
  }));
  subscriptions.push(vscode.window.registerCustomEditorProvider('fixture.slow', {
    async resolveCustomTextEditor(document, panel, token) {
      panel.onDidDispose(() => log.disposed.push(document.uri.path.split('/').pop()));
      panel.webview.html = '<p>Waiting for release</p>';
      await new Promise(resolve => { releaseSlow = resolve; });
      log.cancelled.push(token.isCancellationRequested);
      log.lateResults++;
      try {
        panel.webview.html = '<p>Late result</p>';
      } catch {
        // The panel of a closed editor is disposed.
      }
    },
  }));
  subscriptions.push(vscode.commands.registerCommand('fixture.customEditor.release', () => releaseSlow && releaseSlow()));
  subscriptions.push(vscode.commands.registerCommand('fixture.customEditor.openBeside', () => vscode.commands.executeCommand(
    'vscode.openWith', vscode.Uri.parse('vscode-vfs://writing-room/workspace/a.md'), 'fixture.mdPreview', vscode.ViewColumn.Beside)));
  subscriptions.push(vscode.commands.registerCommand('fixture.customEditor.probe', () => {
    const attempt = (viewType) => {
      try {
        vscode.window.registerCustomEditorProvider(viewType, { resolveCustomTextEditor() {} }).dispose();
        return 'registered';
      } catch {
        return 'refused';
      }
    };
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab && tab.input;
    const result = {
      ...log,
      activeTextEditor: vscode.window.activeTextEditor !== undefined,
      activeTab: input instanceof vscode.TabInputCustom ? 'custom ' + input.viewType : input ? 'other' : 'none',
      foreign: attempt('other.viewType'),
      second: attempt('fixture.noteView'),
    };
    void vscode.window.showInformationMessage('Probe ' + JSON.stringify(result));
  }));
};
