const setupHelp = 'Webviews need a separate origin. See docs/extension-api-webview.md for origin setup.';

export type WebviewOrigin = { readonly origin: string } | { readonly error: string };

export function resolveWebviewOrigin(page: URL, template?: string, id: string = crypto.randomUUID()): WebviewOrigin {
  try {
    const candidate = template
      ? new URL(template.replaceAll('{{uuid}}', id))
      : loopbackPeer(page);
    if (candidate && candidate.origin !== page.origin
      && !candidate.username && !candidate.password
      && (candidate.protocol === 'https:' || (candidate.protocol === 'http:' && isLoopback(candidate)))) {
      return { origin: candidate.origin };
    }
  } catch {
    // A malformed template disables webviews on this page.
  }
  return { error: setupHelp };
}

function loopbackPeer(page: URL): URL | undefined {
  if (!isLoopback(page)) {
    return undefined;
  }
  const peer = new URL(page.origin);
  peer.hostname = page.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  return peer;
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}
