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
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { ITextFileService, ITextFileWillSaveEvent } from '../../../services/textfile/common/textfiles.js';
import type { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import { MainThreadDocuments } from '../../browser/mainThreadDocuments.js';
import type { ExtHostDocumentsShape } from '../../common/extHost.protocol.documents.js';

function model(id: string, initialLength: number, uri = URI.parse('untitled:' + id)) {
  const content = new Emitter<IModelContentChangedEvent>();
  const text = vi.fn(() => ['x'.repeat(initialLength)]);
  let version = 1;
  const push = vi.fn();
  const value = {
    id, uri, getValueLength: () => initialLength, getLinesContent: text,
    getEOL: () => '\n', getLanguageId: () => 'plaintext', getVersionId: () => version, onDidChangeContent: content.event,
    getLineContent: () => 'text', getLineCount: () => 1, getOffsetAt: ({ column }: { column: number }) => column - 1,
    pushStackElement: () => {}, pushEditOperations: push,
  } as unknown as ITextModel;
  return {
    value, content, text, push,
    setVersion(next: number) { version = next; },
  };
}

interface BridgeServices {
  readonly editors?: ICodeEditorService;
  readonly untitled?: IUntitledTextEditorService;
  readonly editorService?: IEditorService;
}

function bridge(models: ITextModel[], proxy: Partial<ExtHostDocumentsShape>, dirty = () => false, services: BridgeServices = {}) {
  const willSave = new Emitter<ITextFileWillSaveEvent>();
  const service = new MainThreadDocuments(proxy as ExtHostDocumentsShape, key => key === 'fixture'
    ? { id: 'fixture.extension', key, location: '', entry: '', manifest: { name: 'extension', publisher: 'fixture', version: '1.0.0', engines: { vscode: '*' } }, activationEvents: [] }
    : undefined,
  {
    getModels: () => models, onModelAdded: Event.None, onModelRemoved: Event.None, onModelLanguageChanged: Event.None,
    getModel: (uri: URI) => models.find(model => model.uri.toString() === uri.toString()) ?? null,
  } as unknown as IModelService,
  services.editors ?? {} as ICodeEditorService,
  {} as ITextModelService,
  { onDidChangeDirty: Event.None, onDidSave: Event.None, onWillSave: willSave.event, isDirty: dirty } as unknown as ITextFileService,
  {} as IFileService,
  {} as IWorkspaceContextService,
  services.untitled ?? {} as IUntitledTextEditorService,
  {} as ILanguageService,
  services.editorService ?? {} as IEditorService);
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

test('will-save edits keep to the write boundary of workspace edits', async () => {
  const settings = model('settings', 4, URI.parse('vscode-userdata:/User/settings.json'));
  const received = vi.fn(async () => {});
  const { service, willSave } = bridge([settings.value], {
    $acceptDocumentDelta: async () => {},
    $participateInSave: received,
  });
  try {
    await service.$startDocumentSync();
    const promises: Promise<unknown>[] = [];
    let applied: Promise<boolean> | undefined;
    received.mockImplementationOnce(async (...args: unknown[]) => {
      applied = service.$applySaveEdits('fixture', args[1] as number, 1, {
        operations: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '{}' }],
      });
      await applied;
    });
    willSave.fire({ resource: settings.value.uri as URI, reason: 'explicit', waitUntil: value => promises.push(value) });
    await Promise.all(promises);
    expect(received).toHaveBeenCalledOnce();
    expect(await applied).toBe(false);
    expect(settings.push).not.toHaveBeenCalled();
  } finally {
    service.dispose();
    willSave.dispose();
    settings.content.dispose();
  }
});

test('releasing an opened untitled document keeps it while a tab still shows it', async () => {
  for (const tabs of [[{}], []]) {
    const untitled = model('Untitled-1', 4);
    const dispose = vi.fn();
    const { service, willSave } = bridge([untitled.value], { $acceptDocumentDelta: async () => {} }, () => false, {
      editors: { listCodeEditors: () => [] } as unknown as ICodeEditorService,
      untitled: {
        create: () => ({ resource: untitled.value.uri, resolve: async () => {}, textEditorModel: untitled.value, dispose }),
      } as unknown as IUntitledTextEditorService,
      editorService: { findEditors: () => tabs } as unknown as IEditorService,
    });
    try {
      await service.$startDocumentSync();
      expect(await service.$openDocument('fixture', { content: 'text' })).toBe('Untitled-1');
      // A tab behind another in its group has no code editor, but disposing the model would close it.
      service.dispose();
      expect(dispose).toHaveBeenCalledTimes(tabs.length ? 0 : 1);
    } finally {
      willSave.dispose();
      untitled.content.dispose();
    }
  }
});
