import { expect, it, vi } from 'vitest';
import { Event } from '../../../../../base/common/event.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { MainThreadWebviews } from '../../../../api/browser/mainThreadWebviews.js';
import type { ExtHostWebviewsShape } from '../../../../api/common/extHost.protocol.webview.js';
import type { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { HostExtensionDescription } from '../../../../services/extensions/common/extensionHostProtocol.js';
import { WebviewEditorInput } from '../../../webviewPanel/browser/webviewEditorInput.js';
import type { IWebviewPanelRestoreService } from '../../../webviewPanel/browser/webviewPanelRestoreService.js';
import type { IWebviewOriginService } from '../../browser/webviewOriginService.js';
import type { WebviewOrigin } from '../../common/webviewOrigin.js';
import { WebviewOverlay } from '../../browser/webviewOverlay.js';
import { WebviewStateStore } from '../../browser/webviewStateStore.js';

function setup() {
  const origin = { origin: 'https://shell.example.test' };
  const overlay = {
    isVisible: true,
    setContent: vi.fn(),
    postMessage: vi.fn().mockResolvedValue(true),
    onDidReceiveMessage: Event.None,
    onDidChangeState: Event.None,
    resetForRestore: vi.fn(),
    setState: vi.fn(),
    setOrigin: vi.fn(),
    dispose: vi.fn(),
  };
  let input: WebviewEditorInput | undefined;
  const group = {
    id: 1,
    contains: (editor: WebviewEditorInput) => editor === input,
    openEditor: async (editor: WebviewEditorInput) => { input = editor; },
  };
  const groups = {
    activeGroup: group, groups: [group], getGroups: () => [group],
    onDidAddGroup: Event.None, onDidRemoveGroup: Event.None, onDidMoveGroup: Event.None,
  } as unknown as IEditorGroupsService;
  const editors = {
    onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, onDidCloseEditor: Event.None,
  } as unknown as IEditorService;
  const storage = new InMemoryStorageService();
  const states = new WebviewStateStore(storage);
  const instantiation = {
    createInstance: (constructor: unknown, ...args: unknown[]) => {
      if (constructor === WebviewOverlay) {
        return overlay;
      }
      const [id, owner, type, title, options, webview, persistent] = args as ParametersForInput;
      return new WebviewEditorInput(id, owner, type, title, options, webview, persistent, states);
    },
  } as IInstantiationService;
  const proxy = {
    $deserializePanel: vi.fn().mockResolvedValue(undefined),
    $onPanelViewState: async () => {},
    $onPanelDisposed: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtHostWebviewsShape;
  const workspace = { getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService;
  const extension = (key: string): HostExtensionDescription => ({
    id: 'fixture.' + key, key, location: 'https://extensions.example.test/' + key + '/', entry: '',
    manifest: { name: key, publisher: 'fixture', version: '1.0.0' }, activationEvents: [],
  });
  const owners = new Map(['first', 'second'].map(key => [key, extension(key)]));
  const restore = {
    _serviceBrand: undefined,
    register: vi.fn((..._args: Parameters<IWebviewPanelRestoreService['register']>) => ({ dispose: vi.fn() })),
    show: vi.fn(),
  };
  const origins = {
    _serviceBrand: undefined,
    getForwardingHint: () => undefined,
    resolve: vi.fn<IWebviewOriginService['resolve']>().mockResolvedValue(origin),
  };
  const startHost = () => new MainThreadWebviews(proxy, key => owners.get(key), instantiation, groups, editors,
    workspace, restore, states, origins);
  const handle = '00000000-0000-4000-8000-000000000001';
  const createRestorable = () => {
    input = new WebviewEditorInput(handle, extension('first').id, 'fixture.panel', 'Restorable', {},
      overlay as unknown as WebviewOverlay, true, states);
    return input;
  };
  return { overlay, storage, proxy, restore, origins, origin, handle, startHost, createRestorable, getInput: () => input };
}

it('authorizes panel operations by the extension that created the handle', async () => {
  const { overlay, storage, handle, startHost, getInput } = setup();
  const main = startHost();
  try {
    await main.$createPanel('first', handle, 'fixture.panel', 'Owned', {}, {}, {});
    await main.$setHtml('first', handle, '<p>Owner content</p>');
    await main.$setHtml('second', handle, '<p>Foreign content</p>');
    await main.$disposePanel('second', handle);
    expect(await main.$postMessage('second', handle, 1)).toBe(false);
    expect(overlay.postMessage).not.toHaveBeenCalled();
    expect(overlay.setContent).toHaveBeenLastCalledWith('<p>Owner content</p>', expect.objectContaining({
      localResourceRoots: [expect.objectContaining({ scheme: 'https', authority: 'extensions.example.test', path: '/first' })],
    }));
    expect(getInput()?.isDisposed()).toBe(false);
    await main.$disposePanel('first', handle);
    expect(getInput()?.isDisposed()).toBe(true);
  } finally {
    main.dispose();
    storage.dispose();
  }
});

it('restarts a pending restore with the new host before origin resolution returns', async () => {
  const { overlay, storage, proxy, restore, origins, origin, startHost, createRestorable } = setup();
  let finishOrigin!: (origin: WebviewOrigin) => void;
  origins.resolve.mockImplementationOnce(() => new Promise(resolve => { finishOrigin = resolve; }));
  const input = createRestorable();
  input.markForRestore();
  const first = startHost();
  const second = startHost();
  try {
    await first.$registerPanelSerializer('first', input.viewType);
    const previous = input.restoreGeneration!;
    const oldRestore = restore.register.mock.calls[0][2](input, previous);
    expect(origins.resolve).toHaveBeenCalledOnce();

    first.dispose();
    expect(input.restoreGeneration).toBe(previous + 1);
    expect(restore.show).toHaveBeenCalledWith(input);
    await second.$registerPanelSerializer('first', input.viewType);
    const current = input.restoreGeneration!;
    await restore.register.mock.calls[1][2](input, current);

    finishOrigin({ origin: 'https://old-shell.example.test' });
    await oldRestore;
    expect(overlay.setOrigin).toHaveBeenCalledExactlyOnceWith(origin);
    expect(proxy.$deserializePanel).toHaveBeenCalledOnce();
    expect(proxy.$deserializePanel).toHaveBeenCalledWith('first', expect.any(String),
      expect.objectContaining({ id: input.id }), origin, expect.anything());
  } finally {
    second.dispose();
    input.dispose();
    storage.dispose();
  }
});

type ParametersForInput = [
  string, string, string, string, WebviewEditorInput['options'], WebviewOverlay, boolean,
];
