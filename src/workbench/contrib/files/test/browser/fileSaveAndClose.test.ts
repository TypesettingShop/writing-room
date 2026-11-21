import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { formatKeybinding } from '../../../../../base/common/keybindingLabels.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService, NullConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileSystemProviderError, FileSystemProviderErrorCode, IFileService } from '../../../../../platform/files/common/files.js';
import type { IFileWriteOptions } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import type { ServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingResolver } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextService as IWorkspace, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { loadMonaco } from '../../../../../editor/browser/monaco.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { ConfirmResult } from '../../../../common/editor/editorInput.js';
import type { EditorInput } from '../../../../common/editor/editorInput.js';
import { IFileDialogService } from '../../../../services/dialogs/common/dialogs.js';
import type { IFileDialogService as IFileDialogs, ISaveDialogOptions } from '../../../../services/dialogs/common/dialogs.js';
import { GroupDirection, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { BrowserTextFileService } from '../../../../services/textfile/browser/textFileService.js';
import { BACKUP_DELAY } from '../../../../services/textfile/common/textFileEditorModel.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { UntitledTextEditorInput } from '../../../../services/untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import { FileEditorResolverContribution } from '../../browser/editors/fileEditorHandler.js';
import { FileEditorInput } from '../../browser/editors/fileEditorInput.js';
import { deleteItem } from '../../browser/explorerActions.js';
import { ExplorerService } from '../../browser/explorerService.js';
import '../../../../workbench.web.main.js';

// jsdom cannot run Monaco; the text editor panes get the fake.
vi.mock('../../../../../editor/browser/monaco.js', async () => {
  const { FakeMonaco } = await import('../../../../../editor/test/browser/fakeMonaco.js');
  const monaco = new FakeMonaco();
  return { loadMonaco: async () => monaco };
});

const root = URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace' });
const file = (path: string) => URI.joinPath(root, path);
const folder: IWorkspaceFolder = { uri: root, name: 'workspace', index: 0, toResource: path => URI.joinPath(root, path) };
const workspace: IWorkspace = {
  _serviceBrand: undefined,
  onDidChangeWorkspaceFolders: Event.None,
  getWorkbenchState: () => 2,
  getWorkspace: () => ({ id: 'test', folders: [folder] }),
  getWorkspaceFolder: resource => resource.path.startsWith('/workspace') ? folder : null,
};

/** A workspace provider whose writes can be made to fail. */
class FailingProvider extends InMemoryFileSystemProvider {
  failWith: Error | undefined;
  override async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions) {
    if (this.failWith) {
      throw this.failWith;
    }
    return super.writeFile(resource, content, options);
  }
}

/** The dialogs, answered by the test: each question takes the next answer. */
class ScriptedDialogs implements IFileDialogs {
  declare readonly _serviceBrand: undefined;
  readonly confirms: string[][] = [];
  readonly saveDialogs: ISaveDialogOptions[] = [];
  readonly confirmAnswers: ConfirmResult[] = [];
  readonly saveAnswers: (URI | undefined)[] = [];
  defaultFilePath(): URI { return root; }
  async showSaveConfirm(names: readonly (string | URI)[]): Promise<ConfirmResult> {
    this.confirms.push(names.map(String));
    return this.confirmAnswers.shift() ?? ConfirmResult.CANCEL;
  }
  pickFileToSave(defaultUri: URI): Promise<URI | undefined> { return this.showSaveDialog({ defaultUri }); }
  async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
    this.saveDialogs.push(options);
    return this.saveAnswers.shift();
  }
  async showOpenDialog(): Promise<URI[] | undefined> { return undefined; }
}

const disposables = new DisposableStore();
let part: EditorPart;
let instantiation: InstantiationService;
let files: FileService;
let provider: FailingProvider;
let dialogs: ScriptedDialogs;

function service<T>(id: ServiceIdentifier<T>): T {
  return instantiation.invokeFunction(accessor => accessor.get(id));
}

const read = async (path: string) => new TextDecoder().decode((await files.readFile(file(path))).value);
const exists = (path: string) => files.exists(file(path));
const names = (editors: readonly EditorInput[]) => editors.map(editor => editor.getName());

beforeEach(async () => {
  files = disposables.add(new FileService());
  provider = disposables.add(new FailingProvider());
  files.registerProvider('vscode-vfs', provider);
  files.registerProvider('vscode-userdata', disposables.add(new InMemoryFileSystemProvider()));
  await files.createFolder(root);
  await files.writeFile(file('a.md'), new TextEncoder().encode('alpha'));
  await files.writeFile(file('b.md'), new TextEncoder().encode('beta'));
  dialogs = new ScriptedDialogs();
  const services = new ServiceCollection(
    [IStorageService, disposables.add(new InMemoryStorageService())],
    [IConfigurationService, new NullConfigurationService()],
    [IFileService, files],
    [IWorkspaceContextService, workspace],
    [IFileDialogService, dialogs],
  );
  instantiation = new InstantiationService(services);
  part = instantiation.createInstance(EditorPart);
  services.set(IEditorGroupsService, part);
  const container = document.body.appendChild(document.createElement('div'));
  part.create(container);
  part.layout(1000, 600, 0, 0);
  disposables.add(part);
  disposables.add({ dispose: () => container.remove() });
  // Workbench contributions do not start here: files open in the file editor through this one.
  disposables.add(instantiation.createInstance(FileEditorResolverContribution));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  disposables.clear();
  (service(ITextFileService) as ITextFileService & { dispose(): void }).dispose();
  // The fake Monaco is one for the whole file: the next test starts without this one's models.
  for (const model of (await loadMonaco()).editor.getModels()) {
    model.dispose();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function openFile(path: string, group = part.activeGroup): Promise<FileEditorInput> {
  const input = instantiation.createInstance(FileEditorInput, file(path), {});
  await group.openEditor(input);
  await input.resolve();
  return group.editors.find(editor => editor.matches(input)) as FileEditorInput;
}

async function openUntitled(text: string, group = part.activeGroup): Promise<UntitledTextEditorInput> {
  const input = instantiation.createInstance(UntitledTextEditorInput, service(IUntitledTextEditorService).create({ initialValue: text }));
  await group.openEditor(input);
  return input;
}

async function type(input: FileEditorInput, text: string): Promise<void> {
  const model = service(ITextFileService).files.get(input.resource)!;
  model.textEditorModel!.setValue(text);
  expect(input.isDirty()).toBe(true);
}

describe('closing asks first', () => {
  test('a clean file and an empty untitled editor close without a question; dirty ones ask', async () => {
    const clean = await openFile('a.md');
    const empty = await openUntitled('');
    expect(clean.closeHandler.showConfirm()).toBe(false);
    expect(empty.closeHandler?.showConfirm()).toBe(false);
    expect(await part.activeGroup.closeEditors([clean, empty])).toBe(true);
    expect(dialogs.confirms).toEqual([]);

    const dirty = await openFile('b.md');
    await type(dirty, 'changed');
    const draft = await openUntitled('draft');
    expect(dirty.closeHandler.showConfirm()).toBe(true);
    expect(draft.closeHandler?.showConfirm()).toBe(true);
    dialogs.confirmAnswers.push(ConfirmResult.DONT_SAVE, ConfirmResult.DONT_SAVE);
    expect(await part.activeGroup.closeEditors([dirty, draft])).toBe(true);
    expect(dialogs.confirms).toEqual([['b.md'], ['Untitled-1']]);
    expect(part.activeGroup.isEmpty).toBe(true);
    // Don't Save left the file as it was.
    expect(await read('b.md')).toBe('beta');
  });

  test('Cancel keeps the tab, the text and its dirty state', async () => {
    const dirty = await openFile('a.md');
    await type(dirty, 'unsaved');
    const draft = await openUntitled('draft');
    dialogs.confirmAnswers.push(ConfirmResult.CANCEL, ConfirmResult.CANCEL);
    expect(await part.activeGroup.closeEditor(dirty)).toBe(false);
    expect(await part.activeGroup.closeEditor(draft)).toBe(false);
    expect(names(part.activeGroup.editors)).toEqual(['a.md', 'Untitled-1']);
    expect(dirty.isDirty()).toBe(true);
    expect(service(ITextFileService).files.get(file('a.md'))!.textEditorModel!.getValue()).toBe('unsaved');
    expect(draft.model.getValue()).toBe('draft');
    expect(draft.isDisposed()).toBe(false);
    expect(await read('a.md')).toBe('alpha');
  });

  test('Save that fails keeps the file open and dirty; Save that works closes it', async () => {
    const dirty = await openFile('a.md');
    await type(dirty, 'unsaved');
    provider.failWith = new FileSystemProviderError('full', FileSystemProviderErrorCode.FileExceedsStorageQuota);
    dialogs.confirmAnswers.push(ConfirmResult.SAVE);
    expect(await part.activeGroup.closeEditor(dirty)).toBe(false);
    expect(part.activeGroup.editors).toEqual([dirty]);
    expect(dirty.isDirty()).toBe(true);

    provider.failWith = undefined;
    dialogs.confirmAnswers.push(ConfirmResult.SAVE);
    expect(await part.activeGroup.closeEditor(dirty)).toBe(true);
    expect(await read('a.md')).toBe('unsaved');
  });

  test('Save of untitled text asks where; a cancelled path keeps it open, a path saves it and closes the tab', async () => {
    const draft = await openUntitled('draft text');
    dialogs.confirmAnswers.push(ConfirmResult.SAVE, ConfirmResult.SAVE);
    dialogs.saveAnswers.push(undefined, file('notes.md'));
    expect(await part.activeGroup.closeEditor(draft)).toBe(false);
    expect(part.activeGroup.editors).toEqual([draft]);
    expect(draft.model.getValue()).toBe('draft text');
    expect(dialogs.saveDialogs[0].defaultUri?.toString()).toBe(file('Untitled-1.txt').toString());

    expect(await part.activeGroup.closeEditor(draft)).toBe(true);
    expect(await read('notes.md')).toBe('draft text');
    // The tab closes; no file editor is left in its place.
    expect(part.activeGroup.isEmpty).toBe(true);
    expect(draft.isDisposed()).toBe(true);
  });

  test('Close All Editors stops at a Cancel: that group and the groups after it keep their editors', async () => {
    const left = part.activeGroup;
    const first = await openUntitled('one', left);
    const right = part.addGroup(left, GroupDirection.RIGHT);
    const second = await openUntitled('two', right);
    const third = await openUntitled('three', right);
    const down = part.addGroup(right, GroupDirection.DOWN);
    const fourth = await openUntitled('four', down);
    dialogs.confirmAnswers.push(ConfirmResult.DONT_SAVE, ConfirmResult.CANCEL);
    await service(ICommandService).executeCommand('workbench.action.closeAllEditors');
    expect(dialogs.confirms).toEqual([['Untitled-1'], ['Untitled-2']]);
    expect(first.isDisposed()).toBe(true);
    expect(right.editors).toEqual([second, third]);
    expect(down.editors).toEqual([fourth]);
    expect([second, third, fourth].map(editor => editor.model.getValue())).toEqual(['two', 'three', 'four']);
  });
});

test('startup reuses file tabs opened during recovery and leaves the active group, editor and focus in place', async () => {
  const { FileBackupRestorer } = await import('../../browser/fileBackupRestorer.js');
  const textFiles = service(ITextFileService) as BrowserTextFileService;
  const meta = { etag: undefined, bom: false };
  await textFiles.backups.write(file('a.md'), 'existing draft', meta);
  await textFiles.backups.write(file('missing.md'), 'tabless draft', meta);
  const resume = new DeferredPromise<void>();
  const listRestorable = textFiles.backups.listRestorable.bind(textFiles.backups);
  vi.spyOn(textFiles.backups, 'listRestorable').mockImplementationOnce(async () => {
    await resume.p;
    return listRestorable();
  });
  instantiation.createInstance(FileBackupRestorer);

  const left = part.activeGroup;
  const leftInput = await openFile('a.md', left);
  const right = part.addGroup(left, GroupDirection.RIGHT);
  const rightInput = await openFile('a.md', right);
  const active = await openFile('b.md', right);
  const focus = document.body.appendChild(document.createElement('button'));
  disposables.add({ dispose: () => focus.remove() });
  focus.focus();
  await resume.complete();

  await vi.waitFor(() => expect(names(right.editors)).toEqual(['a.md', 'b.md', 'missing.md']));
  expect(left.editors).toEqual([leftInput]);
  expect(right.editors.slice(0, 2)).toEqual([rightInput, active]);
  expect(part.activeGroup).toBe(right);
  expect(right.activeEditor).toBe(active);
  expect(document.activeElement).toBe(focus);
  expect(leftInput.isDirty()).toBe(true);
  expect(rightInput.isDirty()).toBe(true);
  await right.editors[2].resolve();
  expect(textFiles.files.get(file('missing.md'))?.textEditorModel?.getValue()).toBe('tabless draft');
});

test('startup does not reopen a file whose draft went while the list was read', async () => {
  const { FileBackupRestorer } = await import('../../browser/fileBackupRestorer.js');
  const textFiles = service(ITextFileService) as BrowserTextFileService;
  // The list names a draft that a Save or Don't Save removed before the tabs were checked.
  vi.spyOn(textFiles.backups, 'listRestorable').mockResolvedValueOnce([file('a.md')]);
  const hasRestorable = vi.spyOn(textFiles.backups, 'hasRestorable');
  instantiation.createInstance(FileBackupRestorer);

  await vi.waitFor(() => expect(hasRestorable).toHaveBeenCalledWith(file('a.md')));
  expect(await hasRestorable.mock.results[0].value).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(part.activeGroup.editors).toEqual([]);
});

test('a temporary draft read failure shows an error and reopening recovers the draft', async () => {
  const textFiles = service(ITextFileService) as BrowserTextFileService;
  const resource = file('a.md');
  await textFiles.backups.write(resource, 'unsaved and irreplaceable', { etag: undefined, bom: false });
  const location = textFiles.backups.backupResource(resource);
  const readFile = files.readFile.bind(files);
  const reading = vi.spyOn(files, 'readFile').mockImplementation(async (target, options) => {
    if (target.toString() === location.toString()) {
      throw new Error('Storage is busy');
    }
    return readFile(target, options);
  });

  const input = instantiation.createInstance(FileEditorInput, resource, { restoredDirty: true });
  await part.activeGroup.openEditor(input);
  expect(document.querySelector('.file-error-editor [role="alert"]')?.textContent)
    .toContain('The unsaved draft could not be read. Reopen the file or reload to try again.');
  expect(textFiles.files.get(resource)).toBeUndefined();
  expect(await files.exists(location)).toBe(true);
  expect(await read('a.md')).toBe('alpha');
  expect(await part.activeGroup.closeEditor(input)).toBe(true);

  reading.mockRestore();
  const reopened = await openFile('a.md');
  expect(reopened.isDirty()).toBe(true);
  expect(textFiles.files.get(resource)?.textEditorModel?.getValue()).toBe('unsaved and irreplaceable');
});

describe('Explorer deletion of files with drafts outside the editor groups', () => {
  const write = (path: string) => files.writeFile(file(path), new TextEncoder().encode(path));
  const draftText = (path: string) => `draft of ${path}`;

  async function prepare(target: string, paths: readonly string[]) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const textFiles = service(ITextFileService) as BrowserTextFileService;
    await Promise.all(paths.map(write));
    const models = [];
    for (const path of paths) {
      const reference = await textFiles.resolve(file(path));
      const model = textFiles.files.get(file(path))!;
      reference.textEditorModel!.setValue(draftText(path));
      reference.dispose();
      models.push(model);
    }
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY + 10);
    for (const path of paths) {
      expect((await textFiles.backups.read(file(path)))?.value).toBe(draftText(path));
    }

    const explorer = disposables.add(instantiation.createInstance(ExplorerService));
    await explorer.resolveFolder(explorer.root);
    expect(await explorer.select(file(target))).toBe(true);
    const quickInput = { pick: vi.fn().mockResolvedValue({ id: 'delete' }) };
    const remove = () => deleteItem({ explorer, fileService: files, textFiles, quickInput, groups: part }, explorer.selection!);
    return { explorer, models, remove, textFiles };
  }

  test.each([
    { target: 'a.md', paths: ['a.md'], sibling: 'b.md' },
    { target: 'a', paths: ['a/first.md', 'a/sub/second.md'], sibling: 'ab/sibling.md' },
  ])('a refused deletion of $target preserves its drafts and a retry removes only those drafts', async ({ target, paths, sibling }) => {
    const { explorer, models, remove, textFiles } = await prepare(target, [...paths, sibling]);
    expect(part.activeGroup.isEmpty).toBe(true);
    const error = vi.spyOn(explorer, 'showError').mockImplementation(() => {});
    const focus = vi.spyOn(explorer, 'focusView');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(provider, 'delete').mockRejectedValueOnce(new Error('Storage is busy'));

    await remove();
    expect(error).toHaveBeenCalledWith(`Unable to delete '${target}': Storage is busy`);
    expect(focus).toHaveBeenCalledOnce();
    expect(explorer.selection?.resource.toString()).toBe(file(target).toString());
    for (const [index, path] of paths.entries()) {
      expect(await read(path)).toBe(path);
      expect(textFiles.files.get(file(path))).toBe(models[index]);
      expect(models[index].isDirty()).toBe(true);
      expect(models[index].textEditorModel?.getValue()).toBe(draftText(path));
      expect((await textFiles.backups.read(file(path)))?.value).toBe(draftText(path));
    }

    const reveals = vi.fn();
    disposables.add(explorer.onDidRequestReveal(reveals));
    await remove();
    for (const [index, path] of paths.entries()) {
      expect(await exists(path)).toBe(false);
      expect(models[index].isDirty()).toBe(false);
      expect(await textFiles.backups.read(file(path))).toBeUndefined();
      expect(textFiles.files.get(file(path))).toBeUndefined();
    }
    expect(await read(sibling)).toBe(sibling);
    expect(models.at(-1)?.isDirty()).toBe(true);
    expect((await textFiles.backups.read(file(sibling)))?.value).toBe(draftText(sibling));
    const selection = explorer.selection;
    expect(selection?.name).toBe(target === 'a.md' ? sibling : 'ab');
    expect(reveals).toHaveBeenCalledWith({ item: selection, focus: true });
  });

  test('a draft edited while the provider is deleting the file remains recoverable', async () => {
    const path = 'a.md';
    const { models: [model], remove, textFiles } = await prepare(path, [path]);
    const del = provider.delete.bind(provider);
    vi.spyOn(provider, 'delete').mockImplementationOnce(async (resource, options) => {
      model.textEditorModel!.setValue('edited while deleting');
      await del(resource, options);
    });

    await remove();
    await vi.advanceTimersByTimeAsync(BACKUP_DELAY + 10);
    expect(await exists(path)).toBe(false);
    expect(model.isDirty()).toBe(true);
    expect((await textFiles.backups.read(file(path)))?.value).toBe('edited while deleting');
  });

  test('a failed draft discard after deletion still refreshes and moves the selection', async () => {
    const path = 'a.md';
    const { explorer, models: [model], remove, textFiles } = await prepare(path, [path]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(model, 'revert').mockRejectedValueOnce(new Error('Could not discard'));

    await remove();
    expect(await exists(path)).toBe(false);
    expect(explorer.find(file(path))).toBeUndefined();
    expect(explorer.selection?.name).toBe('b.md');
    expect((await textFiles.backups.read(file(path)))?.value).toBe(draftText(path));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not discard the draft'), expect.any(Error));
  });
});

describe('saving untitled text and Save As', () => {
  test('Save puts the file editor in the untitled editor’s place in every group, and the untitled tab goes', async () => {
    const left = part.activeGroup;
    await openFile('a.md', left);
    const draft = await openUntitled('# saved draft', left);
    await openFile('b.md', left);
    await left.openEditor(draft);
    const right = part.addGroup(left, GroupDirection.RIGHT);
    left.copyEditor(draft, right);
    part.activateGroup(left);
    dialogs.saveAnswers.push(file('draft.md'));

    await service(ICommandService).executeCommand('workbench.action.files.save');
    expect(await read('draft.md')).toBe('# saved draft');
    expect(names(left.editors)).toEqual(['a.md', 'draft.md', 'b.md']);
    expect(left.activeEditor?.resource?.toString()).toBe(file('draft.md').toString());
    expect(left.activeEditor).toBeInstanceOf(FileEditorInput);
    expect(names(right.editors)).toEqual(['draft.md']);
    expect(draft.isDisposed()).toBe(true);
    expect(service(IEditorService).editors.some(editor => editor instanceof UntitledTextEditorInput)).toBe(false);
  });

  test('a cancelled Save of untitled text changes nothing', async () => {
    const draft = await openUntitled('keep me');
    await service(ICommandService).executeCommand('workbench.action.files.save');
    expect(dialogs.saveDialogs).toHaveLength(1);
    expect(part.activeGroup.editors).toEqual([draft]);
    expect(draft.model.getValue()).toBe('keep me');
  });

  test('Save As of a dirty file writes the copy, leaves the original as saved, and opens the copy in its place', async () => {
    const original = await openFile('a.md');
    await type(original, 'edited');
    dialogs.saveAnswers.push(file('copy.md'));
    await service(ICommandService).executeCommand('workbench.action.files.saveAs');
    expect(dialogs.saveDialogs[0].defaultUri?.toString()).toBe(file('a.md').toString());
    expect(await read('copy.md')).toBe('edited');
    expect(await read('a.md')).toBe('alpha');
    expect(names(part.activeGroup.editors)).toEqual(['copy.md']);
    expect(original.isDisposed()).toBe(true);
  });

  test('Save As onto an open file puts the text in that file’s model and saves it', async () => {
    const target = await openFile('b.md');
    const draft = await openUntitled('replacement');
    dialogs.saveAnswers.push(file('b.md'));
    await service(IEditorService).save({ groupId: part.activeGroup.id, editor: draft }, { saveAs: true });
    expect(await read('b.md')).toBe('replacement');
    expect(target.isDirty()).toBe(false);
    expect(names(part.activeGroup.editors)).toEqual(['b.md']);
  });

  test('Save All saves the dirty files, then asks for each untitled text, and stops at a cancelled path', async () => {
    const a = await openFile('a.md');
    await type(a, 'A!');
    const b = await openFile('b.md');
    const right = part.addGroup(part.activeGroup, GroupDirection.RIGHT);
    part.activeGroup.copyEditor(a, right);
    const first = await openUntitled('first');
    const second = await openUntitled('second');
    const third = await openUntitled('third');
    dialogs.saveAnswers.push(file('first.md'), undefined);
    await service(ICommandService).executeCommand('saveAll');
    expect(await read('a.md')).toBe('A!');
    expect(b.isDirty()).toBe(false);
    expect(await read('first.md')).toBe('first');
    expect(dialogs.saveDialogs).toHaveLength(2);
    expect(await exists('third.md')).toBe(false);
    expect(first.isDisposed()).toBe(true);
    expect([second.isDisposed(), third.isDisposed()]).toEqual([false, false]);
  });

  test('Revert File reads the file again', async () => {
    const input = await openFile('a.md');
    await type(input, 'unsaved');
    await service(ICommandService).executeCommand('workbench.action.files.revert');
    expect(input.isDirty()).toBe(false);
    expect(service(ITextFileService).files.get(file('a.md'))!.textEditorModel!.getValue()).toBe('alpha');
  });

  test('New File... creates an empty file where the dialog says and opens it', async () => {
    dialogs.saveAnswers.push(file('fresh.md'));
    await service(ICommandService).executeCommand('workbench.action.files.newFile');
    expect(dialogs.saveDialogs[0]).toMatchObject({ title: 'Create File', saveLabel: 'Create File' });
    expect(dialogs.saveDialogs[0].defaultUri?.toString()).toBe(file('Untitled.txt').toString());
    expect(await read('fresh.md')).toBe('');
    expect(part.activeGroup.activeEditor?.resource?.toString()).toBe(file('fresh.md').toString());
  });
});

describe('the File menu and the keys', () => {
  test('the File menu has New File..., Save, Save As..., Save All and Revert File in VS Code’s groups', () => {
    const items = MenuRegistry.getMenuItems(MenuId.MenubarFileMenu)
      .flatMap(item => 'command' in item ? [`${item.group}:${item.order}:${item.command.id}`] : []);
    expect(items).toEqual(expect.arrayContaining([
      '1_new:1:workbench.action.files.newUntitledFile',
      '1_new:2:workbench.action.files.newFile',
      '4_save:1:workbench.action.files.save',
      '4_save:2:workbench.action.files.saveAs',
      '4_save:3:saveAll',
      '6_close:1:workbench.action.files.revert',
    ]));
  });

  test('the file commands bind Cmd on macOS and Ctrl elsewhere, as VS Code declares them for the web', () => {
    const rules = KeybindingsRegistry.getDefaultKeybindings();
    const label = (id: string, platform: 'mac' | 'linux' | 'win') => {
      const keybinding = new KeybindingResolver(rules, platform).lookupKeybinding(id);
      return keybinding && formatKeybinding(keybinding, platform);
    };
    expect(['mac', 'linux', 'win'].map(platform => label('workbench.action.files.saveAs', platform as 'mac')))
      .toEqual(['⇧⌘S', 'Ctrl+Shift+S', 'Ctrl+Shift+S']);
    expect(['mac', 'linux', 'win'].map(platform => label('saveAll', platform as 'mac'))).toEqual(['⌥⌘S', undefined, 'Ctrl+K S']);
    expect(label('workbench.action.files.newFile', 'mac')).toBe('⌃⌥⌘N');
    expect(label('workbench.action.files.newFile', 'linux')).toBe('Ctrl+Alt+Super+N');
    expect(label('workbench.action.files.revert', 'linux')).toBeUndefined();
  });
});
