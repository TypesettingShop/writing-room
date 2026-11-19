import {
  activeEditor, hoverLine, openSettings, openWithDiagnosticsFixtures, runCommand, settingsEditor,
} from './diagnostics.helpers.js';
import { expect, test } from './fixtures.js';

const squiggles = (page: import('@playwright/test').Page, kind: 'error' | 'warning' | 'info') =>
  settingsEditor(page).locator('.squiggly-' + kind);

test('diagnostics set before the document opens draw in the editor, and one extension\'s clear leaves the other\'s', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithDiagnosticsFixtures(page);
  await runCommand(page, 'Set Fixture Diagnostics');
  await runCommand(page, 'Set Other Fixture Diagnostics');
  // Every owner's diagnostics are visible to an extension.
  await runCommand(page, 'Report Fixture Diagnostics');
  await expect(page.getByText(
    'Fixture diagnostics: Fixture error, Fixture note, Fixture warning, Other fixture error, Second fixture error',
    { exact: true })).toBeVisible();

  await openSettings(page);
  await expect(squiggles(page, 'error')).toHaveCount(3);
  await expect(squiggles(page, 'warning')).toHaveCount(1);
  await expect(squiggles(page, 'info')).toHaveCount(1);

  await hoverLine(page, 'first line');
  await expect(page.getByText('Fixture error', { exact: true })).toBeVisible();

  await activeEditor(page).focus();
  await runCommand(page, 'Clear Fixture Diagnostics');
  await expect(squiggles(page, 'error')).toHaveCount(1);
  await expect(squiggles(page, 'warning')).toHaveCount(0);
  await expect(squiggles(page, 'info')).toHaveCount(0);
  await hoverLine(page, 'fifth line');
  await expect(page.getByText('Other fixture error', { exact: true })).toBeVisible();
});
