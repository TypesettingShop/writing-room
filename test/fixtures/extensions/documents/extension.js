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

  context.subscriptions.push(vscode.commands.registerCommand('documents.checkEditor', async () => {
    const events = [];
    const subOpen = workspace.onDidOpenTextDocument(document => events.push(['open', document]));
    const subActive = window.onDidChangeActiveTextEditor(editor => events.push(['active', editor?.document]));
    try {
      const document = await workspace.openTextDocument({ content: 'abc\ndef\nghi' });
      const editor = await window.showTextDocument(document);
      assert(window.activeTextEditor === editor, 'Expected shown editor to be active');
      assert(events.findIndex(([kind, value]) => kind === 'open' && value === document)
        < events.findIndex(([kind, value]) => kind === 'active' && value === document), 'Document must open before editor activation');
      const side = await window.showTextDocument(document.uri, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
      });
      assert(side !== editor && side.document === document, 'Expected separate editors to share the document');
      assert(side.viewColumn === vscode.ViewColumn.Two && window.activeTextEditor === editor
        && window.visibleTextEditors.includes(side), 'Beside must preserve the active group');

      const selectionChanged = new Promise(resolve => {
        const subscription = window.onDidChangeTextEditorSelection(event => {
          if (event.textEditor === side) {
            subscription.dispose();
            resolve(event);
          }
        });
      });
      side.selections = [new vscode.Selection(1, 2, 1, 1), new vscode.Selection(1_000_000_000, 0, 1_000_000_000, 0)];
      const event = await selectionChanged;
      assert(event.selections[0].isReversed && event.selections[1].active.line === 2, 'Expected ordered, clamped selections');

      const edits = editor.edit(builder => {
        builder.replace(new Range(0, 0, 0, 1), 'A');
        builder.insert(new Position(2, 3), '!');
      });
      const staleEdit = editor.edit(builder => builder.insert(new Position(0, 0), 'stale'));
      assert((await edits) && !(await staleEdit), 'Expected a stale edit to be rejected as a whole');
      assert(document.getText() === 'Abc\ndef\nghi!', 'Expected both changes in the document mirror');
      let overlaps = false;
      try {
        await editor.edit(builder => {
          builder.delete(new Range(0, 0, 0, 2));
          builder.delete(new Range(0, 1, 0, 3));
        });
      } catch (error) {
        overlaps = error.message === 'Overlapping ranges are not allowed!';
      }
      assert(overlaps, 'Expected overlapping edit to throw');

      const snippet = new vscode.SnippetString(' \${1:snippet}$0');
      assert(await editor.insertSnippet(snippet, new Position(1, 3)), 'Expected snippet insertion');
      assert(document.getText() === 'Abc\ndef snippet\nghi!', 'Expected inserted snippet text');
      await window.showInformationMessage('Text Editor API verified');
    } finally {
      subOpen.dispose();
      subActive.dispose();
    }
  }));

  let decoration;
  context.subscriptions.push(vscode.commands.registerCommand('documents.checkBulk', async () => {
    const first = await workspace.openTextDocument({ content: 'text' });
    const second = await workspace.openTextDocument({ content: 'word' });
    const editor = await window.showTextDocument(first);
    const secondEditor = await window.showTextDocument(second, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });

    const stale = new vscode.WorkspaceEdit();
    stale.insert(first.uri, new Position(0, 0), 'unused ');
    stale.insert(second.uri, new Position(0, 0), 'unused ');
    const advance = secondEditor.edit(builder => builder.insert(new Position(0, 0), 'new '));
    const conflict = workspace.applyEdit(stale);
    assert(await advance && !(await conflict), 'Expected conflicting workspace edit to fail');
    assert(first.getText() === 'text' && second.getText() === 'new word', 'Conflicting edit must leave every target alone');

    const file = Uri.parse('vscode-vfs://writing-room/workspace/bulk-created.txt');
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(file);
    edit.insert(file, new Position(0, 0), 'file created by WorkspaceEdit');
    edit.set(second.uri, [vscode.SnippetTextEdit.insert(new Position(0, 0), new vscode.SnippetString('${1:prefix} $0'))]);
    edit.insert(first.uri, new Position(0, 4), '!');
    assert(await workspace.applyEdit(edit), 'Expected a mixed workspace edit to succeed');
    assert(first.getText() === 'text!' && second.getText() === 'prefix new word', 'Expected literal fallback for inactive snippet');

    decoration = window.createTextEditorDecorationType({
      color: '#010203', backgroundColor: '#ddeeff', after: { contentText: 'fixture hint' },
    });
    context.subscriptions.push(decoration);
    editor.setDecorations(decoration, [new Range(0, 0, 0, 4)]);
    await window.showInformationMessage('Workspace Edit API verified');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('documents.clearDecoration', () => decoration?.dispose()));
};
