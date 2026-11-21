// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { ExtHostWebviewsProxy, MainThreadWebviewsProxy } from '../../common/extHost.protocol.webview.js';
import type { MainThreadWebviewsShape } from '../../common/extHost.protocol.webview.js';
import { createTestExtensionApi } from './testExtensionHost.js';

test('closes a panel waiting for the workbench before its extension subscriptions are released', async () => {
  const host = await createTestExtensionApi();
  const createPanel = vi.fn(() => new Promise<void>(() => {}));
  const closed = vi.fn();
  host.main.set<Pick<MainThreadWebviewsShape, '$createPanel'>>(MainThreadWebviewsProxy, { $createPanel: createPanel });
  try {
    const panel = host.api.window.createWebviewPanel('fixture.pending', 'Pending', host.api.ViewColumn.One);
    host.context.subscriptions.push(panel.onDidDispose(() => {
      closed();
      panel.dispose();
    }));
    await vi.waitFor(() => expect(createPanel).toHaveBeenCalledOnce());
    await host.main.getProxy(ExtHostWebviewsProxy).$prepareShutdown();
    expect(closed).toHaveBeenCalledOnce();
  } finally {
    host.dispose();
  }
  expect(closed).toHaveBeenCalledOnce();
});

test('reports a rejected panel creation even after the extension disposed the panel', async () => {
  const host = await createTestExtensionApi();
  let reject!: (error: Error) => void;
  const createPanel = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  host.main.set<Pick<MainThreadWebviewsShape, '$createPanel'>>(MainThreadWebviewsProxy, { $createPanel: createPanel });
  try {
    const panel = host.api.window.createWebviewPanel('fixture.rejected', 'Rejected', host.api.ViewColumn.One);
    await vi.waitFor(() => expect(createPanel).toHaveBeenCalledOnce());
    panel.dispose();
    reject(new Error('Invalid Webview panel.'));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Could not open Webview panel:',
      expect.objectContaining({ message: 'Invalid Webview panel.' })));
  } finally {
    host.dispose();
    errors.mockRestore();
  }
});
