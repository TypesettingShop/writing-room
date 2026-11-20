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
    // Every runtime dependency is credited: Monaco, Codicons and the TextMate grammar engine with its wasm.
    for (const name of ['monaco-editor', '@vscode/codicons', 'vscode-textmate', 'vscode-oniguruma']) {
      expect(text).toContain(name);
    }
    // The test-only fixture and development dependencies are not shipped, so they carry no notice.
    expect(text).not.toContain('fake-indexeddb');

    const harness = await request.get('/test/harness/instantiation.html');
    expect(harness.status()).toBe(404);
  });
} else {
  test('injects a decorated constructor parameter in the browser', async ({ page }) => {
    const response = await page.goto('/test/harness/instantiation.html');
    expect(response?.ok()).toBe(true);
    await expect(page.getByRole('status')).toHaveText('Browser: injected');
  });
}
