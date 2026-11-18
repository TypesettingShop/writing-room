import { expect, test } from './fixtures.js';

test('starts the workbench and renders a codicon glyph', async ({ appPage }) => {
  const workbench = appPage.locator('.workbench');
  await expect(workbench).toBeVisible();
  await expect(workbench).toHaveText('Writing Room');

  const icon = workbench.locator('.codicon-edit');
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
    expect(await notices.text()).toContain('@vscode/codicons');

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
