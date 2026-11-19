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

const types = { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
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
    const manifest = JSON.parse(await readFile(join(unpackedRoot, folder, 'package.json'), 'utf8'));
    const context = await browser.newContext();
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
    await page.locator('#status').filter({ hasText: 'done' }).waitFor({ timeout: phaseTimeout * 4 + 120_000 });
    const result = await page.evaluate(() => window.apiProbe);
    await context.close();

    let entry;
    if (manifest.browser) {
      const declared = manifest.browser.replace(/^\.\//, '');
      // The file the host loads: the declared path, or that path with `.js` added as upstream does.
      let size;
      for (const candidate of declared.endsWith('.js') ? [declared] : [declared, declared + '.js']) {
        const path = resolveContained(join(unpackedRoot, folder), candidate);
        const info = path ? await stat(path).catch(() => undefined) : undefined;
        if (size === undefined && info?.isFile()) {
          size = info.size;
        }
      }
      entry = { path: manifest.browser, size, limit: entryLimit, withinLimit: size !== undefined && size <= entryLimit };
    }
    const report = {
      extension: pin.id, version: pin.version, sha256: pin.vsix.sha256, probedAt: new Date().toISOString(),
      durationMs: Date.now() - started, entrySize: entry, ...result, page: observed,
    };
    // The location is a random local port; keep the file comparable between runs.
    report.location = `<cache>/unpacked/${folder}/`;
    await writeFile(join(out, `${pin.id}.json`), JSON.stringify(report, undefined, 2) + '\n');
    const missing = new Set(Object.values(result.phases).flatMap(phase => phase.missing));
    const errors = Object.values(result.phases).reduce((count, phase) => count + phase.errors.length, 0);
    summary.push(`${pin.id}@${pin.version}: activation ${result.activation?.state ?? 'none'}, ${missing.size} missing, ${errors} errors`
      + (result.probeError ? `, PROBE ERROR ${result.probeError}` : ''));
    if (result.probeError) {
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
  await vite.close();
  files.close();
}
process.stdout.write(summary.join('\n') + `\nResults: ${out}\n`);
