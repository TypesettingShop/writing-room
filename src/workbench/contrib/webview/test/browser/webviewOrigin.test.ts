import { describe, expect, it, vi } from 'vitest';
import { getWebviewForwardingPorts, resolveWebviewOrigin } from '../../browser/webviewOrigin.js';

describe('Webview origin', () => {
  it.each([
    ['http://127.0.0.1:5173/', 'http://localhost:5173'],
    ['http://localhost:5173/', 'http://127.0.0.1:5173'],
  ])('uses the loopback peer of %s', (page, origin) => {
    expect(resolveWebviewOrigin(new URL(page))).toEqual({ origin });
  });

  it('prefers the configured template and expands the id', () => {
    expect(resolveWebviewOrigin(new URL('http://127.0.0.1:5173/'), 'https://{{uuid}}.example.net/', 'pane'))
      .toEqual({ origin: 'https://pane.example.net' });
  });

  it.each(['http://localhost:5173/', 'https://user:pass@example.net/', 'data:text/plain,webview', 'bad-url'])(
    'rejects an invalid or same-origin template %s', template => {
      expect(resolveWebviewOrigin(new URL('http://localhost:5173/'), template)).toHaveProperty('error');
    },
  );

  it('requires a configured origin for a remote page', () => {
    expect(resolveWebviewOrigin(new URL('https://workbench.example.com/'))).toHaveProperty('error');
  });
});

describe('Webview forwarded origin', () => {
  const ports = { appPort: 5173, webviewPort: 5174 };
  it.each([
    ['5173--work.example.test', '5174--work.example.test'],
    ['code-5173-remote.example.test', 'code-5174-remote.example.test'],
  ])('replaces exactly one port marker on %s', (host, expected) => {
    expect(resolveWebviewOrigin(new URL('https://' + host + ':9001/path'), undefined, 'pane', ports))
      .toEqual({ origin: 'https://' + expected + ':9001' });
  });

  it.each(['15173--work.example.test', 'x51730.example.test', '5173--work-5173.example.test', 'work.example.test'])(
    'rejects a host with no unambiguous marker %s', host => {
      const result = resolveWebviewOrigin(new URL('https://' + host), undefined, 'pane', ports);
      expect(result).toEqual({ error: expect.stringContaining('WRITING_ROOM_WEBVIEW_PORT') });
    },
  );

  it('prefers the template and loopback branches', () => {
    expect(resolveWebviewOrigin(new URL('https://5173--work.example.test'), 'https://{{uuid}}.web.example.test', 'pane', ports))
      .toEqual({ origin: 'https://pane.web.example.test' });
    expect(resolveWebviewOrigin(new URL('http://127.0.0.1:5173'), undefined, 'pane', ports))
      .toEqual({ origin: 'http://localhost:5173' });
  });
});

describe('Webview forwarding configuration', () => {
  it('loads once without credentials or redirects', async () => {
    const page = new URL('https://5173--config.example.test/app');
    const data = { appPort: 5173, webviewPort: 5174 };
    const fetch = vi.fn(async () => Response.json(data));
    expect(await getWebviewForwardingPorts(page, undefined, fetch)).toEqual(data);
    expect(await getWebviewForwardingPorts(page, undefined, fetch)).toEqual(data);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL('/webview/config.json', page), expect.objectContaining({
      mode: 'same-origin', credentials: 'omit', redirect: 'error',
    }));
  });

  it.each([
    { appPort: '5173', webviewPort: 5174 },
    { appPort: 5173, webviewPort: 5173 },
    { appPort: 0, webviewPort: 5174 },
    { appPort: 5173, webviewPort: 65536 },
    { appPort: 5173.5, webviewPort: 5174 },
    { appPort: 5173, webviewPort: 5174, origin: 'https://untrusted.example' },
  ])('rejects malformed configuration %j', async (value) => {
    const page = new URL('https://' + crypto.randomUUID() + '.example.test');
    expect(await getWebviewForwardingPorts(page, undefined, async () => Response.json(value))).toBeUndefined();
  });

  it('cancels the response stream once it exceeds 4 KiB', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4097)); },
      cancel,
    });
    const page = new URL('https://large.example.test');
    expect(await getWebviewForwardingPorts(page, undefined, async () => new Response(body))).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('skips the request with a template or loopback page', async () => {
    const fetch = vi.fn();
    expect(await getWebviewForwardingPorts(new URL('https://work.example.test'), 'https://view.example.test', fetch)).toBeUndefined();
    expect(await getWebviewForwardingPorts(new URL('http://localhost:5173'), undefined, fetch)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
