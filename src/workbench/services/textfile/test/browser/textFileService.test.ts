import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { TestModelService, TestTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import {
  FileSystemProviderError, FileSystemProviderErrorCode, IFileService,
} from '../../../../../platform/files/common/files.js';
import type { IFileWriteOptions } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextService as IWorkspace } from '../../../../../platform/workspace/common/workspace.js';
import { TextModelResolverService } from '../../../textmodelResolver/common/textModelResolverService.js';
import { IUntitledTextEditorService, UntitledTextEditorService } from '../../../untitled/common/untitledTextEditorService.js';
import { BrowserTextFileService } from '../../browser/textFileService.js';
import { createBackupSessionId, hashResource, TextFileBackups } from '../../common/textFileBackup.js';
import type { IBackupLocks } from '../../common/textFileBackup.js';
import { BACKUP_DELAY } from '../../common/textFileEditorModel.js';
import type { TextFileEditorModel } from '../../common/textFileEditorModel.js';
import { ITextFileService, TEXT_FILE_SIZE_LIMIT, TextFileOperationError, TextFileOperationResult } from '../../common/textfiles.js';
import type { ITextFileSaveErrorHandler, TextFileConflictResolution } from '../../common/textfiles.js';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const text = (value: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(value);
const file = (path: string) => URI.from({ scheme: 'mem', path });

/** Monaco's alternative version id: undoing back to a text gives that text's version again. */
function withUndoVersions(model: TestTextModel): TestTextModel {
  const seen = new Map<string, number>([[model.getValue(), model.getVersionId()]]);
  model.onDidChangeContent(() => {
    if (!seen.has(model.getValue())) {
      seen.set(model.getValue(), model.getVersionId());
    }
  });
  return Object.assign(model, { getAlternativeVersionId: () => seen.get(model.getValue())! });
}

/** An in-memory provider whose writes can be held back. */
class GatedProvider extends InMemoryFileSystemProvider {
  gate: Promise<void> | undefined;
  writes: string[] = [];
  failWith: Error | undefined;

  override async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions) {
    const gate = this.gate;
    if (resource.scheme === 'mem') {
      this.writes.push(text(content));
    }
    await gate;
    if (this.failWith && resource.scheme === 'mem') {
      throw this.failWith;
    }
    return super.writeFile(resource, content, options);
  }
}

let disposables: DisposableStore;
let files: FileService;
let provider: GatedProvider;
let userData: InMemoryFileSystemProvider;
let models: TestModelService;
let conflicts: TextFileConflictResolution[];
let saveErrors: unknown[];

const workspace: IWorkspace = {
  _serviceBrand: undefined,
  onDidChangeWorkspaceFolders: Event.None,
  getWorkbenchState: () => 2,
  getWorkspace: () => ({ id: 'test-workspace', folders: [] }),
  getWorkspaceFolder: () => null,
};

function createService(): { service: BrowserTextFileService; resolver: TextModelResolverService } {
  const services = new ServiceCollection(
    [IFileService, files], [IModelService, models], [IWorkspaceContextService, workspace],
  );
  const instantiation = new InstantiationService(services);
  services.set(IUntitledTextEditorService, instantiation.createInstance(UntitledTextEditorService));
  const service = disposables.add(instantiation.createInstance(BrowserTextFileService));
  services.set(ITextFileService, service);
  const resolver = instantiation.createInstance(TextModelResolverService);
  services.set(ITextModelService, resolver);
  const handler: ITextFileSaveErrorHandler = {
    resolveConflict: async () => conflicts.shift() ?? 'cancel',
    onSaveError: error => saveErrors.push(error),
  };
  service.files.saveErrorHandler = handler;
  return { service, resolver };
}

async function resolve(service: BrowserTextFileService, path: string): Promise<{ model: TextFileEditorModel; textModel: ITextModel }> {
  const model = await service.files.resolve(file(path));
  return { model, textModel: model.textEditorModel! };
}

function append(model: ITextModel, value: string): void {
  const end = model.getPositionAt(model.getValueLength());
  model.applyEdits([{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: value }]);
}

async function readFile(path: string): Promise<string> {
  return text((await files.readFile(file(path))).value);
}

/** Lets pending promise chains (file service batching, checks) run out. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  disposables = new DisposableStore();
  files = disposables.add(new FileService());
  provider = disposables.add(new GatedProvider());
  userData = disposables.add(new InMemoryFileSystemProvider());
  files.registerProvider('mem', provider);
  files.registerProvider('vscode-userdata', userData);
  models = new TestModelService();
  const create = models.createModel.bind(models);
  models.createModel = async (...args) => withUndoVersions(await create(...args));
  conflicts = [];
  saveErrors = [];
});

afterEach(() => {
  disposables.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('text file models', () => {
  test('dirty follows the saved version: undo back to the saved text is clean again', async () => {
    await files.writeFile(file('/a.txt'), bytes('saved'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/a.txt');
    expect(model.isDirty()).toBe(false);

    append(textModel, '!');
    expect(model.isDirty()).toBe(true);
    expect(service.isDirty(file('/a.txt'))).toBe(true);
    textModel.setValue('saved');
    expect(model.isDirty()).toBe(false);
  });

  test('a save writes the text against the etag it read, then is clean and fires its events in order', async () => {
    await files.writeFile(file('/a.txt'), bytes('one'));
    const { service } = createService();
    const events: string[] = [];
    service.onWillSave(({ resource }) => events.push('will ' + resource.path));
    service.onDidSave(({ resource }) => events.push('did ' + resource.path));
    service.onDidChangeDirty(resource => events.push('dirty ' + resource.path));
    const { textModel } = await resolve(service, '/a.txt');
    append(textModel, ' two');

    expect(await service.save(file('/a.txt'))).toEqual(file('/a.txt'));
    expect(await readFile('/a.txt')).toBe('one two');
    expect(events).toEqual(['dirty /a.txt', 'will /a.txt', 'dirty /a.txt', 'did /a.txt']);
    expect(service.isDirty(file('/a.txt'))).toBe(false);
  });

  test('a participant’s edit is in the saved bytes', async () => {
    await files.writeFile(file('/a.txt'), bytes('body'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/a.txt');
    service.onWillSave(event => event.waitUntil(Promise.resolve().then(() => append(textModel, '\nfooter'))));
    append(textModel, '!');

    expect(await model.save()).toBe(true);
    expect(await readFile('/a.txt')).toBe('body!\nfooter');
    expect(model.isDirty()).toBe(false);
  });

  test('saves of one model go one at a time and the waiting ones merge into the newest text', async () => {
    await files.writeFile(file('/a.txt'), bytes(''));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/a.txt');
    const gate = new DeferredPromise<void>();
    provider.gate = gate.p;
    provider.writes = [];

    append(textModel, 'A');
    const first = model.save();
    await settle();
    append(textModel, 'B');
    const second = model.save();
    append(textModel, 'C');
    const third = model.save();
    expect(third).toBe(second);
    // Only the running save has written yet.
    expect(provider.writes).toEqual(['A']);

    provider.gate = undefined;
    await gate.complete();
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(provider.writes).toEqual(['A', 'ABC']);
    expect(await readFile('/a.txt')).toBe('ABC');
    expect(model.isDirty()).toBe(false);
  });

  test('what is typed while a save runs stays unsaved, and undoing it is clean', async () => {
    await files.writeFile(file('/a.txt'), bytes('x'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/a.txt');
    const gate = new DeferredPromise<void>();
    provider.gate = gate.p;

    append(textModel, 'y');
    const saving = model.save();
    await settle();
    expect(model.isSaving()).toBe(true);
    append(textModel, 'z');
    provider.gate = undefined;
    await gate.complete();
    expect(await saving).toBe(true);

    expect(await readFile('/a.txt')).toBe('xy');
    expect(model.isDirty()).toBe(true);
    textModel.setValue('xy');
    expect(model.isDirty()).toBe(false);
  });

  test('compares exact saved text across rich versions and skips reading text of a different length', async () => {
    const original = 'Paragraph\n\n'.repeat(100);
    await files.writeFile(file('/rich.md'), bytes(original));
    // Model each rich undo as a fresh version, as when it writes a new edit into Monaco.
    models = new TestModelService();
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/rich.md');
    const getValue = vi.spyOn(textModel, 'getValue');
    const replaceHead = (endColumn: number, text: string) => model.applyRichEditorEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn },
      text,
    });
    const dirtyChanges: boolean[] = [];
    model.onDidChangeDirty(() => dirtyChanges.push(model.isDirty()));

    replaceHead(1, '!');
    expect(model.isDirty()).toBe(true);
    expect(getValue).not.toHaveBeenCalled();

    const gate = new DeferredPromise<void>();
    provider.gate = gate.p;
    const saving = model.save();
    await settle();
    expect(model.isSaving()).toBe(true);
    replaceHead(2, '?');
    provider.gate = undefined;
    await gate.complete();
    expect(await saving).toBe(true);
    expect(await readFile('/rich.md')).toBe('!' + original);
    expect(model.isDirty()).toBe(true);

    replaceHead(2, '!');
    expect(model.isDirty()).toBe(false);
    expect(dirtyChanges).toEqual([true, false]);
  });

  test('asks before overwriting a file another writer saved first, and keeps both sides until answered', async () => {
    await files.writeFile(file('/a.txt'), bytes('base'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/a.txt');
    append(textModel, ' mine');
    // Another tab saves first; the change event reaches the dirty model, which keeps its text.
    await files.writeFile(file('/a.txt'), bytes('theirs'));
    await settle();
    expect(textModel.getValue()).toBe('base mine');

    const resolveConflict = vi.spyOn(service.files.saveErrorHandler, 'resolveConflict');
    conflicts.push('cancel');
    expect(await model.save()).toBe(false);
    expect(resolveConflict).toHaveBeenCalledTimes(1);
    expect(await readFile('/a.txt')).toBe('theirs');
    expect(model.isDirty()).toBe(true);

    conflicts.push('overwrite');
    expect(await model.save()).toBe(true);
    expect(await readFile('/a.txt')).toBe('base mine');
    expect(model.isDirty()).toBe(false);
  });

  test('“Revert” in a conflict takes the newer file’s text', async () => {
    await files.writeFile(file('/a.txt'), bytes('base'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/a.txt');
    append(textModel, ' mine');
    await files.writeFile(file('/a.txt'), bytes('theirs'));
    conflicts.push('revert');

    expect(await model.save()).toBe(false);
    expect(textModel.getValue()).toBe('theirs');
    expect(model.isDirty()).toBe(false);
    expect(await readFile('/a.txt')).toBe('theirs');
  });

  test('an outside change reads into a clean model and leaves a dirty model’s text alone', async () => {
    await files.writeFile(file('/clean.txt'), bytes('line 1\nline 2'));
    await files.writeFile(file('/dirty.txt'), bytes('draft'));
    const { service } = createService();
    const clean = await resolve(service, '/clean.txt');
    const dirty = await resolve(service, '/dirty.txt');
    append(dirty.textModel, ' typed');

    await files.writeFile(file('/clean.txt'), bytes('line 1\nline 2 changed'));
    await files.writeFile(file('/dirty.txt'), bytes('outside'));
    await vi.waitFor(() => expect(clean.textModel.getValue()).toBe('line 1\nline 2 changed'));
    expect(clean.model.isDirty()).toBe(false);
    await settle();
    expect(dirty.textModel.getValue()).toBe('draft typed');
    expect(dirty.model.isDirty()).toBe(true);
  });

  test('text typed while an outside change is read stays, dirty', async () => {
    await files.writeFile(file('/typing.txt'), bytes('before'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/typing.txt');
    const read = new DeferredPromise<void>();
    const readFileOf = provider.readFileWithStat.bind(provider);
    let held = false;
    provider.readFileWithStat = async (resource, options) => {
      const content = await readFileOf(resource, options);
      if (!held && resource.path === '/typing.txt') {
        held = true;
        await read.p;
      }
      return content;
    };

    await files.writeFile(file('/typing.txt'), bytes('outside'));
    await vi.waitFor(() => expect(held).toBe(true));
    append(textModel, ' typed');
    read.complete();
    await settle();
    await settle();

    expect(textModel.getValue()).toBe('before typed');
    expect(model.isDirty()).toBe(true);
  });

  test('a file deleted while open keeps its text, orphaned, and a save writes it again', async () => {
    await files.writeFile(file('/gone.txt'), bytes('keep me'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/gone.txt');
    const orphaned = Event.toPromise(service.files.onDidChangeOrphaned);

    await files.del(file('/gone.txt'));
    await orphaned;
    expect(model.isOrphaned()).toBe(true);
    expect(textModel.isDisposed()).toBe(false);
    expect(textModel.getValue()).toBe('keep me');

    expect(await model.save()).toBe(true);
    expect(await readFile('/gone.txt')).toBe('keep me');
    expect(model.isOrphaned()).toBe(false);
  });

  test('a failed save, such as a full storage, keeps the text dirty and reports the error', async () => {
    await files.writeFile(file('/a.txt'), bytes('a'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/a.txt');
    append(textModel, 'b');
    const quota = new FileSystemProviderError('File storage quota exceeded', FileSystemProviderErrorCode.FileExceedsStorageQuota);
    provider.failWith = quota;

    expect(await service.save(file('/a.txt'))).toBeUndefined();
    expect(model.isDirty()).toBe(true);
    expect(saveErrors).toEqual([quota]);
    expect(await readFile('/a.txt')).toBe('a');
  });

  test('keeps a UTF-8 BOM out of the text and puts it back on save', async () => {
    await files.writeFile(file('/bom.txt'), new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('text')]));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/bom.txt');
    expect(textModel.getValue()).toBe('text');
    append(textModel, '!');
    await model.save();
    expect([...(await files.readFile(file('/bom.txt'))).value]).toEqual([0xef, 0xbb, 0xbf, ...bytes('text!')]);
  });

  test('Save As of a file it has no text of copies the bytes as they are', async () => {
    const stored = new Uint8Array([0xef, 0xbb, 0xbf, 0, 0xff, 0x80, 10]);
    await files.writeFile(file('/data.bin'), stored);
    const { service } = createService();
    await expect(service.files.resolve(file('/data.bin'))).rejects.toBeInstanceOf(TextFileOperationError);

    expect((await service.saveAs(file('/data.bin'), file('/copy.bin')))?.toString()).toBe(file('/copy.bin').toString());
    expect([...(await files.readFile(file('/copy.bin'))).value]).toEqual([...stored]);
  });

  test('does not open a binary file, a file over 20 MiB, a missing file or a folder as text', async () => {
    await files.writeFile(file('/image.bin'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await files.writeFile(file('/big.txt'), new Uint8Array(TEXT_FILE_SIZE_LIMIT + 1).fill(0x61));
    await files.writeFile(file('/limit.txt'), new Uint8Array(TEXT_FILE_SIZE_LIMIT).fill(0x61));
    await files.createFolder(file('/folder'));
    const { service } = createService();
    const reasons = await Promise.all(['/image.bin', '/big.txt', '/missing.txt', '/folder'].map(path =>
      service.files.resolve(file(path)).then(() => undefined, (error: unknown) =>
        error instanceof TextFileOperationError ? error.textFileOperationResult : error)));
    expect(reasons).toEqual([
      TextFileOperationResult.FILE_IS_BINARY, TextFileOperationResult.FILE_TOO_LARGE,
      TextFileOperationResult.FILE_NOT_FOUND, TextFileOperationResult.FILE_IS_DIRECTORY,
    ]);
    expect(service.files.models).toEqual([]);
    expect(models.getModels()).toEqual([]);
    expect((await resolve(service, '/limit.txt')).textModel.getValueLength()).toBe(TEXT_FILE_SIZE_LIMIT);
  });
});

describe('model references', () => {
  test('one model per file; it goes after the last reference, and a dirty one waits until saved', async () => {
    await files.writeFile(file('/shared.txt'), bytes('shared'));
    const { service, resolver } = createService();
    const [first, second] = await Promise.all([
      resolver.createModelReference(file('/shared.txt')), resolver.createModelReference(file('/shared.txt')),
    ]);
    const textModel = first.object.textEditorModel;
    expect(second.object.textEditorModel).toBe(textModel);
    expect(service.files.models).toHaveLength(1);

    first.dispose();
    await settle();
    expect(textModel.isDisposed()).toBe(false);
    append(textModel, '!');
    second.dispose();
    await settle();
    // Unsaved text is never dropped with its last reference.
    expect(textModel.isDisposed()).toBe(false);
    expect(service.files.get(file('/shared.txt'))).toBeDefined();

    await service.save(file('/shared.txt'));
    await vi.waitFor(() => expect(textModel.isDisposed()).toBe(true));
    expect(service.files.models).toEqual([]);
    expect(models.getModels()).toEqual([]);
  });

  test('a reference taken while a released model waits keeps it', async () => {
    await files.writeFile(file('/a.txt'), bytes('a'));
    const { service, resolver } = createService();
    const first = await resolver.createModelReference(file('/a.txt'));
    append(first.object.textEditorModel, '!');
    first.dispose();
    await settle();
    const second = await resolver.createModelReference(file('/a.txt'));
    expect(second.object.textEditorModel).toBe(first.object.textEditorModel);
    await service.save(file('/a.txt'));
    await settle();
    expect(second.object.textEditorModel.isDisposed()).toBe(false);
    second.dispose();
    await vi.waitFor(() => expect(second.object.textEditorModel.isDisposed()).toBe(true));
  });

  test('a model someone else made for a file resource is lent, not taken over', async () => {
    const owned = await models.createModel('{}', 'json', file('/settings.json'));
    const { service, resolver } = createService();
    expect(service.canHandleResource(file('/settings.json'))).toBe(false);
    const reference = await resolver.createModelReference(file('/settings.json'));
    expect(reference.object.textEditorModel).toBe(owned);
    reference.dispose();
    await settle();
    expect(owned.isDisposed()).toBe(false);
  });
});

describe('draft backups', () => {
  const meta = { etag: undefined, bom: false };
  const sessionId = (n: number) => n.toString(16).padStart(32, '0');
  const legacyBackup = (resource: URI, workspaceId: string) => URI.from({
    scheme: 'vscode-userdata',
    path: `/User/workspaceStorage/${workspaceId}/backups/${hashResource(resource.toString())}`,
  });
  const stored = (resource: URI, value: string, version = 1) =>
    bytes(JSON.stringify({ version, resource: resource.toString(), etag: null, bom: false }) + '\n' + value);

  function makeLocks(): { locks: IBackupLocks; held: Set<string>; sessionLock: (backups: TextFileBackups, n: number) => string } {
    const held = new Set<string>();
    return {
      held,
      sessionLock: (backups, n) => `writing-room/backupSession${backups.root.path}/${sessionId(n)}`,
      locks: {
        async hold(name) {
          expect(held.has(name)).toBe(false);
          held.add(name);
        },
        async runIfAvailable(name, task) {
          if (held.has(name)) {
            return;
          }
          held.add(name);
          try {
            await task();
          } finally {
            held.delete(name);
          }
        },
      },
    };
  }

  test('writes a draft a second after a change, asks before unload until then, and deletes it on save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await files.writeFile(file('/a.txt'), bytes('saved'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/a.txt');
    const location = service.backups.backupResource(file('/a.txt'));
    const unload = () => {
      const event = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    append(textModel, ' draft');
    expect(unload()).toBe(true);
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY - 10);
    expect(await files.exists(location)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(async () => expect(await files.exists(location)).toBe(true));
    expect(text((await files.readFile(location)).value)).toContain('\nsaved draft');
    await vi.waitFor(() => expect(unload()).toBe(false));

    await model.save();
    await vi.waitFor(async () => expect(await files.exists(location)).toBe(false));
    expect(unload()).toBe(false);
  });

  test('a failed backup keeps the unload question', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await files.writeFile(file('/a.txt'), bytes('saved'));
    const { service } = createService();
    const { textModel } = await resolve(service, '/a.txt');
    vi.spyOn(userData, 'writeFile').mockRejectedValue(
      new FileSystemProviderError('File storage quota exceeded', FileSystemProviderErrorCode.FileExceedsStorageQuota));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    append(textModel, '!');
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY + 10);
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test('a new page reads the draft as dirty text, still saving against the file it came from', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await files.writeFile(file('/a.txt'), bytes('saved'));
    const before = createService().service;
    const { textModel } = await resolve(before, '/a.txt');
    const location = before.backups.backupResource(file('/a.txt'));
    append(textModel, ' draft');
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY + 10);
    await vi.waitFor(async () => expect(await files.exists(location)).toBe(true));
    vi.useRealTimers();
    // The page goes away without disposing anything; a new one starts over the same storage.
    models = new TestModelService();
    const after = createService().service;

    const restored = await resolve(after, '/a.txt');
    expect(restored.textModel.getValue()).toBe('saved draft');
    expect(restored.model.isDirty()).toBe(true);
    await files.writeFile(file('/a.txt'), bytes('changed meanwhile'));
    conflicts.push('cancel');
    expect(await restored.model.save()).toBe(false);
    expect(await readFile('/a.txt')).toBe('changed meanwhile');
  });

  test('live sessions keep separate drafts, including a write queued after a discard', async () => {
    const { locks, held, sessionLock } = makeLocks();
    const first = new TextFileBackups(files, 'locks', sessionId(1), locks);
    const resource = file('/a.txt');
    await first.write(resource, 'first tab', meta);
    const second = new TextFileBackups(files, 'locks', sessionId(2), locks);
    expect(await second.read(resource)).toBeUndefined();
    await second.write(resource, 'second tab', meta);

    // A save discards. A new edit queues a write before that discard has run.
    const discarded = second.discard(resource);
    const written = second.write(resource, 'second tab typed again', meta);
    await Promise.all([discarded, written]);
    expect(held.has(sessionLock(second, 2))).toBe(true);

    const newcomer = new TextFileBackups(files, 'locks', sessionId(3), locks);
    expect(await newcomer.listRestorable()).toEqual([]);
    expect((await first.read(resource))?.value).toBe('first tab');
    expect((await second.read(resource))?.value).toBe('second tab typed again');
  });

  test('a page with a denied session lock keeps writing locally and cannot discard a moved draft', async () => {
    const { locks, held, sessionLock } = makeLocks();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resource = file('/denied.txt');
    const older = file('/older.txt');
    const legacy = legacyBackup(older, 'denied');
    await files.writeFile(legacy, stored(older, 'earlier session'));
    const runIfAvailable = vi.fn(locks.runIfAvailable);
    const denied = new TextFileBackups(files, 'denied', sessionId(1), {
      hold: async () => { throw new DOMException('Lock denied', 'SecurityError'); },
      runIfAvailable,
    });

    await denied.write(resource, 'the denied page’s draft', meta);
    expect(await denied.read(older)).toBeUndefined();
    expect(await files.exists(legacy)).toBe(true);
    expect(runIfAvailable).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Draft adoption is disabled'), expect.any(DOMException));

    const second = new TextFileBackups(files, 'denied', sessionId(2), locks);
    expect((await second.read(resource))?.value).toBe('the denied page’s draft');
    expect(await files.exists(denied.backupResource(resource))).toBe(false);
    // The old page being saved or reverted can only discard its own path.
    await denied.discard(resource);
    expect(await files.exists(second.backupResource(resource))).toBe(true);

    held.delete(sessionLock(second, 2));
    const reloaded = new TextFileBackups(files, 'denied', sessionId(3), locks);
    expect((await reloaded.read(resource))?.value).toBe('the denied page’s draft');
    expect(await files.exists(second.backupResource(resource))).toBe(false);
  });

  test('rechecking a listed draft this session wrote does not read its bytes again', async () => {
    const resource = file('/listed.txt');
    const backups = new TextFileBackups(files, 'recheck', sessionId(1));
    await backups.write(resource, 'unsaved', meta);
    expect(await backups.listRestorable()).toEqual([resource]);
    const readFile = vi.spyOn(userData, 'readFileWithStat');

    expect(await backups.hasRestorable(resource)).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    await backups.discard(resource);
    expect(await backups.hasRestorable(resource)).toBe(false);
  });

  test.each(['save', 'revert', 'soft revert'] as const)('a second model’s %s forgets only its own draft', async action => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const resource = file('/a.txt');
    await files.writeFile(resource, bytes('base'));
    const first = createService().service;
    const firstModel = await resolve(first, resource.path);
    models = new TestModelService();
    const second = createService().service;
    const secondModel = await resolve(second, resource.path);
    append(firstModel.textModel, ' first');
    append(secondModel.textModel, ' second');
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY + 10);
    await vi.waitFor(async () => {
      expect((await first.backups.read(resource))?.value).toBe('base first');
      expect((await second.backups.read(resource))?.value).toBe('base second');
    });

    if (action === 'save') {
      expect(await secondModel.model.save()).toBe(true);
    } else {
      await secondModel.model.revert({ soft: action === 'soft revert' });
    }
    await vi.waitFor(async () => expect(await second.backups.read(resource)).toBeUndefined());
    expect((await first.backups.read(resource))?.value).toBe('base first');
  });

  test('an early read waits for the legacy move and active legacy locks are respected', async () => {
    const { locks, held } = makeLocks();
    const resource = file('/legacy.txt');
    const legacy = legacyBackup(resource, 'migration');
    const locked = file('/legacy-live.txt');
    const lockedLocation = legacyBackup(locked, 'migration');
    held.add(`writing-room/backup/User/workspaceStorage/migration/backups/${hashResource(locked.toString())}`);
    await files.writeFile(legacy, stored(resource, 'old format'));
    await files.writeFile(lockedLocation, stored(locked, 'old page still open'));
    const entered = new DeferredPromise<void>();
    const resume = new DeferredPromise<void>();
    const move = files.move.bind(files);
    vi.spyOn(files, 'move').mockImplementationOnce(async (source, target) => {
      await entered.complete();
      await resume.p;
      return move(source, target);
    });

    const backups = new TextFileBackups(files, 'migration', sessionId(1), locks);
    let readFinished = false;
    const reading = backups.read(resource).then(draft => {
      readFinished = true;
      return draft;
    });
    await entered.p;
    await settle();
    try {
      expect(readFinished).toBe(false);
    } finally {
      await resume.complete();
    }
    expect((await reading)?.value).toBe('old format');
    expect(await files.exists(legacy)).toBe(false);
    expect(await files.exists(lockedLocation)).toBe(true);
    expect(await backups.read(locked)).toBeUndefined();
  });

  test('simultaneous startups without locks move a legacy draft exactly once', async () => {
    const resource = file('/shared.txt');
    const legacy = legacyBackup(resource, 'no-locks');
    await files.writeFile(legacy, stored(resource, 'one draft'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entered = new DeferredPromise<void>();
    const resume = new DeferredPromise<void>();
    const move = files.move.bind(files);
    let attempts = 0;
    vi.spyOn(files, 'move').mockImplementation(async (source, target) => {
      if (++attempts === 2) {
        await entered.complete();
      }
      await resume.p;
      return move(source, target);
    });

    const first = new TextFileBackups(files, 'no-locks', sessionId(1));
    const second = new TextFileBackups(files, 'no-locks', sessionId(2));
    await entered.p;
    await resume.complete();
    const lists = await Promise.all([first.listRestorable(), second.listRestorable()]);
    expect(lists.flat()).toEqual([resource]);
    const winner = lists[0].length ? first : second;
    expect((await winner.read(resource))?.value).toBe('one draft');
    expect(await files.exists(legacy)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test('each startup claims one same-file draft and prunes only empty dead folders', async () => {
    const { locks, held, sessionLock } = makeLocks();
    const resource = file('/both.txt');
    const first = new TextFileBackups(files, 'duplicates', sessionId(1), locks);
    await first.write(resource, 'first draft', meta);
    const second = new TextFileBackups(files, 'duplicates', sessionId(2), locks);
    await second.write(resource, 'second draft', meta);
    held.delete(sessionLock(first, 1));
    held.delete(sessionLock(second, 2));

    const third = new TextFileBackups(files, 'duplicates', sessionId(3), locks);
    const claimed = await third.read(resource);
    const remainingId = claimed?.value === 'first draft' ? 2 : 1;
    const remainingPage = remainingId === 1 ? first : second;
    expect(await files.exists(remainingPage.backupResource(resource))).toBe(true);
    expect((await files.resolve(third.root)).children?.map(child => child.name).sort())
      .toEqual([sessionId(remainingId), sessionId(3)]);

    // The next page can reach the other draft even while this one is open.
    const fourth = new TextFileBackups(files, 'duplicates', sessionId(4), locks);
    const remaining = await fourth.read(resource);
    expect([claimed?.value, remaining?.value].sort()).toEqual(['first draft', 'second draft']);
  });

  test('a reload keeps its latest draft when an older closed session holds one of the same file', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { locks, held, sessionLock } = makeLocks();
    const resource = file('/both.txt');
    // The older session's folder is listed first.
    vi.setSystemTime(1_000);
    const stale = new TextFileBackups(files, 'recency', sessionId(1), locks);
    await stale.write(resource, 'stale draft', meta);
    vi.setSystemTime(2_000);
    const reloaded = new TextFileBackups(files, 'recency', sessionId(2), locks);
    await reloaded.write(resource, 'latest draft', meta);
    held.delete(sessionLock(stale, 1));
    held.delete(sessionLock(reloaded, 2));

    vi.setSystemTime(3_000);
    const next = new TextFileBackups(files, 'recency', sessionId(3), locks);
    expect((await next.read(resource))?.value).toBe('latest draft');
    expect(text((await files.readFile(stale.backupResource(resource))).value)).toContain('\nstale draft');
  });

  test('reloading several times without Web Locks keeps one session folder', async () => {
    const resource = file('/a.txt');
    let page = new TextFileBackups(files, 'reload', sessionId(1));
    await page.write(resource, 'keep me', meta);
    for (const n of [2, 3, 4]) {
      page = new TextFileBackups(files, 'reload', sessionId(n));
      expect((await page.read(resource))?.value).toBe('keep me');
      expect((await files.resolve(page.root)).children?.map(child => child.name)).toEqual([sessionId(n)]);
    }
    await page.discard(resource);
    page = new TextFileBackups(files, 'reload', sessionId(5));
    expect(await page.listRestorable()).toEqual([]);
    expect((await files.resolve(page.root)).children).toEqual([]);
  });

  test('session IDs work without crypto.randomUUID', () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      const first = createBackupSessionId();
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(createBackupSessionId()).not.toBe(first);
    } finally {
      Reflect.deleteProperty(crypto, 'randomUUID');
      if (descriptor) {
        Object.defineProperty(crypto, 'randomUUID', descriptor);
      }
    }
  });

  test('startup lists drafts even when no editor owns them, without deleting them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await files.writeFile(file('/unopened.txt'), bytes('saved'));
    const { service } = createService();
    append((await resolve(service, '/unopened.txt')).textModel, ' from an edit without a tab');
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY + 10);
    await vi.waitFor(async () => expect(await files.exists(service.backups.backupResource(file('/unopened.txt')))).toBe(true));

    expect(await service.backups.listRestorable()).toEqual([file('/unopened.txt')]);
    models = new TestModelService();
    const restored = await resolve(createService().service, '/unopened.txt');
    expect(restored.model.isDirty()).toBe(true);
    expect(restored.textModel.getValue()).toBe('saved from an edit without a tab');
  });

  test('a model that reads a draft while startup lists it keeps its backup', async () => {
    const { service } = createService();
    const resource = file('/opened-during-startup.txt');
    await files.writeFile(resource, bytes('saved'));
    await service.backups.write(resource, 'draft', { etag: undefined, bom: false });
    const entered = new DeferredPromise<void>();
    const resume = new DeferredPromise<void>();
    const readFile = userData.readFileWithStat.bind(userData);
    vi.spyOn(userData, 'readFileWithStat').mockImplementationOnce(async location => {
      await entered.complete();
      await resume.p;
      return readFile(location);
    });
    const listing = service.backups.listRestorable();
    await entered.p;
    const { model, textModel } = await resolve(service, resource.path);
    await resume.complete();
    expect(await listing).toEqual([resource]);
    expect(model.isDirty()).toBe(true);
    expect(textModel.getValue()).toBe('draft');
    expect(await files.exists(service.backups.backupResource(resource))).toBe(true);
  });

  test('a failed read of a former session’s draft prevents opening saved text until startup can read it', async () => {
    const resource = file('/unreadable-at-startup.txt');
    await files.writeFile(resource, bytes('saved'));
    const legacy = legacyBackup(resource, workspace.getWorkspace().id);
    await files.writeFile(legacy, stored(resource, 'prior unsaved draft'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = userData.readFileWithStat.bind(userData);
    const reading = vi.spyOn(userData, 'readFileWithStat').mockImplementation(async (location, options) => {
      if (location.toString() === legacy.toString()) {
        throw new Error('Storage is busy');
      }
      return read(location, options);
    });
    const before = createService().service;
    await expect(before.files.resolve(resource)).rejects.toThrow('The unsaved draft could not be read');
    expect(before.files.get(resource)).toBeUndefined();
    expect(await files.exists(legacy)).toBe(true);

    reading.mockRestore();
    const restored = await resolve(createService().service, resource.path);
    expect(restored.model.isDirty()).toBe(true);
    expect(restored.textModel.getValue()).toBe('prior unsaved draft');
    expect(await readFile(resource.path)).toBe('saved');
  });

  test('startup preserves malformed, mismatched, unsupported and newer drafts and keeps scanning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workspaceId = 'validation';
    const blocked = [
      'http://example.test/remote', 'https://example.test/remote', 'HTTPS://example.test/remote',
      'vscode-userdata:/User/draft', 'untitled:/Untitled-1',
    ];
    const future = file('/future.txt');
    const valid = file('/valid.txt');
    const unreadable = legacyBackup(file('/unreadable.txt'), workspaceId);
    const root = URI.from({ scheme: 'vscode-userdata', path: `/User/workspaceStorage/${workspaceId}/backups` });
    const entries: [URI, Uint8Array][] = [
      [legacyBackup(file('/malformed.txt'), workspaceId), bytes('no header')],
      [legacyBackup(file('/wrong.txt'), workspaceId), stored(file('/other.txt'), 'mismatched')],
      [legacyBackup(future, workspaceId), stored(future, 'future', 2)],
      [unreadable, stored(file('/unreadable.txt'), 'temporarily unreadable')],
      [joinPath(root, 'invalid-session', hashResource(valid.toString())), stored(valid, 'invalid session')],
      [joinPath(root, sessionId(4), 'invalid-name'), stored(valid, 'invalid name')],
      ...blocked.map((value): [URI, Uint8Array] => {
        const resource = URI.parse(value);
        return [legacyBackup(resource, workspaceId), stored(resource, 'unsupported')];
      }),
    ];
    for (const [location, content] of entries) {
      await files.writeFile(location, content);
    }
    const validLocation = legacyBackup(valid, workspaceId);
    await files.writeFile(validLocation, stored(valid, 'our draft'));
    const read = userData.readFileWithStat.bind(userData);
    const reading = vi.spyOn(userData, 'readFileWithStat').mockImplementation(async (resource, options) => {
      if (resource.toString() === unreadable.toString()) {
        throw new Error('The draft cannot be read right now');
      }
      return read(resource, options);
    });
    const backups = new TextFileBackups(files, workspaceId, sessionId(1));
    expect(await backups.listRestorable()).toEqual([valid]);
    reading.mockRestore();
    expect(warn).toHaveBeenCalledTimes(entries.length - 2); // The unknown version and invalid directory are skipped.
    for (const [location, content] of entries) {
      expect(Array.from((await files.readFile(location)).value)).toEqual(Array.from(content));
    }
  });

  test('writing or discarding a draft leaves even an unexpected newer draft in this session intact', async () => {
    const backups = new TextFileBackups(files, 'future', sessionId(1));
    const resource = file('/future.txt');
    const location = backups.backupResource(resource);
    const original = stored(resource, 'keep this newer draft', 2);
    await files.writeFile(location, original);

    await expect(backups.write(resource, 'new edit', meta)).rejects.toThrow('Cannot replace');
    await backups.discard(resource);
    expect(Array.from((await files.readFile(location)).value)).toEqual(Array.from(original));
  });
});
