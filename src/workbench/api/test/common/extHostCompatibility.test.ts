// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { MainThreadRuntimeProxy } from '../../common/extHost.protocol.runtime.js';
import type { MainThreadRuntimeShape } from '../../common/extHost.protocol.runtime.js';
import { createTestExtensionApi } from './testExtensionHost.js';

test('accepts an external URI opener without ever asking it', async () => {
  const host = await createTestExtensionApi();
  try {
    const $openExternal = vi.fn(async () => true);
    host.main.set(MainThreadRuntimeProxy, { $openExternal } as Partial<MainThreadRuntimeShape> as MainThreadRuntimeShape);
    const opener = { canOpenExternalUri: vi.fn(), openExternalUri: vi.fn() };
    const registration = host.api.window.registerExternalUriOpener('fixture.opener', opener, {
      schemes: ['http', 'https'], label: 'Fixture',
    });
    host.context.subscriptions.push(registration);
    expect(typeof registration.dispose).toBe('function');
    expect(host.api.ExternalUriOpenerPriority).toEqual({ None: 0, Option: 1, Default: 2, Preferred: 3 });
    // With the opener registered for http, openExternal still goes straight to the main thread.
    await expect(host.api.env.openExternal(host.api.Uri.parse('http://localhost:3000/'))).resolves.toBe(true);
    expect($openExternal).toHaveBeenCalledOnce();
    expect(opener.canOpenExternalUri).not.toHaveBeenCalled();
    expect(opener.openExternalUri).not.toHaveBeenCalled();
    registration.dispose();
  } finally {
    host.dispose();
  }
});
