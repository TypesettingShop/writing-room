import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ApiProbeResult } from '../harness/api-probe.js';

test.skip(process.env.E2E_TARGET === 'preview', 'The probe harness is available in development');

async function probe(page: Page, fixture: string): Promise<ApiProbeResult> {
  const location = new URL(`/test/fixtures/extensions/api-probe/${fixture}/`, test.info().project.use.baseURL);
  await page.goto('/test/harness/api-probe.html?quiet=300&location=' + encodeURIComponent(location.href));
  await expect(page.locator('#status')).toHaveText('done', { timeout: 60_000 });
  return page.evaluate(() => (window as unknown as { apiProbe: ApiProbeResult }).apiProbe);
}

test('reports a missing API member with the phase that reached it', async ({ page }) => {
  const result = await probe(page, 'missing');
  expect(result.probeError).toBeUndefined();
  expect(result.recorder.loads).toEqual([expect.stringMatching(/\/api-probe\/missing\/extension\.js$/)]);
  expect(result.phases.load.missing).toEqual(['noSuchNamespace']);
  expect(result.phases.activate.missing).toEqual(['window.noSuch']);
  expect(result.phases.activate.accessed).toContain('window');
  expect(result.phases.activate.errors).toContainEqual({
    source: 'activate', message: expect.stringContaining('noSuch'), at: expect.stringMatching(/^extension\.js:5:\d+ .*vscode\.window\.noSuch\(namespace\)/),
  });
  expect(result.activation).toMatchObject({ state: 'failed' });
});

test('reports no missing members for an extension that uses only existing members', async ({ page }) => {
  const result = await probe(page, 'present');
  expect(result.probeError).toBeUndefined();
  expect(result.activation).toMatchObject({ state: 'active' });
  for (const phase of Object.values(result.phases)) {
    expect(phase.missing).toEqual([]);
    expect(phase.checkedMissing).toEqual([]);
  }
  // The recorder saw the calls, so the empty lists above are not an unwired probe.
  expect(result.phases.load.accessed).toEqual(['Disposable']);
  expect(result.phases.activate.called).toEqual(expect.arrayContaining(['commands.registerCommand', '(activate)']));
  expect(result.phases.activate.constructed).toEqual(['Disposable']);
  expect(result.phases.activate.accessed).toEqual(expect.arrayContaining(['context.subscriptions', 'commands.registerCommand']));
});
