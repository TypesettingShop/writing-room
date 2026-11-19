const contents = /^\/webview\/content\/([\da-f-]{36})\/(\d+)$/;
const resources = '/webview/vscode-resource/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  const content = contents.exec(url.pathname);
  if (content && event.request.mode === 'navigate') {
    event.respondWith(loadContent(content, event));
  } else if (url.pathname.startsWith(resources)) {
    event.respondWith(loadResource(event, url));
  }
});

async function loadContent([, shellId, revision], event) {
  const result = await askShell(shellId, {
    type: 'load-content', revision: Number(revision), client: event.resultingClientId,
  }, event.request.signal);
  if (typeof result?.html !== 'string') {
    return response('Webview content is unavailable.', 404, 'text/plain');
  }
  return response(result.html, 200, 'text/html; charset=utf-8');
}

async function loadResource(event, url) {
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
    return response(null, 405);
  }
  const client = event.clientId && await self.clients.get(event.clientId);
  const content = client && contents.exec(new URL(client.url).pathname);
  if (!content || event.request.mode === 'navigate') {
    return response(null, 401);
  }
  const [, shellId, revision] = content;
  const result = await askShell(shellId, {
    type: 'resource', revision: Number(revision), client: client.id, path: url.pathname,
  }, event.request.signal);
  if (result?.status === 200 && typeof result.mime === 'string' && result.bytes instanceof Uint8Array) {
    return response(event.request.method === 'HEAD' ? null : result.bytes, 200, result.mime);
  }
  return response(null, result?.status === 401 || result?.status === 413 ? result.status : 404);
}

function response(body, status, type = 'application/octet-stream') {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function askShell(id, message, signal) {
  const windows = await self.clients.matchAll({ type: 'window' });
  const shell = windows.find(client => {
    const url = new URL(client.url);
    return url.pathname === '/webview/index.html' && url.searchParams.get('id') === id;
  });
  if (!shell || signal.aborted) {
    return;
  }
  return new Promise(resolve => {
    const { port1, port2 } = new MessageChannel();
    const finish = result => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      port1.close();
      resolve(result);
    };
    const cancel = () => {
      port1.postMessage({ type: 'cancel' });
      finish();
    };
    const timer = setTimeout(cancel, 10000);
    signal.addEventListener('abort', cancel, { once: true });
    port1.onmessage = event => finish(event.data);
    shell.postMessage(message, [port2]);
  });
}
