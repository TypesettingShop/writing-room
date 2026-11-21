import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.js';

test('starts the workbench and renders a codicon glyph', async ({ appPage }) => {
  const title = appPage.locator('[id="workbench.parts.titlebar"]');
  await expect(title.getByText('Writing Room', { exact: true })).toBeVisible();

  const icon = title.locator('.codicon-edit');
  const rendered = await icon.evaluate(async element => {
    const { content, fontFamily } = getComputedStyle(element, '::before');
    const glyph = content.slice(1, -1).codePointAt(0) ?? 0;
    const faces = await document.fonts.load('16px codicon');
    return {
      hasGlyph: content.length === 3 && glyph >= 0xe000 && glyph <= 0xf8ff,
      usesCodicon: fontFamily.replace(/["']/g, '') === 'codicon',
      fontLoaded: faces.some(face => face.family.replace(/["']/g, '') === 'codicon' && face.status === 'loaded'),
    };
  });

  expect(rendered).toEqual({ hasGlyph: true, usesCodicon: true, fontLoaded: true });
});

if (process.env.E2E_TARGET === 'preview') {
  test('ships the notices and keeps the test harness out of the build', async ({ request }) => {
    const notices = await request.get('/ThirdPartyNotices.txt');
    expect(notices.ok()).toBe(true);
    const text = await notices.text();
    // Every runtime dependency (Monaco, Codicons and the TextMate grammar engine with its wasm) is credited under a
    // heading line of its name and installed version. A bare name would also match the line that heads the package's
    // own third-party notices, so a removed license section would go unnoticed.
    const { dependencies } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as
      { dependencies: Record<string, string> };
    expect(Object.keys(dependencies)).toEqual(
      expect.arrayContaining(['monaco-editor', '@vscode/codicons', 'vscode-textmate', 'vscode-oniguruma']));
    for (const name of Object.keys(dependencies)) {
      const { version } = JSON.parse(readFileSync(
        new URL('../../node_modules/' + name + '/package.json', import.meta.url), 'utf8')) as { version: string };
      const heading = (name + ' ' + version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(text).toMatch(new RegExp('^' + heading + '\\r?$', 'm'));
    }
    // Development dependencies are not shipped, so they carry no notice.
    expect(text).not.toContain('fake-indexeddb');

    // Neither the test harness nor the upstream reference fixture is served by the build.
    for (const path of ['/test/harness/instantiation.html', '/test/fixtures/vscode-api/vscode.d.ts']) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
  });
} else {
  test('injects a decorated constructor parameter in the browser', async ({ page }) => {
    const response = await page.goto('/test/harness/instantiation.html');
    expect(response?.ok()).toBe(true);
    await expect(page.getByRole('status')).toHaveText('Browser: injected');
  });
}
