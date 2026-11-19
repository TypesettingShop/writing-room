const vscode = require('vscode');

/** What the tests read back through "Fixture: Probe Custom Editor". */
const log = {
  activations: 0, closed: [], disposed: [], cancelled: [], lateResults: 0,
  documentsOpened: [], documentsDisposed: [], saves: 0, reverts: 0, undos: 0,
};
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

/** An editable custom document: a counter the Webview increments, with undo, redo, save and revert. */
function counterProvider(context) {
  const changed = new vscode.EventEmitter();
  const panels = new Map();
  let failNextSave = false;
  const show = document => {
    for (const panel of panels.get(document) ?? []) {
      void panel.webview.postMessage({ text: String(document.value) });
    }
  };
  return {
    onDidChangeCustomDocument: changed.event,
    openCustomDocument(uri) {
      log.documentsOpened.push(uri.path.split('/').pop());
      return { uri, value: 0, saved: 0, dispose() { log.documentsDisposed.push(uri.path.split('/').pop()); } };
    },
    resolveCustomEditor(document, panel) {
      panels.set(document, [...panels.get(document) ?? [], panel]);
      panel.onDidDispose(() => panels.set(document, panels.get(document).filter(other => other !== panel)));
      panel.webview.options = { enableScripts: true };
      const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'editor.js'));
      panel.webview.html = `<!doctype html>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}">
        <pre id="text">${document.value}</pre>
        <button id="append">Increment</button>
        <button id="fail">Fail Next Save</button>
        <input id="field" aria-label="Field">
        <script src="${script}"></script>`;
      panel.webview.onDidReceiveMessage(message => {
        if (message && message.type === 'append') {
          document.value++;
          show(document);
          changed.fire({
            document, label: 'Increment',
            undo: () => { log.undos++; document.value--; show(document); },
            redo: () => { document.value++; show(document); },
          });
        } else if (message && message.type === 'fail') {
          failNextSave = true;
        }
      });
    },
    async saveCustomDocument(document) {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('Fixture save failure');
      }
      log.saves++;
      document.saved = document.value;
    },
    async saveCustomDocumentAs() {
      log.saves++;
    },
    async revertCustomDocument(document) {
      log.reverts++;
      document.value = document.saved;
      show(document);
    },
    async backupCustomDocument() {
      throw new Error('Backups are not used.');
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
  subscriptions.push(vscode.window.registerCustomEditorProvider('fixture.binary', {
    openCustomDocument(uri) {
      const name = uri.path.split('/').pop();
      log.documentsOpened.push(name);
      return { uri, dispose: () => log.documentsDisposed.push(name) };
    },
    resolveCustomEditor(document, panel) {
      panel.webview.html = `<p id="binary">Binary ${escape(document.uri.path.split('/').pop())}</p>`;
    },
  }, { supportsMultipleEditorsPerDocument: true }));
  subscriptions.push(vscode.window.registerCustomEditorProvider('fixture.counter', counterProvider(context)));
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
