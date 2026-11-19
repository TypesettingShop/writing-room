import { expect, renderedText, test } from './fixtures.js';
import {
  diagnostics, openSettings, openWithConfigurationFixture, persistedSettings, replaceText, runCommand,
  saveSettings, settingsEditor,
} from './configuration.helpers.js';

test.beforeEach(async ({ page }) => {
  await openWithConfigurationFixture(page);
});

test('suggests a contributed key in settings.json with its description', async ({ page }) => {
  await openSettings(page);
  await replaceText(page, '{\n  \n}');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.type('"fixtureMarkdown.preview.fontSi');
  await page.keyboard.press('Control+Space');
  const widget = settingsEditor(page).locator('.suggest-widget');
  await expect(widget.getByText('fixtureMarkdown.preview.fontSize', { exact: true })).toBeVisible({ timeout: 20_000 });
  // The details of the focused suggestion carry the description. Ctrl+Space toggles them, and a toggle
  // sent while the list is still settling is lost or leaves them on "Loading...", so ask until they show.
  const details = settingsEditor(page).locator('.suggest-details-container');
  await page.waitForTimeout(1500);
  await expect.poll(async () => {
    if (await details.count() === 0) {
      await page.keyboard.press('Control+Space');
    }
    return details.first().innerText({ timeout: 1000 }).catch(() => '');
  }, { timeout: 30_000, intervals: [1000] }).toContain('Controls the font size in pixels used in the preview.');
  await page.keyboard.press('Escape');
});

test('flags a value of the wrong type for a contributed key, and accepts a right one', async ({ page }) => {
  await openSettings(page);
  await replaceText(page, '{"fixtureMarkdown.preview.fontSize": "wrong"}');
  await expect.poll(() => diagnostics(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await replaceText(page, '{"fixtureMarkdown.preview.fontSize": 18, "fixtureMarkdown.validate.enabled": true}');
  await expect(diagnostics(page)).toHaveCount(0);
});

test('knows the contributed keys inside a [markdown] section', async ({ page }) => {
  await openSettings(page);
  await replaceText(page, '{"[markdown]": {"fixtureMarkdown.preview.fontSize": 18, "editor.wordWrap": "on"}}');
  await expect(diagnostics(page)).toHaveCount(0);
  await replaceText(page, '{"[markdown]": {"fixtureMarkdown.preview.fontSize": "wrong"}}');
  await expect.poll(() => diagnostics(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await replaceText(page, '{"[markdown]": {"no.such.key": true}}');
  await expect.poll(() => diagnostics(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
});

test('turns the keys into unknown ones when the extension is removed, and keeps the user’s text', async ({ page }) => {
  await openSettings(page);
  const raw = '{"fixtureMarkdown.preview.fontSize": 18, "[markdown]": {"fixtureMarkdown.preview.fontSize": 19}}';
  await replaceText(page, raw);
  await saveSettings(page);
  await expect(diagnostics(page)).toHaveCount(0);

  await runCommand(page, 'Uninstall Extension', /^Uninstall Extension/);
  await page.getByRole('option', { name: /Configuration Fixture/ }).click();
  await expect.poll(() => diagnostics(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => renderedText(settingsEditor(page))).toContain('fixtureMarkdown.preview.fontSize');
  expect(await persistedSettings(page)).toBe(raw);
});
