const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

exports.activate = context => {
  const vscode = require('vscode');
  const { workspace, window, Range, Position, EndOfLine, Uri, EventEmitter } = vscode;
  context.subscriptions.push(vscode.commands.registerCommand('documents.check', async () => {
    const opened = [];
    const onOpen = workspace.onDidOpenTextDocument(document => opened.push(document));
    const updates = new EventEmitter();
    let text = 'initial';
    const provider = workspace.registerTextDocumentContentProvider('fixture-document', {
      onDidChange: updates.event,
      provideTextDocumentContent: () => text,
    });
    try {
      const document = await workspace.openTextDocument({ language: 'plaintext', content: 'first\r\n  second' });
      assert(opened.includes(document), 'Expected didOpen before the open request resolved');
      assert((await workspace.openTextDocument(document.uri)) === document, 'Reopening must preserve document identity');
      assert(workspace.textDocuments.filter(candidate => candidate === document).length === 1, 'Expected one mirror');
      assert(document.isUntitled && document.isDirty && document.eol === EndOfLine.CRLF, 'Expected untitled, dirty CRLF document');
      assert(document.lineAt(0).rangeIncludingLineBreak.end.line === 1, 'Expected a complete first line range');
      assert(document.lineAt(1).firstNonWhitespaceCharacterIndex === 2, 'Expected line indentation');
      assert(document.getText(new Range(0, 3, 1, 4)) === 'st\r\n  se', 'Expected CRLF in range text');
      assert(document.positionAt(6).isEqual(new Position(0, 5)), 'Expected CRLF interior to map to end of line');
      assert(document.offsetAt(new Position(1, 2)) === 9, 'Expected UTF-16 offset including CRLF');
      const word = document.getWordRangeAtPosition(new Position(1, 3), /\w*/);
      assert(word?.isEqual(new Range(1, 2, 1, 8)), 'Expected fallback for an empty-match word definition');
      await vscode.languages.setTextDocumentLanguage(document, 'plaintext');
      assert(opened.filter(candidate => candidate === document).length === 1, 'Expected no event for unchanged language');

      const uri = Uri.parse('fixture-document:/sample');
      const virtual = await workspace.openTextDocument(uri);
      const change = new Promise(resolve => {
        const subscription = workspace.onDidChangeTextDocument(event => {
          if (event.document === virtual) {
            subscription.dispose();
            resolve(event);
          }
        });
      });
      text = 'updated\nsecond line';
      updates.fire(uri);
      const event = await change;
      assert(virtual.getText() === text && event.contentChanges.length === 1, 'Expected provider update in mirror');
      assert(!(await virtual.save()), 'Saving a virtual document must return false');
      await window.showInformationMessage('Document API verified');
    } finally {
      provider.dispose();
      updates.dispose();
      onOpen.dispose();
    }
  }));
};
