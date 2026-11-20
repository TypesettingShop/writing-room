#!/usr/bin/env node
// Runs the pinned real extensions on the current extension host and records which API members they touch, which are
// missing and what fails, per phase (load, activate, first document). Nothing here ships in the product.
//
//   node scripts/probe-extension.mjs [--out <dir>] [--pins <file>] [--cache <dir>] [--timeout <ms>] [<extension id>...]
//
// It needs the cache that scripts/fetch-real-extensions.mjs fills, and makes no request outside 127.0.0.1: the
// browser resolves every other host name to nothing. Every VSIX is checked against its pin before it is unpacked; a
// file that does not match stops the run before any server starts.
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  cachedFiles, defaultCacheDir, defaultPinsPath, extractVsix, packageBaseName, readPins, readVerified, repositoryRoot,
  resolveContained, selectPins,
} from './lib/real-extensions.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    pins: { type: 'string', default: defaultPinsPath },
    cache: { type: 'string', default: defaultCacheDir },
    timeout: { type: 'string', default: '20000' },
  },
});
const out = values.out ?? join(values.cache, 'probe-results');
const phaseTimeout = Number(values.timeout);
if (!Number.isInteger(phaseTimeout) || phaseTimeout < 1) {
  process.stderr.write(`--timeout must be a positive number of milliseconds, not ${JSON.stringify(values.timeout)}\n`);
  process.exit(2);
}

// The entry limit of src/workbench/services/extensions/common/extensionResources.ts (5 MiB, URL folder install).
const entryLimit = 5 * 1024 * 1024;

const pins = await readPins(values.pins);
const selected = selectPins(pins, positionals);
const failures = [];
const packages = [];
for (const pin of selected) {
  const file = cachedFiles(pins, pin, values.cache).vsix;
  try {
    const bytes = await readVerified(file);
    if (!bytes) {
      throw new Error(`${file.path} is not in the cache. Run node scripts/fetch-real-extensions.mjs first.`);
    }
    packages.push({ pin, bytes });
  } catch (error) {
    failures.push(`${pin.id}@${pin.version}: ${error.message}`);
  }
}
if (failures.length) {
  process.stderr.write(failures.map(failure => `FAILED ${failure}\n`).join(''));
  process.exit(1);
}

const unpackedRoot = join(values.cache, 'unpacked');
for (const entry of packages) {
  entry.folder = packageBaseName(entry.pin);
  // Unpacked again on every run from the bytes that were just verified.
  await extractVsix(entry.bytes, join(unpackedRoot, entry.folder));
}

// Chromium refuses module and worker scripts and streamed WebAssembly served as application/octet-stream.
const types = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.html': 'text/html', '.css': 'text/css', '.txt': 'text/plain', '.md': 'text/plain',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};
const files = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'no-store');
  const path = resolveContained(unpackedRoot, new URL(request.url, 'http://127.0.0.1').pathname);
  try {
    if (!path || !(await stat(path)).isFile()) {
      throw new Error('not found');
    }
    response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => files.listen(0, '127.0.0.1', resolve));
const filesOrigin = `http://127.0.0.1:${files.address().port}`;

const { createServer: createViteServer } = await import('vite');
const { chromium } = await import('@playwright/test');
const vite = await createViteServer({
  root: repositoryRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
});
await vite.listen();
const appOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
});

await mkdir(out, { recursive: true });
const summary = [];
try {
  for (const { pin, folder } of packages) {
    const location = `${filesOrigin}/${encodeURIComponent(folder)}/`;
    const context = await browser.newContext();
    // One extension that hangs or breaks the page must not cost the reports of the others.
    try {
      const manifest = JSON.parse(await readFile(join(unpackedRoot, folder, 'package.json'), 'utf8'));
      const page = await context.newPage();
      const observed = { console: [], pageErrors: [], workers: [], outsideRequests: [] };
      page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') {
          observed.console.push(`${message.type()}: ${message.text()}`);
        }
      });
      page.on('pageerror', error => observed.pageErrors.push(String(error)));
      page.on('worker', worker => observed.workers.push(worker.url()));
      page.on('request', request => {
        const { hostname } = new URL(request.url());
        if (hostname !== '127.0.0.1' && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) {
          observed.outsideRequests.push(request.url());
        }
      });
      const started = Date.now();
      await page.goto(`${appOrigin}/test/harness/api-probe.html?phaseTimeout=${phaseTimeout}&location=${encodeURIComponent(location)}`);
      // The page waits at most five phase timeouts (activation, settle, document, onLanguage, settle).
      await page.locator('#status').filter({ hasText: 'done' }).waitFor({ timeout: phaseTimeout * 5 + 120_000 });
      const result = await page.evaluate(() => window.apiProbe);

      let entry;
      if (manifest.browser) {
        const declared = manifest.browser.replace(/^\.\//, '');
        // The file the host loads: the declared path, with `.js` added when it lacks one, as upstream and
        // extensionResources.ts do. The path without `.js` is never loaded.
        const path = resolveContained(join(unpackedRoot, folder), declared.endsWith('.js') ? declared : declared + '.js');
        const info = path ? await stat(path).catch(() => undefined) : undefined;
        const size = info?.isFile() ? info.size : undefined;
        entry = { path: manifest.browser, size, limit: entryLimit, withinLimit: size !== undefined && size <= entryLimit };
      }
      const report = {
        extension: pin.id, version: pin.version, sha256: pin.vsix.sha256, probedAt: new Date().toISOString(),
        durationMs: Date.now() - started, entrySize: entry, ...result, page: observed,
      };
      // Both servers listen on random ports and the channel name is random; keep the file comparable between runs.
      // `(?!\d)`: one random port can be a prefix of the other.
      const origin = value => new RegExp(value.replaceAll('.', '\\.') + '(?!\\d)', 'g');
      const text = JSON.stringify(report, undefined, 2)
        .replaceAll(location, `<cache>/unpacked/${folder}/`)
        .replace(origin(filesOrigin), '<cache>/unpacked')
        .replace(origin(appOrigin), '<app>')
        .replace(/channel=api-probe-[0-9a-f-]+/g, 'channel=api-probe-<id>');
      await writeFile(join(out, `${pin.id}.json`), text + '\n');
      const missing = new Set(Object.values(result.phases).flatMap(phase => phase.missing));
      const errors = Object.values(result.phases).reduce((count, phase) => count + phase.errors.length, 0);
      summary.push(`${pin.id}@${pin.version}: activation ${result.activation?.state ?? 'none'}, ${missing.size} missing, ${errors} errors`
        + (result.probeError ? `, PROBE ERROR ${result.probeError}` : ''));
      if (result.probeError) {
        process.exitCode = 1;
      }
    } catch (error) {
      summary.push(`${pin.id}@${pin.version}: PROBE ERROR ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await vite.close();
  files.close();
}
process.stdout.write(summary.join('\n') + `\nResults: ${out}\n`);
