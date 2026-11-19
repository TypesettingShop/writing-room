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
import { WebviewOverlay } from '../../browser/webviewOverlay.js';
import { WebviewStateStore } from '../../browser/webviewStateStore.js';

it('authorizes panel operations by the extension that created the handle', async () => {
  const overlay = {
    isVisible: true,
    setContent: vi.fn(),
    postMessage: vi.fn().mockResolvedValue(true),
    onDidReceiveMessage: Event.None,
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
    $getForwardingPorts: async () => undefined,
    $onPanelViewState: async () => {},
    $onPanelDisposed: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtHostWebviewsShape;
  const workspace = { getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService;
  const extension = (key: string): HostExtensionDescription => ({
    id: 'fixture.' + key, key, location: 'https://extensions.example.test/' + key + '/', entry: '',
    manifest: { name: key, publisher: 'fixture', version: '1.0.0' }, activationEvents: [],
  });
  const owners = new Map(['first', 'second'].map(key => [key, extension(key)]));
  const main = new MainThreadWebviews(proxy, key => owners.get(key), instantiation, groups, editors, workspace,
    {} as IWebviewPanelRestoreService, states);
  const handle = '00000000-0000-4000-8000-000000000001';
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
    expect(input?.isDisposed()).toBe(false);
    await main.$disposePanel('first', handle);
    expect(input?.isDisposed()).toBe(true);
  } finally {
    main.dispose();
    storage.dispose();
  }
});

type ParametersForInput = [
  string, string, string, string, WebviewEditorInput['options'], WebviewOverlay, boolean,
];
