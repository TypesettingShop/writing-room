// @vitest-environment node
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

function request(port: number, path: string): Promise<{ status?: number; type?: string; body: string }> {
  return new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port, path }, response => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'], body }));
    }).once('error', reject);
  });
}

test('serves named fixtures and route modules while refusing paths outside a fixture', async () => {
  const script = fileURLToPath(new URL('../../../../../../test/fixtures/serve-extensions.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      lines.once('line', line => {
        const match = /^Extension fixtures listening on (\d+)$/.exec(line);
        if (match) {
          resolve(Number(match[1]));
        } else {
          reject(new Error(line));
        }
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Fixture server exited with code ' + code)));
    });
    expect(await request(port, '/foundation/browser/extension.js')).toMatchObject({ status: 200, type: 'text/javascript' });
    expect(await request(port, '/fixture/foundation/status')).toMatchObject({ status: 200, body: '{"ready":true}' });
    for (const path of ['/foundation/../remote/package.json', '/foundation/browser%2fextension.js', '/foundation/browser%5cextension.js']) {
      expect((await request(port, path)).status).toBe(404);
    }
    expect((await request(port, '/redirect/package.json')).status).toBe(302);
  } finally {
    lines.close();
    child.kill();
  }
});
