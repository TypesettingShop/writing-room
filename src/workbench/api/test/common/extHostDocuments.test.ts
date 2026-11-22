// @vitest-environment node
import type * as vscode from 'vscode';
import { expect, test, vi } from 'vitest';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ExtHostDocumentData } from '../../common/extHostDocumentData.js';
import { ExtHostDocuments, TextDocumentSaveReason } from '../../common/extHostDocuments.js';
import { ExtHostDiagnostics, Diagnostic, DiagnosticSeverity } from '../../common/extHostDiagnostics.js';
import { ExtHostDocumentSaveParticipant } from '../../common/extHostDocumentSaveParticipant.js';
import { ExtHostTextEditor } from '../../common/extHostTextEditor.js';
import { ExtHostTextEditors } from '../../common/extHostTextEditors.js';
import type { ExtHostTextEditorDecorations } from '../../common/extHostTextEditorDecorations.js';
import { ExtHostDocumentsProxy, MainThreadDocumentsProxy } from '../../common/extHost.protocol.documents.js';
import type { MainThreadDocumentsShape, MainThreadEditorsShape } from '../../common/extHost.protocol.documents.js';
import { EndOfLine, Position, Range, Selection, SnippetString, TextEdit } from '../../common/extHostTypes.js';
import type { IModelContentChangedEvent } from '../../../../editor/common/model.js';
import { createTestExtensionApi } from './testExtensionHost.js';

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

const markdownlintExtension = {
  id: 'DavidAnson.vscode-markdownlint', key: 'lint', location: '', entry: '', activationEvents: [],
  manifest: { publisher: 'DavidAnson', name: 'vscode-markdownlint', version: '0.62.1' },
};

test('markdownlint aliases share one live manuscript and route diagnostics only for the supported extension', async () => {
  const proxy = {
    $openDocument: vi.fn(async () => 'model'),
    $saveDocument: vi.fn(async () => true),
  };
  let visibleDocuments: readonly vscode.TextDocument[] = [];
  const documents = new ExtHostDocuments(proxy as unknown as MainThreadDocumentsShape, () => true, () => visibleDocuments);
  const editors = new ExtHostTextEditors({} as MainThreadEditorsShape, documents, {} as ExtHostTextEditorDecorations);
  const $changeMany = vi.fn(async () => {});
  const diagnostics = new ExtHostDiagnostics({ $changeMany, $clear: async () => {}, $requestMarkers: async () => {} });
  try {
    const extension = markdownlintExtension;
    documents.associateExtension(extension);
    documents.associateExtension({ ...extension, key: 'new', manifest: { ...extension.manifest, version: '0.63.0' } });
    documents.associateExtension({ ...extension, key: 'other', id: 'fixture.lint' });
    const uri = URI.parse('manuscript://work-a/node.md');
    const second = URI.parse('manuscript://work-b/node.md');
    const snapshot = { lines: ['##Heading'], eol: '\n', version: 1, language: 'markdown', dirty: false };
    await documents.$acceptDocumentDelta({ added: [{ id: 'model', uri, ...snapshot }] });
    const seen = documents.events('lint', extension.id);
    const otherOpened = vi.fn();
    documents.events('other', 'fixture.lint').onDidOpenTextDocument(otherOpened);
    const opened = vi.fn();
    const changed = vi.fn();
    const saved = vi.fn();
    const closed = vi.fn();
    seen.onDidOpenTextDocument(opened);
    seen.onDidChangeTextDocument(changed);
    seen.onDidSaveTextDocument(saved);
    seen.onDidCloseTextDocument(closed);
    const editorApi = editors.createApi('lint');
    expect(editorApi.visibleTextEditors).toEqual([]);
    expect(editorApi.visibleTextEditors).toEqual([]);
    await Promise.resolve();
    expect(opened).not.toHaveBeenCalled();

    const collection = diagnostics.createDiagnosticCollection('lint', 'markdownlint', extension.id,
      resource => documents.documentResource('lint', resource), () => documents.refreshMarkdownlintDocuments('lint'));
    collection.clear();
    collection.clear();
    await Promise.resolve();
    expect(otherOpened).not.toHaveBeenCalled();
    await documents.$acceptDocumentDelta({ added: [{ id: 'second', uri: second, ...snapshot }] });

    const canonical = documents.get('model')!;
    const [doc, another] = documents.allFor('lint');
    expect(doc.uri.scheme).toBe('gist');
    expect(another.uri.toString()).not.toBe(doc.uri.toString());
    expect(opened.mock.calls.map(([document]) => document)).toEqual([doc, another]);
    expect(otherOpened).toHaveBeenCalledExactlyOnceWith(documents.get('second'));
    visibleDocuments = [canonical];
    documents.refreshMarkdownlintDocuments('other');
    collection.clear();
    await Promise.resolve();
    expect(opened.mock.calls.map(([document]) => document)).toEqual([doc, another, another]);
    expect(doc.getText()).toBe('##Heading');
    expect(doc.isUntitled).toBe(false);
    expect(documents.allFor('new')[0]).toBe(canonical);
    expect(documents.allFor('other')[0]).toBe(canonical);
    expect(documents.documentResource('lint', doc.uri)).toBe(uri);
    expect(documents.documentResource('other', doc.uri)).toBe(doc.uri);
    const copied = URI.parse(doc.uri.toString());
    expect(documents.documentResource('lint', copied)).toBe(copied);

    const warning = new Diagnostic(new Range(0, 0, 0, 2), 'MD018', DiagnosticSeverity.Warning);
    collection.set(doc.uri, [warning]);
    expect($changeMany).toHaveBeenLastCalledWith('lint', 'markdownlint', [[uri, expect.any(Array)]]);
    expect(diagnostics.getDiagnostics(uri)).toEqual([warning]);
    expect(collection.get(doc.uri)).toEqual([warning]);

    await documents.$acceptDocumentChanges('model', {
      versionId: 2, changes: [{ range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 },
        rangeOffset: 2, rangeLength: 0, text: ' ' }],
      eol: '\n', isFlush: false, isUndoing: false, isRedoing: false,
    }, true);
    expect(changed.mock.lastCall?.[0].document).toBe(doc);
    expect(doc.getText()).toBe('## Heading');
    expect(doc.version).toBe(2);
    expect(doc.isDirty).toBe(true);
    await expect(documents.open('lint', doc.uri)).resolves.toBe(doc);
    expect(proxy.$openDocument).toHaveBeenCalledWith('lint', uri);
    await expect(doc.save()).resolves.toBe(true);
    expect(proxy.$saveDocument).toHaveBeenCalledWith('model');
    await documents.$acceptDocumentSaved('model');
    expect(saved).toHaveBeenCalledWith(doc);

    await documents.$acceptDocumentDelta({ removed: ['model'] });
    expect(closed).toHaveBeenCalledWith(doc);
    expect(doc.isClosed).toBe(true);
    expect(documents.getId('lint', doc)).toBeUndefined();
    collection.delete(doc.uri);
    expect($changeMany).toHaveBeenLastCalledWith('lint', 'markdownlint', [[uri, undefined]]);
  } finally {
    diagnostics.dispose();
    editors.dispose();
    documents.dispose();
  }
});

test('reassociation disposes the previous markdownlint refresh and removes its alias scope', async () => {
  const documents = new ExtHostDocuments({} as MainThreadDocumentsShape, () => true);
  try {
    const extension = markdownlintExtension;
    documents.associateExtension(extension);
    await documents.$acceptDocumentDelta({ added: [{
      id: 'model', uri: URI.parse('manuscript://work/node.md'), lines: ['heading'],
      eol: '\n', version: 1, language: 'markdown', dirty: false,
    }] });
    const open = vi.fn();
    documents.events(extension.key, extension.id).onDidOpenTextDocument(open);
    expect(documents.allFor(extension.key)[0].uri.scheme).toBe('gist');
    documents.refreshMarkdownlintDocuments(extension.key);

    documents.associateExtension({ ...extension, manifest: { ...extension.manifest, version: '0.63.0' } });
    await Promise.resolve();

    expect(open).not.toHaveBeenCalled();
    expect(documents.allFor(extension.key)[0]).toBe(documents.get('model'));
  } finally {
    documents.dispose();
  }
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

test('the assembled API gives a save listener the public id for its warning and the generation key for its edits', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const $applySaveEdits = vi.fn(async () => true);
  let host: Awaited<ReturnType<typeof createTestExtensionApi>> | undefined;
  try {
    // The test extension's generation key is '1' and its public id `test.api`.
    host = await createTestExtensionApi();
    host.main.set(MainThreadDocumentsProxy, { $applySaveEdits } as unknown as MainThreadDocumentsShape);
    const failure = new Error('fixture save failure');
    host.api.workspace.onWillSaveTextDocument(() => { throw failure; });
    host.api.workspace.onWillSaveTextDocument(event =>
      event.waitUntil(Promise.resolve([TextEdit.insert(new Position(0, 0), 'new ')])));
    const documents = host.main.getProxy(ExtHostDocumentsProxy);
    await documents.$acceptDocumentDelta({ added: [{
      id: 'model', uri: URI.parse('untitled:Untitled-1'), lines: ['text'], eol: '\n', version: 1, language: 'plaintext', dirty: false,
    }] });
    await documents.$participateInSave('model', 5, Date.now() + 1500, TextDocumentSaveReason.Manual, CancellationToken.None);

    expect(warn).toHaveBeenCalledExactlyOnceWith('[test.api] Save participant failed:', failure);
    expect($applySaveEdits).toHaveBeenCalledExactlyOnceWith('1', 5, 1, expect.objectContaining({
      operations: [{ text: 'new ', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }],
    }));
  } finally {
    host?.dispose();
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
