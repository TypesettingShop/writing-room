// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ExtHostDocumentData } from '../../common/extHostDocumentData.js';
import { ExtHostDocumentSaveParticipant } from '../../common/extHostDocumentSaveParticipant.js';
import { EndOfLine, Position, Range, TextEdit } from '../../common/extHostTypes.js';
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
    participant.event('slow')(failing);
    participant.event('healthy')(event => event.waitUntil(Promise.resolve([TextEdit.insert(new Position(0, 0), 'new ')])));
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
