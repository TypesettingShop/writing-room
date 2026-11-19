import { createServer } from 'node:net';
import { defineConfig } from '@playwright/test';
import { checkCache } from './scripts/lib/real-extensions.mjs';

const host = '127.0.0.1';

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(error => {
        if (error) {
          reject(error);
        } else if (address && typeof address !== 'string') {
          resolve(address.port);
        } else {
          reject(new Error('A TCP port could not be allocated for Playwright.'));
        }
      });
    });
  });
}

const target = process.env.E2E_TARGET ?? 'dev';
if (target !== 'dev' && target !== 'preview') {
  throw new Error('E2E_TARGET must be dev or preview.');
}

// Playwright workers reload this config and inherit the runner's environment.
process.env.E2E_PORT ??= String(await findAvailablePort());
const port = Number(process.env.E2E_PORT);
if (process.env.E2E_EXTENSIONS_PORT === undefined) {
  let available = await findAvailablePort();
  while (available === port) {
    available = await findAvailablePort();
  }
  process.env.E2E_EXTENSIONS_PORT = String(available);
}
const extensionPort = Number(process.env.E2E_EXTENSIONS_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('E2E_PORT must be a TCP port between 1 and 65535.');
}

if (!Number.isInteger(extensionPort) || extensionPort < 1 || extensionPort > 65535 || extensionPort === port) {
  throw new Error('E2E_EXTENSIONS_PORT must be a distinct TCP port between 1 and 65535.');
}

// The real-extension cache (wr-jbmd). Specs that need it skip with the reason below; E2E_REQUIRE_REAL_EXTENSIONS=1
// fails the run instead. Checked once: workers inherit the result like the ports above.
if (process.env.E2E_REAL_EXTENSIONS === undefined) {
  const { problems } = await checkCache(undefined, process.env.E2E_REAL_EXTENSIONS_CACHE || undefined);
  process.env.E2E_REAL_EXTENSIONS = problems.length ? 'missing' : 'available';
  if (problems.length) {
    const reason = 'The real extension cache is not usable, so the tests that install real extensions are skipped.'
      + ' Run node scripts/fetch-real-extensions.mjs to fill it.\n  ' + problems.join('\n  ');
    if (process.env.E2E_REQUIRE_REAL_EXTENSIONS === '1') {
      throw new Error(reason.replace('are skipped', 'cannot run (E2E_REQUIRE_REAL_EXTENSIONS=1)'));
    }
    process.stdout.write(reason + '\n');
  }
}

const baseURL = 'http://' + host + ':' + port;
const start = target === 'preview' ? 'npm run build && npm run preview' : 'npm run dev';

export default defineConfig({
  testDir: './test/e2e',
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
  },
  webServer: [{
    command: start + ' -- --host ' + host + ' --port ' + port + ' --strictPort',
    // Wait for this process to bind. A URL probe alone can succeed on a competing server.
    wait: { stdout: new RegExp('Local:\\s+' + baseURL.replaceAll('.', '\\.') + '/') },
    reuseExistingServer: false,
  }, {
    command: 'node test/fixtures/serve-extensions.mjs ' + extensionPort,
    wait: { stdout: new RegExp('^Extension fixtures listening on ' + extensionPort + '$', 'm') },
    reuseExistingServer: false,
  }],
});
