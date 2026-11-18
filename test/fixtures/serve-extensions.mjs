import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const port = Number(process.argv[2]);
const fixture = file => readFileSync(new URL('./extensions/remote/' + file, import.meta.url));
const manifest = fixture('package.json');
const code = fixture('extension.js');
const icon = fixture('icon.png');

createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  if (pathname !== '/no-cors/package.json') {
    response.setHeader('Access-Control-Allow-Origin', '*');
  }
  response.setHeader('Cache-Control', 'no-store');
  if (pathname === '/redirect/package.json') {
    response.writeHead(302, { Location: '/remote/package.json' }).end();
  } else if (pathname === '/oversize/package.json') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write(' '.repeat(256 * 1024));
    response.end(manifest);
  } else if (pathname === '/oversize-entry/package.json') {
    const larger = { ...JSON.parse(manifest), name: 'oversize-entry' };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(larger));
  } else if (pathname === '/oversize-entry/extension.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.write(' '.repeat(5 * 1024 * 1024));
    response.end(code);
  } else if (pathname === '/remote/package.json' || pathname === '/no-cors/package.json') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(manifest);
  } else if (pathname === '/remote/extension.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
  } else if (pathname === '/remote/icon.png' || pathname === '/oversize-entry/icon.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' }).end(icon);
  } else {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => process.stdout.write(`Extension fixtures listening on ${port}\n`));
