import { describe, expect, it } from 'vitest';
import { resolveWebviewOrigin } from '../../browser/webviewOrigin.js';

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
