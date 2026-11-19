import type { Page } from '@playwright/test';
import { build } from 'vite';

export async function bundleWebviewHarness(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, lib: { entry: 'test/harness/webview.ts', formats: ['es'] } },
  });
  if (!Array.isArray(result)) {
    throw new Error('Expected the bundled Webview harness.');
  }
  const chunk = result[0].output.find(output => output.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') {
    throw new Error('The Webview harness has no script.');
  }
  return chunk.code;
}

export async function openWebviewHarness(page: Page, url: string, code: string): Promise<void> {
  // Load a real response so Chromium can determine its local-network address space.
  await page.goto(url);
  await page.evaluate(async code => {
    await new Function('return (async () => { ' + code + '\n})()')();
    const element = document.querySelector<HTMLElement>('.webview-element')!;
    Object.assign(element.style, { position: 'fixed', width: '640px', height: '480px', inset: '0', zIndex: '100' });
  }, code);
}
