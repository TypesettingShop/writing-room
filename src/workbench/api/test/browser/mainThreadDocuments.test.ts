import { expect, test, vi } from 'vitest';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import type { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type { ILanguageService } from '../../../../editor/common/languages/language.js';
import { MODEL_SYNC_LIMIT } from '../../../../editor/common/model.js';
import type { IModelContentChangedEvent, ITextModel } from '../../../../editor/common/model.js';
import type { IModelService } from '../../../../editor/common/services/model.js';
import type { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { ITextFileService, ITextFileWillSaveEvent } from '../../../services/textfile/common/textfiles.js';
import type { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import { MainThreadDocuments } from '../../browser/mainThreadDocuments.js';
import type { ExtHostDocumentsShape } from '../../common/extHost.protocol.documents.js';

function model(id: string, initialLength: number) {
  const content = new Emitter<IModelContentChangedEvent>();
  const text = vi.fn(() => ['x'.repeat(initialLength)]);
  let version = 1;
  const push = vi.fn();
  const value = {
    id, uri: URI.parse('untitled:' + id), getValueLength: () => initialLength, getLinesContent: text,
    getEOL: () => '\n', getLanguageId: () => 'plaintext', getVersionId: () => version, onDidChangeContent: content.event,
    getLineContent: () => 'text', getLineCount: () => 1, getOffsetAt: ({ column }: { column: number }) => column - 1,
    pushStackElement: () => {}, pushEditOperations: push,
  } as unknown as ITextModel;
  return {
    value, content, text, push,
    setVersion(next: number) { version = next; },
  };
}

function bridge(models: ITextModel[], proxy: Partial<ExtHostDocumentsShape>, dirty = () => false) {
  const willSave = new Emitter<ITextFileWillSaveEvent>();
  const service = new MainThreadDocuments(proxy as ExtHostDocumentsShape, key => key === 'fixture'
    ? { id: 'fixture.extension', key, location: '', entry: '', manifest: { name: 'extension', publisher: 'fixture', version: '1.0.0', engines: { vscode: '*' } }, activationEvents: [] }
    : undefined,
  {
    getModels: () => models, onModelAdded: Event.None, onModelRemoved: Event.None, onModelLanguageChanged: Event.None,
    getModel: (uri: URI) => models.find(model => model.uri.toString() === uri.toString()) ?? null,
  } as unknown as IModelService,
  {} as ICodeEditorService,
  {} as ITextModelService,
  { onDidChangeDirty: Event.None, onDidSave: Event.None, onWillSave: willSave.event, isDirty: dirty } as unknown as ITextFileService,
  {} as IFileService,
  {} as IWorkspaceContextService,
  {} as IUntitledTextEditorService,
  {} as ILanguageService);
  return { service, willSave };
}

test('sends only the small content delta for a large tracked buffer and never snapshots an oversized buffer', async () => {
  const ordinary = model('regular', 5 * 1024 * 1024);
  const oversized = model('too-large', MODEL_SYNC_LIMIT + 1);
  const added = vi.fn(async () => {});
  const changed = vi.fn(async () => {});
  let dirty = false;
  const { service, willSave } = bridge([ordinary.value, oversized.value], {
    $acceptDocumentDelta: added, $acceptDocumentChanges: changed,
  }, () => dirty);
  try {
    expect(added).not.toHaveBeenCalled();
    await service.$startDocumentSync();
    expect(added).toHaveBeenCalledTimes(1);
    expect(oversized.text).not.toHaveBeenCalled();
    const event = {
      changes: [{ range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 }, rangeOffset: 1, rangeLength: 0, text: 'y' }],
      eol: '\n', versionId: 2, isUndoing: false, isRedoing: false, isFlush: false,
    };
    ordinary.content.fire(event);
    dirty = true;
    await Promise.resolve();
    expect(changed).toHaveBeenCalledExactlyOnceWith('regular', event, true);
    expect(JSON.stringify(changed.mock.calls).length).toBeLessThan(500);
    expect(ordinary.text).toHaveBeenCalledTimes(1);
  } finally {
    service.dispose();
    willSave.dispose();
    ordinary.content.dispose();
    oversized.content.dispose();
  }
});

test('will-save edits require the pending save and a current document version', async () => {
  const tracked = model('save', 4);
  let continueSaving!: () => void;
  const received = vi.fn(() => new Promise<void>(resolve => { continueSaving = resolve; }));
  const { service, willSave } = bridge([tracked.value], {
    $acceptDocumentDelta: async () => {},
    $participateInSave: received,
  });
  try {
    await service.$startDocumentSync();
    const promises: Promise<unknown>[] = [];
    willSave.fire({ resource: tracked.value.uri as URI, reason: 'explicit', waitUntil: value => promises.push(value) });
    await Promise.resolve();
    const [, id] = received.mock.calls[0] as unknown as [string, number];
    const edit = {
      operations: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'prefix ' }],
    };
    tracked.setVersion(2);
    expect(await service.$applySaveEdits('fixture', id, 1, edit)).toBe(false);
    expect(tracked.push).not.toHaveBeenCalled();
    expect(await service.$applySaveEdits('fixture', id, 2, edit)).toBe(true);
    expect(tracked.push).toHaveBeenCalledOnce();
    continueSaving();
    await Promise.all(promises);
    expect(await service.$applySaveEdits('fixture', id, 2, edit)).toBe(false);
  } finally {
    service.dispose();
    willSave.dispose();
    tracked.content.dispose();
  }
});
