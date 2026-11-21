// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { parseWebviewPortHint, resolveWebviewOrigin } from '../../common/webviewOrigin.js';
import { asWebviewUri } from '../../common/webviewUri.js';

const shell = readFileSync(new URL('../../browser/pre/index.html', import.meta.url), 'utf8');

function shellPolicy(): Map<string, string> {
  const policies = [...shell.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
  expect(policies).toHaveLength(1);
  const directives = policies[0][1].split(';').map(directive => directive.trim()).filter(Boolean);
  const policy = new Map(directives.map(directive => {
    const [name, ...values] = directive.split(/\s+/);
    return [name, values.join(' ')];
  }));
  expect(policy.size).toBe(directives.length);
  return policy;
}

describe('Webview shell policy', () => {
  it('allows only a base in the shell origin and keeps every other directive (wr-eycu.5b8)', () => {
    expect(Object.fromEntries(shellPolicy())).toEqual({
      'default-src': "'none'",
      'script-src': "'sha256-By0zkfWIMCrClPfk6O9quHViHZ9gnAwBnO/IOxVluMM='",
      'style-src': "'unsafe-inline'",
      'frame-src': "'self'",
      'worker-src': "'self'",
      'base-uri': "'self'",
    });
  });

  it('allows exactly the inline shell module', () => {
    const scripts = [...shell.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(shell.match(/<script\b/g)).toHaveLength(1);
    const hash = createHash('sha256').update(scripts[0][1]).digest('base64');
    expect(shellPolicy().get('script-src')).toBe(`'sha256-${hash}'`);
  });
});

describe('Webview resource origin', () => {
  // The workbench picks the shell origin from the page and /webview/config.json. The extension host computes the
  // origin of asWebviewUri from its worker script address and the forwarding hint, with the same id. A base that
  // asWebviewUri produced is in 'self' of the shell only while the two agree.
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const resource = URI.parse('vscode-vfs://writing-room/workspace/notes.md');
  const workerPath = '/src/workbench/api/worker/extensionHostWorkerMain.ts?worker_file&type=module';
  it.each([
    ['loopback', 'http://127.0.0.1:5173/?folder=1', undefined, undefined],
    ['loopback by name', 'http://localhost:4173/', undefined, undefined],
    ['forwarded', 'https://5173--work.example.test/', undefined, '5173:5174'],
    ['template', 'https://app.example.test/', 'https://{{uuid}}.webview.example.test', undefined],
  ])('gives the shell and asWebviewUri one origin on a %s page', (_mode, address, template, hint) => {
    const page = new URL(address);
    // /webview/config.json for the workbench, the <meta> hint for the extension host: both come from one port pair.
    const config = hint ? JSON.parse('{"appPort":' + hint.replace(':', ',"webviewPort":') + '}') : undefined;
    const shellOrigin = resolveWebviewOrigin(page, template, id, config);
    const hostOrigin = resolveWebviewOrigin(new URL(workerPath, page), template, id, hint ? parseWebviewPortHint(hint) : undefined);
    expect(shellOrigin).toEqual(hostOrigin);
    expect('origin' in shellOrigin).toBe(true);
    const origin = (shellOrigin as { origin: string }).origin;
    expect(origin).not.toBe(page.origin);
    expect(new URL(asWebviewUri(origin, resource).toString(true)).origin).toBe(origin);
  });
});
