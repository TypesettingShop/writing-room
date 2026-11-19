// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { createTestExtensionApi } from './testExtensionHost.js';

test('accepts an external URI opener without ever asking it', async () => {
  const host = await createTestExtensionApi();
  try {
    const opener = { canOpenExternalUri: vi.fn(), openExternalUri: vi.fn() };
    const registration = host.api.window.registerExternalUriOpener('fixture.opener', opener, {
      schemes: ['http', 'https'], label: 'Fixture',
    });
    host.context.subscriptions.push(registration);
    expect(typeof registration.dispose).toBe('function');
    expect(host.api.ExternalUriOpenerPriority).toEqual({ None: 0, Option: 1, Default: 2, Preferred: 3 });
    registration.dispose();
    expect(opener.canOpenExternalUri).not.toHaveBeenCalled();
    expect(opener.openExternalUri).not.toHaveBeenCalled();
  } finally {
    host.dispose();
  }
});
