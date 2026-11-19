import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
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
import { hashResource, TextFileBackups } from '../../common/textFileBackup.js';
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
  const backupOf = (path: string) => URI.from({
    scheme: 'vscode-userdata', path: `/User/workspaceStorage/test-workspace/backups/${hashResource(file(path).toString())}`,
  });

  test('writes a draft a second after a change, asks before unload until then, and deletes it on save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await files.writeFile(file('/a.txt'), bytes('saved'));
    const { service } = createService();
    const { model, textModel } = await resolve(service, '/a.txt');
    const unload = () => {
      const event = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    append(textModel, ' draft');
    expect(unload()).toBe(true);
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY - 10);
    expect(await files.exists(backupOf('/a.txt'))).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(async () => expect(await files.exists(backupOf('/a.txt'))).toBe(true));
    expect(text((await files.readFile(backupOf('/a.txt'))).value)).toContain('\nsaved draft');
    await vi.waitFor(() => expect(unload()).toBe(false));

    await model.save();
    await vi.waitFor(async () => expect(await files.exists(backupOf('/a.txt'))).toBe(false));
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
    append(textModel, ' draft');
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY + 10);
    await vi.waitFor(async () => expect(await files.exists(backupOf('/a.txt'))).toBe(true));
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

  test('a draft written after a discard that was still waiting keeps its lock', async () => {
    const own = new Set<string>();
    const locks: IBackupLocks = {
      own,
      hold: name => { own.add(name); },
      release: name => { own.delete(name); },
      held: async () => new Set(own),
    };
    const backups = new TextFileBackups(files, 'locks', locks);
    const resource = file('/a.txt');
    await backups.write(resource, 'first', { etag: undefined, bom: false });
    // The save that made the text clean discards; typing again writes before that discard has run.
    const discarded = backups.discard(resource);
    const written = backups.write(resource, 'second', { etag: undefined, bom: false });
    await Promise.all([discarded, written]);

    expect(await files.exists(backups.backupResource(resource))).toBe(true);
    // Other tabs see the draft as kept, so their startup leaves it alone.
    expect(own.size).toBe(1);
  });

  test('startup lists drafts even when no editor owns them, without deleting them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await files.writeFile(file('/unopened.txt'), bytes('saved'));
    const { service } = createService();
    append((await resolve(service, '/unopened.txt')).textModel, ' from an edit without a tab');
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY + 10);
    await vi.waitFor(async () => expect(await files.exists(backupOf('/unopened.txt'))).toBe(true));

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

  test('startup preserves malformed, mismatched, unsupported and newer drafts and keeps scanning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service } = createService();
    const meta = { etag: null, bom: false };
    const blocked = ['http://example.test/remote', 'https://example.test/remote', 'vscode-userdata:/User/draft', 'untitled:/Untitled-1'];
    const entries: [URI, string][] = [
      [backupOf('/malformed.txt'), 'no header'],
      [backupOf('/wrong.txt'), JSON.stringify({ version: 1, resource: file('/other.txt').toString(), ...meta }) + '\ndraft'],
      [backupOf('/future.txt'), JSON.stringify({ version: 2, resource: file('/future.txt').toString(), ...meta }) + '\nfuture'],
      ...blocked.map((resource): [URI, string] => [
        service.backups.backupResource(URI.parse(resource)),
        JSON.stringify({ version: 1, resource, ...meta }) + '\ndraft',
      ]),
    ];
    for (const [location, content] of entries) {
      await files.writeFile(location, bytes(content));
    }
    const valid = file('/valid.txt');
    await service.backups.write(valid, 'our draft', { etag: undefined, bom: false });

    expect(await service.backups.listRestorable()).toEqual([valid]);
    expect(warn).toHaveBeenCalledTimes(entries.length - 1);
    for (const [location, content] of entries) {
      expect(text((await files.readFile(location)).value)).toBe(content);
    }
  });
});
