// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ExtHostDocumentData } from '../../common/extHostDocumentData.js';
import { ExtHostDocumentSaveParticipant } from '../../common/extHostDocumentSaveParticipant.js';
import { ExtHostTextEditor } from '../../common/extHostTextEditor.js';
import type { ExtHostTextEditorDecorations } from '../../common/extHostTextEditorDecorations.js';
import type { MainThreadEditorsShape } from '../../common/extHost.protocol.documents.js';
import { EndOfLine, Position, Range, Selection, SnippetString, TextEdit } from '../../common/extHostTypes.js';
import type { IModelContentChangedEvent } from '../../../../editor/common/model.js';

function mirror(lines: string[], eol = '\n') {
  return new ExtHostDocumentData({
    id: 'model', uri: URI.parse('untitled:Untitled-1'), lines, eol, version: 1, language: 'plaintext', dirty: false,
  }, async () => false);
}

test('a mirror reads Monaco changes in their original order across replace, undo and EOL changes', () => {
  const data = mirror(['abc', 'def', 'ghi']);
  const change = (versionId: number, event: Partial<IModelContentChangedEvent>) => data.acceptChanges({
    versionId, changes: [], eol: '\n', isFlush: false, isRedoing: false, isUndoing: false, ...event,
  }, true);

  change(2, { changes: [
    { range: { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 3 }, rangeOffset: 9, rangeLength: 1, text: 'X\nY' },
    { range: { startLineNumber: 1, startColumn: 2, endLineNumber: 2, endColumn: 2 }, rangeOffset: 1, rangeLength: 4, text: '' },
  ] });
  expect(data.document.getText()).toBe('aef\ngX\nYi');
  expect(data.document.offsetAt(new Position(2, 1))).toBe(8);
  change(3, { eol: '\r\n' });
  expect(data.document.eol).toBe(EndOfLine.CRLF);
  expect(data.document.offsetAt(new Position(2, 1))).toBe(10);
  expect(data.document.positionAt(4)).toEqual(new Position(0, 3));

  change(4, { eol: '\r\n', isFlush: true, changes: [
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 3 }, rangeOffset: 0, rangeLength: 11, text: 'new\r\nfile' },
  ] });
  expect(data.document.getText()).toBe('new\r\nfile');
  expect(data.document.getText(new Range(1, 0, 1, 4))).toBe('file');
  expect(data.document.lineCount).toBe(2);
  expect(data.document.version).toBe(4);
});

test('the save listener budget expires and removes only the subscription that failed three times', async () => {
  vi.useFakeTimers();
  const participant = new ExtHostDocumentSaveParticipant();
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const data = mirror(['text']);
    const failing = vi.fn((event: { waitUntil(value: Promise<never>): void }) => event.waitUntil(new Promise(() => {})));
    participant.event('slow', 'test.slow')(failing);
    participant.event('healthy', 'test.healthy')(event => event.waitUntil(Promise.resolve([TextEdit.insert(new Position(0, 0), 'new ')])));
    const apply = vi.fn(async () => true);
    for (let i = 0; i < 4; i++) {
      const saving = participant.participate(data.document, 1, Date.now() + 1500, CancellationToken.None, apply);
      await vi.advanceTimersByTimeAsync(1500);
      await saving;
    }
    expect(failing).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenCalledExactlyOnceWith('healthy', 1, {
      operations: [{ text: 'new ', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }],
      eol: undefined,
    });
  } finally {
    participant.dispose();
    log.mockRestore();
    vi.useRealTimers();
  }
});

test('names a save listener failure by public id and applies the next listener’s edits under its generation key', async () => {
  const participant = new ExtHostDocumentSaveParticipant();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { document } = mirror(['text']);
    const failure = new Error('fixture save failure');
    participant.event('7', 'test.Public')(() => { throw failure; });
    participant.event('8', 'test.Writer')(event =>
      event.waitUntil(Promise.resolve([TextEdit.insert(new Position(0, 0), 'new ')])));
    const apply = vi.fn(async () => true);
    await participant.participate(document, 1, Date.now() + 1500, CancellationToken.None, apply);

    expect(warn).toHaveBeenCalledExactlyOnceWith('[test.Public] Save participant failed:', failure);
    expect(warn.mock.calls[0][0]).not.toContain('[7]');
    expect(apply).toHaveBeenCalledExactlyOnceWith('8', 1, {
      operations: [{ text: 'new ', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }],
      eol: undefined,
    });
  } finally {
    participant.dispose();
    warn.mockRestore();
  }
});

test('a text editor reads back what it set, rejects an overlapping edit and snippets at the selections', async () => {
  const data = mirror(['abc', 'def']);
  const proxy = {
    $setSelections: vi.fn(async () => {}),
    $setOptions: vi.fn(async () => {}),
    $applyEdits: vi.fn(async () => true),
    $insertSnippet: vi.fn(async () => true),
  };
  const properties = {
    selections: [{ selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 1, positionColumn: 1 }],
    visibleRanges: [], viewColumn: 1,
    options: { tabSize: 4, indentSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 },
  };
  const host = new ExtHostTextEditor('editor', proxy as unknown as MainThreadEditorsShape, data.document, properties,
    {} as ExtHostTextEditorDecorations);
  const editor = host.value;

  editor.selection = new Selection(1, 1, 1, 2);
  expect(editor.selection.isEqual(new Selection(1, 1, 1, 2))).toBe(true);
  editor.options.tabSize = 2;
  expect(editor.options.tabSize).toBe(2);
  editor.options = { tabSize: 'auto', cursorStyle: 2 };
  expect([editor.options.tabSize, editor.options.cursorStyle]).toEqual([2, 1]);

  let returned: Thenable<boolean> | undefined;
  expect(() => {
    returned = editor.edit(builder => {
      builder.delete(new Range(0, 0, 0, 2));
      builder.delete(new Range(0, 1, 0, 3));
    });
  }).not.toThrow();
  await expect(returned).rejects.toThrow('Overlapping ranges are not allowed!');
  expect(proxy.$applyEdits).not.toHaveBeenCalled();

  expect(await editor.insertSnippet(new SnippetString('x$0'), [])).toBe(true);
  expect(proxy.$insertSnippet).toHaveBeenCalledWith('editor', 1, 'x$0', undefined, {});

  host.close();
  await expect(editor.edit(() => {})).rejects.toThrow('closed editors');
  await expect(editor.insertSnippet(new SnippetString('x'))).rejects.toThrow('closed editors');
});
