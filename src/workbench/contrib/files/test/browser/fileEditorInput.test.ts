import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { TestModelService } from '../../../../../editor/test/common/testTextModel.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileSystemProviderError, FileSystemProviderErrorCode, IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextService as IWorkspace, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../../../services/dialogs/common/dialogs.js';
import type { IFileDialogService as IFileDialogs } from '../../../../services/dialogs/common/dialogs.js';
import { BrowserTextFileService } from '../../../../services/textfile/browser/textFileService.js';
import { isTextFileResource, ITextFileService, TextFileOperationError, TextFileOperationResult } from '../../../../services/textfile/common/textfiles.js';
import type { ITextFileEditorModel } from '../../../../services/textfile/common/textfiles.js';
import { TextModelResolverService } from '../../../../services/textmodelResolver/common/textModelResolverService.js';
import { IUntitledTextEditorService, UntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import { FileEditorInputSerializer } from '../../browser/editors/fileEditorHandler.js';
import { FileEditorInput } from '../../browser/editors/fileEditorInput.js';
import { describeFileOpenError } from '../../browser/editors/textFileEditor.js';
import { describeSaveError } from '../../browser/editors/textFileSaveErrorHandler.js';

const root = URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace' });
const file = (path: string) => URI.joinPath(root, path);
const bytes = (text: string) => new TextEncoder().encode(text);
const folder: IWorkspaceFolder = { uri: root, name: 'workspace', index: 0, toResource: path => URI.joinPath(root, path) };
const workspace: IWorkspace = {
  _serviceBrand: undefined,
  onDidChangeWorkspaceFolders: Event.None,
  getWorkbenchState: () => 2,
  getWorkspace: () => ({ id: 'test', folders: [folder] }),
  getWorkspaceFolder: resource => resource.path.startsWith('/workspace') ? folder : null,
};

let disposables: DisposableStore;
let files: FileService;
let models: TestModelService;
let instantiation: InstantiationService;
let textFiles: BrowserTextFileService;
let dialogs: { -readonly [K in keyof IFileDialogs]: IFileDialogs[K] };

beforeEach(async () => {
  disposables = new DisposableStore();
  files = disposables.add(new FileService());
  files.registerProvider('vscode-vfs', disposables.add(new InMemoryFileSystemProvider()));
  files.registerProvider('vscode-userdata', disposables.add(new InMemoryFileSystemProvider()));
  models = new TestModelService();
  dialogs = {
    _serviceBrand: undefined,
    defaultFilePath: () => root,
    showSaveConfirm: vi.fn(async () => { throw new Error('Unexpected question.'); }),
    pickFileToSave: vi.fn(async () => undefined),
    showSaveDialog: vi.fn(async () => undefined),
    showOpenDialog: vi.fn(async () => undefined),
  };
  const services = new ServiceCollection(
    [IFileService, files], [IModelService, models], [IWorkspaceContextService, workspace], [IFileDialogService, dialogs],
  );
  instantiation = new InstantiationService(services);
  services.set(IUntitledTextEditorService, instantiation.createInstance(UntitledTextEditorService));
  textFiles = disposables.add(instantiation.createInstance(BrowserTextFileService));
  services.set(ITextFileService, textFiles);
  services.set(ITextModelService, instantiation.createInstance(TextModelResolverService));
  await files.writeFile(file('docs/a.md'), bytes('# docs'));
  await files.writeFile(file('a.md'), bytes('# top'));
});

afterEach(() => disposables.dispose());

const createInput = (path: string, restoredDirty = false) =>
  disposables.add(instantiation.createInstance(FileEditorInput, file(path), { restoredDirty }));

describe('file editor input', () => {
  test('names the file and tells its folder relative to the workspace', () => {
    expect(createInput('docs/a.md').getName()).toBe('a.md');
    expect(createInput('docs/a.md').getDescription()).toBe('docs');
    expect(createInput('a.md').getDescription()).toBe('workspace');
    expect(createInput('docs/a.md').getTitle()).toBe('workspace/docs/a.md');
  });

  test('two inputs of one file share one model, which goes when the last input does', async () => {
    const left = createInput('docs/a.md');
    const right = createInput('docs/a.md');
    expect(left.matches(right)).toBe(true);
    expect(left.matches(createInput('a.md'))).toBe(false);
    const [first, second] = await Promise.all([left.resolve(), right.resolve()]);
    expect(first).toBe(second);
    const textModel = first.textEditorModel!;
    expect(models.getModels()).toEqual([textModel]);

    left.dispose();
    await new Promise(resolve => setTimeout(resolve));
    expect(textModel.isDisposed()).toBe(false);
    right.dispose();
    await vi.waitFor(() => expect(textModel.isDisposed()).toBe(true));
    expect(textFiles.files.models).toEqual([]);
  });

  test('follows its model’s dirty state, saves and reverts through the text file service', async () => {
    const input = createInput('a.md');
    const model = await input.resolve() as ITextFileEditorModel;
    const dirty = vi.fn();
    input.onDidChangeDirty(dirty);
    model.textEditorModel!.setValue('# changed');
    expect(input.isDirty()).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(1);

    expect(await input.save(1)).toBe(input);
    expect(input.isDirty()).toBe(false);
    expect(new TextDecoder().decode((await files.readFile(file('a.md'))).value)).toBe('# changed');

    model.textEditorModel!.setValue('# again');
    await input.revert(1);
    expect(model.textEditorModel!.getValue()).toBe('# changed');
    expect(input.isDirty()).toBe(false);
  });

  test('a tab restored with a draft is dirty until its model says otherwise', async () => {
    const input = createInput('a.md', true);
    expect(input.isDirty()).toBe(true);
    await input.resolve();
    // No draft was left: the model read the file and is clean.
    expect(input.isDirty()).toBe(false);
  });

  test('a file that cannot be text rejects and holds no reference', async () => {
    await files.writeFile(file('data.bin'), new Uint8Array([1, 0, 2]));
    const input = createInput('data.bin');
    const error = await input.resolve().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TextFileOperationError);
    expect((error as TextFileOperationError).textFileOperationResult).toBe(TextFileOperationResult.FILE_IS_BINARY);
    expect(describeFileOpenError(error)).toMatch(/binary/);
    expect(textFiles.files.models).toEqual([]);
    // A later attempt reads again.
    await files.writeFile(file('data.bin'), bytes('text now'));
    expect((await input.resolve()).textEditorModel?.getValue()).toBe('text now');
  });
});

describe('file editor serializer', () => {
  const serializer = new FileEditorInputSerializer();

  test('writes the resource and whether a draft is kept, and reads them back', async () => {
    const input = createInput('docs/a.md');
    const clean = serializer.serialize(input)!;
    expect(JSON.parse(clean)).toEqual({ resource: file('docs/a.md').toString() });
    const restored = disposables.add(serializer.deserialize(instantiation, clean) as FileEditorInput);
    expect(restored).toBeInstanceOf(FileEditorInput);
    expect(restored.resource.toString()).toBe(file('docs/a.md').toString());
    expect(restored.isDirty()).toBe(false);

    (await input.resolve()).textEditorModel!.setValue('changed');
    const dirty = serializer.serialize(input)!;
    expect(JSON.parse(dirty)).toEqual({ resource: file('docs/a.md').toString(), backup: true });
    expect(disposables.add(serializer.deserialize(instantiation, dirty) as FileEditorInput).isDirty()).toBe(true);
  });

  test('round-trips a name with spaces, Hangul and URI delimiters', () => {
    const input = createInput('한 글#?%.md');
    const restored = disposables.add(serializer.deserialize(instantiation, serializer.serialize(input)!) as FileEditorInput);
    expect(restored.resource.path).toBe('/workspace/한 글#?%.md');
  });

  test('ignores damaged or foreign values', () => {
    for (const value of ['', 'nope', '{}', '{"resource":1}', '{"resource":"untitled:Untitled-1"}', '{"resource":"x","backup":"yes"}',
      // The user data store (drafts, extension packages) and remote extension resources are not text files.
      '{"resource":"vscode-userdata:/User/workspaceStorage/test/backups/0"}', '{"resource":"https://example.com/a.md"}']) {
      expect(serializer.deserialize(instantiation, value)).toBeUndefined();
    }
  });
});

describe('which resources are text files', () => {
  test('the workspace folder is; the user data store and remote resources are not, so no text model is made for them', () => {
    expect(textFiles.canHandleResource(file('a.md'))).toBe(true);
    expect(textFiles.canHandleResource(URI.parse('vscode-userdata:/User/workspaceStorage/test/backups/0'))).toBe(false);
    expect(textFiles.canHandleResource(URI.parse('https://example.com/a.md'))).toBe(false);
    expect(isTextFileResource(file('a.md'), files)).toBe(true);
    expect(isTextFileResource(URI.parse('vscode-userdata:/extensions/a/package.json'), files)).toBe(false);
    expect(isTextFileResource(URI.parse('other:/a.md'), files)).toBe(false);
  });
});

describe('save error message', () => {
  test('a full storage says so', async () => {
    const model = await textFiles.files.resolve(file('a.md'));
    const quota = new FileSystemProviderError('File storage quota exceeded', FileSystemProviderErrorCode.FileExceedsStorageQuota);
    expect(describeSaveError(quota, model)).toBe("Failed to save 'a.md': The browser storage is full. Free up space and try again.");
    const wrapped = new Error('write failed', { cause: Object.assign(new Error('quota'), { name: 'QuotaExceededError' }) });
    expect(describeSaveError(wrapped, model)).toMatch(/browser storage is full/);
    expect(describeSaveError(new Error('Disk on fire'), model)).toBe("Failed to save 'a.md': Disk on fire");
  });
});
