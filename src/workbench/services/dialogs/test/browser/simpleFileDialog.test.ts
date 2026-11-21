import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { IInputBox, IInputOptions, IPickOptions, IQuickInputButton, IQuickPick, IQuickInputService as IQuickInput, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextService as IWorkspace, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { ConfirmResult } from '../../../../common/editor/editorInput.js';
import { FileDialogService } from '../../browser/fileDialogService.js';
import { SimpleFileDialog } from '../../browser/simpleFileDialog.js';

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

type Question =
  | { readonly kind: 'pick'; readonly labels: string[]; readonly descriptions: (string | undefined)[]; readonly options: IPickOptions; readonly items: IQuickPickItem[] }
  | { readonly kind: 'input'; readonly options: IInputOptions };
type Answer = (question: Question) => unknown;

/** Answers each quick input with the next scripted answer; with none left, it is dismissed. */
class ScriptedQuickInput implements IQuickInput {
  declare readonly _serviceBrand: undefined;
  readonly questions: Question[] = [];
  readonly answers: Answer[] = [];

  async pick<T extends IQuickPickItem>(entries: readonly (T | IQuickPickSeparator)[], options: IPickOptions = {}): Promise<T | undefined> {
    const items = entries.filter((entry): entry is T => entry.type !== 'separator');
    const question: Question = {
      kind: 'pick', labels: items.map(item => item.label), descriptions: items.map(item => item.description), options, items,
    };
    this.questions.push(question);
    return this.answers.shift()?.(question) as T | undefined;
  }

  async input(options: IInputOptions = {}): Promise<string | undefined> {
    const question: Question = { kind: 'input', options };
    this.questions.push(question);
    return this.answers.shift()?.(question) as string | undefined;
  }

  // The dialog asks through `pick` and `input` only.
  readonly backButton: IQuickInputButton = { icon: 'arrow-left', tooltip: 'Back' };
  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> { throw new Error('The dialog does not create quick picks.'); }
  createInputBox(): IInputBox { throw new Error('The dialog does not create input boxes.'); }
  readonly quickAccess = { show(): void { throw new Error('The dialog does not use quick access.'); } };
}

const choose = (label: string): Answer => question => {
  if (question.kind !== 'pick') {
    throw new Error(`Expected a pick for ${label}`);
  }
  const item = question.items.find(candidate => candidate.label === label);
  if (!item) {
    throw new Error(`No ${label} in ${question.labels.join(', ')}`);
  }
  return item;
};
const type = (value: string): Answer => question => {
  if (question.kind !== 'input') {
    throw new Error(`Expected an input for ${value}`);
  }
  return value;
};
const dismiss: Answer = () => undefined;

let disposables: DisposableStore;
let files: FileService;
let quickInput: ScriptedQuickInput;
let dialog: SimpleFileDialog;
let instantiation: InstantiationService;

beforeEach(async () => {
  disposables = new DisposableStore();
  files = disposables.add(new FileService());
  files.registerProvider('vscode-vfs', disposables.add(new InMemoryFileSystemProvider()));
  quickInput = new ScriptedQuickInput();
  instantiation = new InstantiationService(new ServiceCollection(
    [IFileService, files], [IWorkspaceContextService, workspace], [IQuickInputService, quickInput],
  ));
  dialog = instantiation.createInstance(SimpleFileDialog);
  await files.createFolder(root);
  for (const path of ['b.md', 'a.txt', 'docs/one.md', 'docs/two.txt']) {
    await files.writeFile(file(path), new TextEncoder().encode(path));
  }
  await files.createFolder(file('docs/deep'));
});

afterEach(() => disposables.dispose());

const picks = () => quickInput.questions.filter(question => question.kind === 'pick');

describe('the open dialog', () => {
  test('lists folders, then files; walks into a folder and back with .., and gives a list even for one file', async () => {
    quickInput.answers.push(choose('docs/'), choose('..'), choose('docs/'), choose('one.md'));
    expect(await dialog.showOpenDialog({ canSelectMany: true })).toEqual([file('docs/one.md')]);
    const [top, inDocs] = picks();
    expect(top.labels).toEqual(['Type a Path...', 'docs/', 'a.txt', 'b.md']);
    expect(top.options.placeHolder).toContain('/workspace/');
    expect(inDocs.labels).toEqual(['Type a Path...', '..', 'deep/', 'one.md', 'two.txt']);
    expect(inDocs.options.title).toBe('Open File');
  });

  test('picks the folder it shows when folders are asked for, and does not list files then', async () => {
    quickInput.answers.push(choose('docs/'), choose('Use This'));
    expect(await dialog.showOpenDialog({ canSelectFolders: true, openLabel: 'Use This' })).toEqual([file('docs')]);
    expect(picks()[1].labels).toEqual(['Use This', 'Type a Path...', '..', 'deep/']);
    expect(picks()[1].descriptions[0]).toBe('/workspace/docs/');
  });

  test('lists only the files the filters let through, and starts in the folder of a default file', async () => {
    quickInput.answers.push(dismiss);
    expect(await dialog.showOpenDialog({ defaultUri: file('docs/one.md'), filters: [{ name: 'Markdown', extensions: ['MD'] }] })).toBeUndefined();
    expect(picks()[0].labels).toEqual(['Type a Path...', '..', 'deep/', 'one.md']);
  });

  test('a typed path is normalized and must be inside the workspace and exist', async () => {
    let validate: IInputOptions['validateInput'];
    quickInput.answers.push(choose('Type a Path...'), question => {
      validate = (question as { options: IInputOptions }).options.validateInput;
      return 'docs/sub/../one.md';
    });
    expect(await dialog.showOpenDialog({})).toEqual([file('docs/one.md')]);
    expect(await validate!('../../etc/passwd')).toBe('The path must be inside the workspace folder.');
    expect(await validate!('/workspace/../outside.md')).toBe('The path must be inside the workspace folder.');
    expect(await validate!('missing.md')).toBe('Please enter a path that exists.');
    expect(await validate!('b.md/')).toBe('Please enter a folder, not a file.');
    expect(await validate!('docs')).toBeUndefined();
  });

  test('a default place outside the workspace starts at the workspace folder; Escape gives nothing', async () => {
    quickInput.answers.push(dismiss);
    expect(await dialog.showOpenDialog({ defaultUri: URI.parse('vscode-userdata:/User/settings.json') })).toBeUndefined();
    expect(picks()[0].labels[1]).toBe('docs/');
    expect(quickInput.questions).toHaveLength(1);
  });
});

describe('the save dialog', () => {
  test('saves under the suggested name in the default folder at once', async () => {
    quickInput.answers.push(choose('Save'));
    expect(await dialog.showSaveDialog({ defaultUri: file('docs/new.md') })).toEqual(file('docs/new.md'));
    expect(picks()[0].labels.slice(0, 3)).toEqual(['Save', 'Type a Name or Path...', '..']);
    expect(picks()[0].descriptions[0]).toBe('/workspace/docs/new.md');
    expect(quickInput.questions).toHaveLength(1);
  });

  test('asks before it replaces a file: Cancel chooses again, Replace takes it', async () => {
    quickInput.answers.push(choose('b.md'), choose('Cancel'), choose('b.md'), choose('Replace'));
    expect(await dialog.showSaveDialog({ title: 'Save As', defaultUri: file('new.md') })).toEqual(file('b.md'));
    expect(quickInput.questions.map(question => question.kind === 'pick' ? question.options.title : 'input')).toEqual([
      'Save As', 'Save As: b.md already exists. Do you want to replace it?', 'Save As', 'Save As: b.md already exists. Do you want to replace it?',
    ]);
    expect(picks()[1].labels).toEqual(['Replace', 'Cancel']);
  });

  test('Escape on the replace question cancels the dialog', async () => {
    quickInput.answers.push(choose('Save'), dismiss);
    expect(await dialog.showSaveDialog({ defaultUri: file('b.md') })).toBeUndefined();
    expect(quickInput.questions).toHaveLength(2);
  });

  test('a typed name is checked, a typed folder is walked into, and a new file is not asked about', async () => {
    let validate: IInputOptions['validateInput'];
    quickInput.answers.push(choose('Type a Name or Path...'), question => {
      validate = (question as { options: IInputOptions }).options.validateInput;
      expect((question as { options: IInputOptions }).options.value).toBe('Untitled-1.md');
      return 'docs';
    }, choose('Type a Name or Path...'), type('fresh.md'));
    expect(await dialog.showSaveDialog({ defaultUri: file('Untitled-1.md') })).toEqual(file('docs/fresh.md'));
    expect(await validate!('bad\\name.md')).toMatch(/cannot hold/);
    expect(await validate!('nowhere/x.md')).toBe('Please enter a path that exists.');
    expect(await validate!('../x.md')).toBe('The path must be inside the workspace folder.');
    expect(await validate!('x'.repeat(256))).toMatch(/longer than 255/);
    expect(await validate!('..')).toBe('The path must be inside the workspace folder.');
    expect(await validate!('docs')).toBeUndefined();
    expect(await validate!('b.md')).toBeUndefined();
    expect(picks()[1].options.placeHolder).toContain('/workspace/docs/');
  });
});

describe('the save confirmation', () => {
  test('Save, Don’t Save and Cancel; a dismissed question cancels', async () => {
    const service = instantiation.createInstance(FileDialogService);
    quickInput.answers.push(choose('Save'), choose("Don't Save"), choose('Cancel'), dismiss);
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await service.showSaveConfirm(['notes.md']));
    }
    expect(results).toEqual([ConfirmResult.SAVE, ConfirmResult.DONT_SAVE, ConfirmResult.CANCEL, ConfirmResult.CANCEL]);
    expect(picks()[0]).toMatchObject({ labels: ['Save', "Don't Save", 'Cancel'], options: { title: 'Do you want to save the changes you made to notes.md?' } });
  });
});
