// @vitest-environment node
import { expect, test } from 'vitest';
import type * as vscode from 'vscode';
import { URI } from '../../../../base/common/uri.js';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { createProxyIdentifier } from '../../../services/extensions/common/proxyIdentifier.js';
import {
  CodeActionKind, DataTransfer, DataTransferItem, EndOfLine, Location, MarkdownString, Position, Range, RelativePattern,
  Selection, SnippetString, SnippetTextEdit, TextEdit, ThemeColor, ThemeIcon, Uri, WorkspaceEdit,
} from '../../common/extHostTypes.js';
import {
  positionFromEditor, positionToEditor, rangeFromEditor, rangeToEditor, selectionFromEditor, selectionToEditor,
  textEditFromEditor, textEditToEditor, workspaceEditToDto,
} from '../../common/extHostTypeConverters.js';

test('uses zero-based positions and orders ranges without losing selection direction', () => {
  const end = new Position(3, 18);
  const start = new Position(1, 2);
  expect(end.translate({ lineDelta: -2, characterDelta: -16 })).toEqual(start);
  expect(start.with({})).toBe(start);
  expect(() => start.translate(-2)).toThrow('line must be non-negative');
  expect(() => new Position(0, -1)).toThrow('character must be non-negative');
  const range = new Range(end, start);
  expect(range.start).toBe(start);
  expect(range.end).toBe(end);
  expect(range.contains(new Position(2, 0))).toBe(true);
  expect(range.intersection(new Range(1, 0, 1, 1))).toBeUndefined();
  expect(range.intersection(new Range(3, 18, 3, 20))?.isEmpty).toBe(true);
  expect(range.union(new Range(1, 0, 1, 10))).toEqual(new Range(1, 0, 3, 18));
  const selection = new Selection(end, start);
  expect(selection.isReversed).toBe(true);
  expect(selection.anchor).toBe(end);
  expect(selection.active).toBe(start);
  expect(new Selection(start, end).isReversed).toBe(false);
  expect(new Selection(2, 0, 2, 0).isReversed).toBe(true);
  expect(new Location(Uri.parse('file:/code'), start).range).toEqual(new Range(start, start));
});

test('round trips selections, line ends, ranges over lines and end-of-line edits', () => {
  const end = new Position(4, 12);
  expect(positionToEditor(end)).toEqual({ lineNumber: 5, column: 13 });
  expect(positionFromEditor(positionToEditor(end))).toEqual(end);
  for (const range of [new Range(end, end), new Range(4, 12, 5, 0)]) {
    expect(rangeFromEditor(rangeToEditor(range))).toEqual(range);
    expect(rangeToEditor(range)).toMatchObject({ startLineNumber: 5, startColumn: 13 });
  }
  const selection = new Selection(end, new Position(0, 0));
  expect(selectionFromEditor(selectionToEditor(selection))).toEqual(selection);
  for (const [source, expected] of [[EndOfLine.LF, 0], [EndOfLine.CRLF, 1]] as const) {
    const edit = TextEdit.setEndOfLine(source);
    expect(textEditToEditor(edit).eol).toBe(expected);
    expect(textEditFromEditor(textEditToEditor(edit))).toEqual(edit);
  }
});

test('groups only text edits for entries while retaining ordered snippets and file operations for conversion', () => {
  const first = Uri.parse('file:/first');
  const same = Uri.parse('file:/first');
  const second = Uri.parse('file:/second');
  const start = new Position(0, 0);
  const edit = new WorkspaceEdit();
  edit.createFile(first, { overwrite: true, contents: new Uint8Array([4]) });
  edit.insert(second, start, 'second');
  edit.insert(first, start, 'first');
  edit.set(same, [[SnippetTextEdit.insert(start, new SnippetString('$1')), { label: 'Snippet', needsConfirmation: true }]]);
  edit.renameFile(first, second);
  edit.set(same, [TextEdit.insert(start, 'last')]);
  edit.deleteFile(first);
  expect(edit.size).toBe(2);
  expect(edit.entries().map(([uri, entries]) => [uri.toString(), entries.map(entry => entry.newText)]))
    .toEqual([[second.toString(), ['second']], [first.toString(), ['first', 'last']]]);
  expect(edit.get(same).map(entry => entry.newText)).toEqual(['first', 'last']);
  const operations = workspaceEditToDto(edit);
  expect(operations.map(operation => operation.kind)).toEqual(['create', 'text', 'text', 'snippet', 'rename', 'text', 'delete']);
  expect(operations[3]).toMatchObject({
    edit: { snippet: '$1', range: { startLineNumber: 1, startColumn: 1 } },
    metadata: { label: 'Snippet', needsConfirmation: true },
  });
});

test('escapes snippet and Markdown literals and keeps nested tabstops ordered', () => {
  expect(new SnippetString().appendText('$}\\').value).toBe('\\$\\}\\\\');
  expect(new SnippetString().appendPlaceholder(nested => nested.appendTabstop()).appendTabstop().value)
    .toBe('$' + '{1:$2}$3');
  expect(new SnippetString().appendChoice(['a,b', 'c|d', '\\']).value).toBe('$' + '{1|a\\,b,c\\|d,\\\\|}');
  expect(new SnippetString().appendVariable('VAR', '$}\\').value).toBe('$' + '{VAR:\\$\\}\\}');
  expect(new MarkdownString().appendText('  - item >\n*x*').value).toBe('&nbsp;&nbsp;\\-&nbsp;item&nbsp;\\>\n\n\\*x\\*');
  const ticks = String.fromCharCode(96);
  const block = new MarkdownString().appendCodeblock(ticks.repeat(3), 'text').value;
  expect(block).toBe('\n' + ticks.repeat(4) + 'text\n' + ticks.repeat(3) + '\n' + ticks.repeat(4) + '\n');
});

test('keeps MIME names case insensitive and accepts existing resource identifiers in relative patterns', async () => {
  const transfer = new DataTransfer();
  const item = new DataTransferItem({ done: true });
  transfer.set('TeXt/PLAIN', item);
  expect(transfer.get('TEXT/plain')).toBe(item);
  expect([...transfer]).toEqual([['text/plain', item]]);
  expect(await item.asString()).toBe('{"done":true}');
  expect(item.asFile()).toBeUndefined();
  const root = Uri.parse('vscode-vfs://writing-room/workspace');
  expect(new RelativePattern({ uri: root, name: 'Root', index: 0 }, '*.ts').baseUri).toBe(root);
  expect(new RelativePattern(root, '*.ts').pattern).toBe('*.ts');
  const color = new ThemeColor('editor.foreground');
  expect(new ThemeIcon('search', color).color).toBe(color);
  expect(ThemeIcon.Folder.id).toBe('folder');
});

test('keeps all initialized items per MIME type and replaces them together', () => {
  const text = new DataTransferItem('text');
  const first = new DataTransferItem('first');
  const second = new DataTransferItem('second');
  const replacement = new DataTransferItem('replacement');
  const transfer = new DataTransfer([
    ['Image/PNG', first],
    ['text/plain', text],
    ['image/png', second],
  ]);

  expect(transfer.get('IMAGE/png')).toBe(first);
  expect(transfer.get('image/jpeg')).toBeUndefined();
  expect([...transfer]).toEqual([['image/png', first], ['image/png', second], ['text/plain', text]]);
  const visited: [string, vscode.DataTransferItem][] = [];
  const context = { visited };
  transfer.forEach(function (this: typeof context, item, mime, owner) {
    expect(owner).toBe(transfer);
    this.visited.push([mime, item]);
  }, context);
  expect(visited).toEqual([...transfer]);

  transfer.set('IMAGE/PNG', replacement);
  expect(transfer.get('image/png')).toBe(replacement);
  expect([...transfer]).toEqual([['image/png', replacement], ['text/plain', text]]);
});

test('preserves the public Uri class across the RPC structured-clone boundary', async () => {
  expect(Uri).toBe(URI);
  const { port1, port2 } = new MessageChannel();
  const first = new RPCProtocol(port1);
  const second = new RPCProtocol(port2);
  const echo = createProxyIdentifier<{ $echo(value: vscode.Uri): Promise<vscode.Uri> }>('UriEcho');
  second.set(echo, { async $echo(value) {
    expect(value).toBeInstanceOf(Uri);
    return value;
  } });
  try {
    const sent = Uri.parse('vscode-vfs://writing-room/workspace/item');
    const returned = await first.getProxy(echo).$echo(sent);
    expect(returned).toBeInstanceOf(Uri);
    expect(returned).not.toBe(sent);
    expect(returned.toString()).toBe(sent.toString());
  } finally {
    first.dispose();
    second.dispose();
  }
});

test('uses the pinned code action kind values and matches complete path segments', () => {
  const kind = CodeActionKind;
  expect([
    kind.Empty.value, kind.QuickFix.value, kind.Refactor.value, kind.RefactorExtract.value,
    kind.RefactorInline.value, kind.RefactorMove.value, kind.RefactorRewrite.value,
    kind.Source.value, kind.SourceOrganizeImports.value, kind.SourceFixAll.value, kind.Notebook.value,
  ]).toEqual([
    '', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.move', 'refactor.rewrite',
    'source', 'source.organizeImports', 'source.fixAll', 'notebook',
  ]);
  expect(kind.Empty.append('quickfix').value).toBe(kind.QuickFix.value);
  expect(kind.Empty.contains(kind.QuickFix)).toBe(false);
  expect(kind.RefactorExtract.contains(kind.RefactorExtract)).toBe(true);
  expect(kind.RefactorExtract.contains(kind.RefactorExtract.append('function'))).toBe(true);
  expect(kind.RefactorExtract.contains(kind.Refactor)).toBe(false);
  expect(kind.RefactorExtract.intersects(kind.Refactor)).toBe(true);
  expect(kind.Refactor.intersects(kind.RefactorExtract)).toBe(true);
  expect(kind.RefactorExtract.intersects(kind.RefactorInline)).toBe(false);
  expect(kind.RefactorExtract.contains(kind.Refactor.append('extraction'))).toBe(false);
});

test('keeps the relative pattern base and URI across an RPC call', async () => {
  const channel = new MessageChannel();
  const caller = new RPCProtocol(channel.port1);
  const callee = new RPCProtocol(channel.port2);
  const proxy = createProxyIdentifier<{ $echo(pattern: vscode.RelativePattern): Promise<vscode.RelativePattern> }>('pattern.echo');
  callee.set(proxy, { async $echo(pattern) { return pattern; } });
  try {
    const pattern = new RelativePattern('/workspace', '*.md');
    pattern.baseUri = Uri.parse('vscode-vfs://writing-room/workspace/docs');
    const received = await caller.getProxy(proxy).$echo(pattern);
    expect(received.base).toBe(pattern.base);
    expect(received.baseUri).toBeInstanceOf(Uri);
    expect(received.baseUri.toString()).toBe(pattern.baseUri.toString());
    expect(received.pattern).toBe('*.md');
  } finally {
    caller.dispose();
    callee.dispose();
  }
});
