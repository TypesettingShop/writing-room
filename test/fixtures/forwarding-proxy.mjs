import { request } from 'node:http';
import { createServer } from 'node:https';

export async function openForwardingProxy(appPort, webviewPort, tls, fixturesPort) {
  const server = createServer(tls, (incoming, outgoing) => {
    const marker = /^(\d+)--/.exec(incoming.headers.host ?? '');
    const port = marker && Number(marker[1]);
    if (port !== appPort && port !== webviewPort) {
      outgoing.writeHead(404).end();
      return;
    }
    const fixturePrefix = '/__extension-fixtures';
    const fixture = fixturesPort && port === appPort && incoming.url?.startsWith(fixturePrefix + '/');
    const targetPort = fixture ? fixturesPort : port;
    const upstream = request({
      host: '127.0.0.1',
      port: targetPort,
      path: fixture ? incoming.url.slice(fixturePrefix.length) : incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: '127.0.0.1:' + targetPort },
    }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => outgoing.writeHead(502).end());
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())),
  };
}
