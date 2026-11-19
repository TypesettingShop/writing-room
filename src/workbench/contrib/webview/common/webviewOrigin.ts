import { fetchBoundedResource } from '../../../../base/parts/request/common/boundedFetch.js';

const setupHelp = 'Webviews need a separate origin. Set WRITING_ROOM_WEBVIEW_PORT for forwarded addresses. '
  + 'See docs/extension-api-webview.md for origin setup.';

export type WebviewOrigin = { readonly origin: string } | { readonly error: string };

export interface WebviewForwardingPorts {
  readonly appPort: number;
  readonly webviewPort: number;
}

export function resolveWebviewOrigin(
  page: URL, template?: string, id: string = crypto.randomUUID(), ports?: WebviewForwardingPorts,
): WebviewOrigin {
  try {
    const candidate = template
      ? new URL(template.replace(/\{\{uuid\}\}|\{uuid\}/g, id))
      : loopbackPeer(page) ?? forwardedPeer(page, ports);
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

function forwardedPeer(page: URL, ports: WebviewForwardingPorts | undefined): URL | undefined {
  if (!isPortConfiguration(ports)) {
    return undefined;
  }
  const pattern = new RegExp('(?<![0-9])' + ports.appPort + '(?![0-9])', 'g');
  const markers = [...page.hostname.matchAll(pattern)];
  if (markers.length !== 1) {
    return undefined;
  }
  const peer = new URL(page.origin);
  peer.hostname = page.hostname.replace(pattern, String(ports.webviewPort));
  return peer;
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isPortConfiguration(value: unknown): value is WebviewForwardingPorts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const { appPort, webviewPort } = value as Partial<WebviewForwardingPorts>;
  return Object.keys(value).length === 2 && isPort(appPort) && isPort(webviewPort) && appPort !== webviewPort;
}

export function needsWebviewForwarding(page: URL, template?: string): boolean {
  return !template && !isLoopback(page) && page.protocol === 'https:';
}

export function parseWebviewPortHint(value: string): WebviewForwardingPorts | undefined {
  const match = /^([0-9]+):([0-9]+)$/.exec(value);
  if (match) {
    const ports = { appPort: Number(match[1]), webviewPort: Number(match[2]) };
    return isPortConfiguration(ports) ? ports : undefined;
  }
  return undefined;
}

const forwarding = new Map<string, Promise<WebviewForwardingPorts | undefined>>();

export function getWebviewForwardingPorts(
  page: URL, template?: string, request: typeof fetch = fetch,
): Promise<WebviewForwardingPorts | undefined> {
  if (!needsWebviewForwarding(page, template)) {
    return Promise.resolve(undefined);
  }
  const existing = forwarding.get(page.origin);
  if (existing) {
    return existing;
  }
  const operation = fetchBoundedResource(new URL('/webview/config.json', page.origin), {
    limit: 4096,
    signal: AbortSignal.timeout(10_000),
    request: (url, options) => request(url, {
      ...options, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
    }),
  }).then(({ bytes }) => {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isPortConfiguration(value) ? value : undefined;
  }).catch(() => undefined).then(ports => {
    if (!ports) {
      forwarding.delete(page.origin);
    }
    return ports;
  });
  forwarding.set(page.origin, operation);
  return operation;
}
