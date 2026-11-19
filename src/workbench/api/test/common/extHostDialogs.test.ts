// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { URI } from '../../../../base/common/uri.js';
import { ExtHostDialogs } from '../../common/extHostDialogs.js';
import type { MainThreadDialogsShape } from '../../common/extHost.protocol.dialogs.js';

test('sends only the documented options and gives back URIs, the open dialog always as a list', async () => {
  const picked = URI.parse('vscode-vfs://writing-room/workspace/a.md');
  const proxy: MainThreadDialogsShape = {
    $showOpenDialog: vi.fn(async () => [picked, 'not a uri'] as unknown as URI[]),
    $showSaveDialog: vi.fn(async () => picked),
  };
  const dialogs = new ExtHostDialogs(proxy);
  const defaultUri = URI.parse('vscode-vfs://writing-room/workspace');
  const options = { canSelectMany: true, title: 'Pick', defaultUri, extra: () => 'not cloneable', filters: { Markdown: ['md'] } };
  expect(await dialogs.showOpenDialog('ext', options)).toEqual([picked]);
  expect(proxy.$showOpenDialog).toHaveBeenCalledWith('ext', { canSelectMany: true, title: 'Pick', defaultUri, filters: { Markdown: ['md'] } });
  expect(await dialogs.showSaveDialog('ext', { saveLabel: 'Keep', openLabel: 'ignored' } as never)).toBe(picked);
  expect(proxy.$showSaveDialog).toHaveBeenCalledWith('ext', { saveLabel: 'Keep' });

  vi.mocked(proxy.$showOpenDialog).mockResolvedValueOnce(undefined);
  vi.mocked(proxy.$showSaveDialog).mockResolvedValueOnce({ scheme: 'vscode-vfs', path: '/x' } as unknown as URI);
  expect(await dialogs.showOpenDialog('ext')).toBeUndefined();
  expect(await dialogs.showSaveDialog('ext')).toBeUndefined();
  expect(proxy.$showOpenDialog).toHaveBeenLastCalledWith('ext', undefined);
});
