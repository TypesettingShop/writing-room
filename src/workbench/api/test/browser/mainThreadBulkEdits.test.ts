import { expect, test, vi } from 'vitest';
import { URI } from '../../../../base/common/uri.js';
import type { IPosition, ISingleEditOperation } from '../../../../editor/common/model.js';
import type { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { FileSystemProviderError, FileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { MainThreadBulkEdits } from '../../browser/mainThreadBulkEdits.js';
import type { MainThreadDocuments } from '../../browser/mainThreadDocuments.js';
import type { MainThreadEditors } from '../../browser/mainThreadEditors.js';
import type { WorkspaceEditOperation } from '../../common/extHost.protocol.documents.js';

const target = URI.parse('vscode-vfs://writing-room/workspace/target.txt');
const created = URI.parse('vscode-vfs://writing-room/workspace/created.txt');

function textModel(initial: string) {
  let value = initial;
  let version = 1;
  const lines = () => value.split('\n');
  const offset = ({ lineNumber, column }: IPosition) =>
    lines().slice(0, lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + column - 1;
  return {
    get value() { return value; },
    getVersionId: () => version,
    isDisposed: () => false,
    getLineCount: () => lines().length,
    getLineContent: (line: number) => lines()[line - 1],
    getOffsetAt: offset,
    pushStackElement: () => {},
    pushEOL: () => {},
    pushEditOperations: (_selections: null, operations: ISingleEditOperation[]) => {
      const changes = operations.map(({ range, text }) => ({
        start: offset({ lineNumber: range.startLineNumber, column: range.startColumn }),
        end: offset({ lineNumber: range.endLineNumber, column: range.endColumn }),
        text: text ?? '',
      })).sort((a, b) => b.start - a.start);
      for (const change of changes) {
        value = value.slice(0, change.start) + change.text + value.slice(change.end);
      }
      version++;
      return null;
    },
  };
}

function bulkEdits(model: ReturnType<typeof textModel>, dirty: boolean) {
  const save = vi.fn(async () => true);
  const createFile = vi.fn(async () => ({ etag: 'created' }));
  const service = new MainThreadBulkEdits(
    { authorizeResource: (_extension: string, uri: URI) => uri, isReadOnly: () => false } as unknown as MainThreadDocuments,
    { active: undefined } as unknown as MainThreadEditors,
    { createModelReference: async () => ({ object: { textEditorModel: model }, dispose: () => {} }) } as unknown as ITextModelService,
    { findEditors: () => [] } as unknown as IEditorService,
    {
      activateProvider: async () => {},
      getProvider: () => ({ capabilities: 0 }),
      stat: async () => { throw new FileSystemProviderError('missing', FileSystemProviderErrorCode.FileNotFound); },
      createFile,
    } as unknown as IFileService,
    { isDirty: () => dirty, save } as unknown as ITextFileService,
  );
  return { service, save, createFile };
}

function insert(line: number, column: number, text: string, version?: number): WorkspaceEditOperation {
  return {
    kind: 'text', uri: target, version,
    edit: { operations: [{ range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column }, text }] },
  };
}

test('a text group after a file operation applies to the text the earlier group left', async () => {
  const replaced: WorkspaceEditOperation = {
    kind: 'text', uri: target,
    edit: { operations: [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }, text: 'XYZ' }] },
  };
  const unversioned = textModel('abc');
  const { service } = bulkEdits(unversioned, false);
  expect(await service.$applyWorkspaceEdit('fixture', [insert(1, 1, 'line0\n'), { kind: 'create', uri: created }, replaced])).toBe(true);
  expect(unversioned.value).toBe('line0\nXYZ');

  // The extension host's version names the text before the edit, which the earlier group has changed.
  const versioned = textModel('abc');
  const { service: second, createFile } = bulkEdits(versioned, false);
  expect(await second.$applyWorkspaceEdit('fixture', [insert(1, 1, 'line0\n', 1), { kind: 'create', uri: created }, { ...replaced, version: 1 }])).toBe(false);
  expect([versioned.value, createFile.mock.calls.length]).toEqual(['abc', 0]);
});

test('a workspace edit saves a hidden document only when it had no unsaved changes before', async () => {
  const clean = bulkEdits(textModel('abc'), false);
  expect(await clean.service.$applyWorkspaceEdit('fixture', [insert(1, 1, 'x')])).toBe(true);
  expect(clean.save).toHaveBeenCalledExactlyOnceWith(target);

  const dirty = bulkEdits(textModel('abc'), true);
  expect(await dirty.service.$applyWorkspaceEdit('fixture', [insert(1, 1, 'x')])).toBe(true);
  expect(dirty.save).not.toHaveBeenCalled();
});
