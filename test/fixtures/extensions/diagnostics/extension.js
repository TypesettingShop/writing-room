const vscode = require('vscode');

const document = vscode.Uri.parse('vscode-userdata:/User/settings.json');

function diagnostic(line, start, end, message, severity, code) {
  const item = new vscode.Diagnostic(new vscode.Range(line, start, line, end), message, severity);
  item.source = 'fixture';
  item.code = code;
  return item;
}

module.exports.activate = context => {
  // The same name as the other fixture's collection: each keeps its own markers.
  const collection = vscode.languages.createDiagnosticCollection('fixture');
  context.subscriptions.push(collection);
  context.subscriptions.push(vscode.commands.registerCommand('diagnosticsFixture.set', () => {
    collection.set(document, [
      diagnostic(1, 0, 6, 'Fixture warning', vscode.DiagnosticSeverity.Warning, 'FX2'),
      diagnostic(0, 0, 5, 'Fixture error', vscode.DiagnosticSeverity.Error,
        { value: 'FX1', target: vscode.Uri.parse('https://example.test/rules/fx1') }),
      diagnostic(2, 0, 4, 'Second fixture error', vscode.DiagnosticSeverity.Error, 'FX3'),
      diagnostic(3, 0, 4, 'Fixture note', vscode.DiagnosticSeverity.Information),
    ]);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('diagnosticsFixture.setMany', () => {
    const items = [];
    for (let line = 0; line < 10000; line++) {
      items.push(diagnostic(line, 0, 1, 'Many ' + line, line % 2 ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error));
    }
    // Ten resources of 1,000 each: 10,000 markers.
    collection.set(Array.from({ length: 10 }, (_, index) => [
      vscode.Uri.parse('untitled:Many-' + index), items.slice(index * 1000, (index + 1) * 1000),
    ]));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('diagnosticsFixture.clear', () => collection.clear()));
  context.subscriptions.push(vscode.commands.registerCommand('diagnosticsFixture.report', () => {
    const all = vscode.languages.getDiagnostics(document);
    return vscode.window.showInformationMessage('Fixture diagnostics: ' + all.map(item => item.message).sort().join(', '));
  }));
};
