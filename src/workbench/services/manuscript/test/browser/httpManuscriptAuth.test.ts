// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { HttpManuscriptAuth } from '../../browser/httpManuscriptAuth.js';
import type { ManuscriptFetch } from '../../browser/httpManuscriptStore.js';
import { ManuscriptStatus } from '../../browser/windowManuscriptService.js';

it.each([
  ['login', 200],
  ['signup', 201],
  ['logout', 204],
] as const)('bounds a stalled %s request and allows another attempt', async (action, successStatus) => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
  const fetch = vi.fn<ManuscriptFetch>().mockImplementationOnce((_path, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  })).mockResolvedValueOnce(new Response(null, { status: successStatus }));
  const status = new ManuscriptStatus();
  const auth = new HttpManuscriptAuth(status, fetch);
  const request = () => action === 'logout' ? auth.signOut() : auth.signIn('writer@example.test', 'test password', action === 'signup');
  try {
    const pending = request();
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetch).toHaveBeenCalledWith('/api/auth/' + action, expect.objectContaining({ signal: controller.signal }));
    const timedOut = expect(pending).rejects.toThrow('The account request timed out. Try again.');
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
    await timedOut;
    expect(status.signedIn).toBeUndefined();

    await request();
    expect(status.signedIn).toBe(action !== 'logout');
  } finally {
    timeout.mockRestore();
    status.dispose();
  }
});
