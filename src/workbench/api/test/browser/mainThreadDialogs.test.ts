import { beforeEach, describe, expect, test } from 'vitest';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import type { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { ConfirmResult } from '../../../common/editor/editorInput.js';
import type { IFileDialogService, IOpenDialogOptions, ISaveDialogOptions } from '../../../services/dialogs/common/dialogs.js';
import { MainThreadDialogs } from '../../browser/mainThreadDialogs.js';

const root = URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace' });
const file = (path: string) => URI.joinPath(root, path);
const folder: IWorkspaceFolder = { uri: root, name: 'workspace', index: 0, toResource: path => URI.joinPath(root, path) };
const workspace: IWorkspaceContextService = {
  _serviceBrand: undefined,
  onDidChangeWorkspaceFolders: Event.None,
  getWorkbenchState: () => 2,
  getWorkspace: () => ({ id: 'test', folders: [folder] }),
  getWorkspaceFolder: () => folder,
};

let opened: IOpenDialogOptions[];
let saved: ISaveDialogOptions[];
let openResult: URI[] | undefined;
let saveResult: URI | undefined;
let registered: boolean;
let main: MainThreadDialogs;

beforeEach(() => {
  opened = [];
  saved = [];
  openResult = undefined;
  saveResult = undefined;
  registered = true;
  const dialogs: IFileDialogService = {
    _serviceBrand: undefined,
    defaultFilePath: () => file('docs'),
    showSaveConfirm: async () => ConfirmResult.CANCEL,
    pickFileToSave: async () => undefined,
    showSaveDialog: async options => {
      saved.push(options);
      return saveResult;
    },
    showOpenDialog: async options => {
      opened.push(options);
      return openResult;
    },
  };
  main = new MainThreadDialogs(dialogs, workspace, () => registered);
});

describe('options', () => {
  test('are passed on checked: defaults as VS Code, a defaultUri outside the workspace moved to the default folder', async () => {
    await main.$showOpenDialog('ext', { canSelectMany: true, filters: { Markdown: ['md', 'markdown'] }, title: '', openLabel: 'Use' });
    expect(opened[0]).toEqual({
      defaultUri: file('docs'), openLabel: 'Use', canSelectFiles: undefined, canSelectFolders: undefined, canSelectMany: true,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }], title: undefined,
    });
    await main.$showSaveDialog('ext', { defaultUri: URI.parse('file:///etc/passwd'), saveLabel: 'Keep' });
    await main.$showSaveDialog('ext', { defaultUri: URI.parse('vscode-vfs://writing-room/workspace/../outside.md') });
    await main.$showSaveDialog('ext', { defaultUri: file('notes.md') });
    // Outside, only the name is kept, in the default folder.
    expect(saved.map(options => options.defaultUri?.toString())).toEqual([
      file('docs/passwd').toString(), file('docs/outside.md').toString(), file('notes.md').toString(),
    ]);
    await main.$showSaveDialog('ext', { defaultUri: URI.parse('file:///') });
    expect(saved.at(-1)?.defaultUri?.toString()).toBe(file('docs').toString());
    expect(saved[0].saveLabel).toBe('Keep');
  });

  test.each([
    ['not an object', 'options must be an object'],
    [{ canSelectMany: 'yes' }, 'canSelectMany must be a boolean'],
    [{ title: 7 }, 'title must be a string'],
    [{ title: 'x'.repeat(1025) }, 'title must be a string'],
    [{ filters: ['md'] }, 'filters must be an object'],
    [{ filters: { Markdown: 'md' } }, 'each filter must name a list'],
    [{ filters: { Markdown: [1] } }, 'each filter must name a list'],
    [{ defaultUri: { scheme: 'vscode-vfs', path: '/workspace' } }, 'defaultUri must be a Uri'],
  ])('a malformed value is refused: %j', async (options, message) => {
    await expect(main.$showOpenDialog('ext', options as never)).rejects.toThrow(message);
    expect(opened).toEqual([]);
  });
});

describe('results', () => {
  test('come back only when every URI is a normalized workspace path; the open dialog gives a list', async () => {
    openResult = [file('a.md'), file('docs/b.md')];
    expect(await main.$showOpenDialog('ext', { canSelectMany: true })).toEqual([file('a.md'), file('docs/b.md')]);
    openResult = [file('a.md')];
    expect(await main.$showOpenDialog('ext', { canSelectMany: false })).toEqual([file('a.md')]);
    for (const outside of [
      URI.parse('file:///workspace/a.md'),
      URI.from({ scheme: 'vscode-vfs', authority: 'other', path: '/workspace/a.md' }),
      URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace/../secret.md' }),
      URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/elsewhere/a.md' }),
      URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace/a.md', query: 'x' }),
      URI.from({ scheme: 'vscode-userdata', path: '/User/globalStorage/other/x' }),
    ]) {
      saveResult = outside;
      expect(await main.$showSaveDialog('ext'), outside.toString()).toBeUndefined();
      openResult = [file('a.md'), outside];
      expect(await main.$showOpenDialog('ext'), outside.toString()).toBeUndefined();
    }
    saveResult = file('docs/new.md');
    expect(await main.$showSaveDialog('ext')).toEqual(file('docs/new.md'));
  });

  test('an extension that is not installed (any more) gets nothing', async () => {
    registered = false;
    expect(await main.$showOpenDialog('gone', {})).toBeUndefined();
    expect(opened).toEqual([]);
    registered = true;
    saveResult = file('a.md');
    const pending = main.$showSaveDialog('ext');
    registered = false;
    expect(await pending).toBeUndefined();
  });
});
