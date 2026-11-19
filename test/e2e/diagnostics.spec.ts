import {
  activeEditor, hoverLine, openProblemsCommand, openSettings, openWithDiagnosticsFixtures, part, problemItems, problemNames,
  problemsStatus, problemsTree, runCommand, settingsEditor, settingsTab,
} from './diagnostics.helpers.js';
import { expect, renderedText, test } from './fixtures.js';

const squiggles = (page: import('@playwright/test').Page, kind: 'error' | 'warning' | 'info') =>
  settingsEditor(page).locator('.squiggly-' + kind);

test('diagnostics set before the document opens draw in the editor, and one extension\'s clear leaves the other\'s', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithDiagnosticsFixtures(page);
  await runCommand(page, 'Set Fixture Diagnostics');
  await runCommand(page, 'Set Other Fixture Diagnostics');
  // Both sets reached the workbench before the report asks: each command activates its extension first.
  await expect(problemsStatus(page, '3 errors, 1 warning')).toBeVisible({ timeout: 20_000 });
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

const settingsProblems = [
  'settings.json /User, 5 problems',
  'Error: Fixture error fixture(FX1) [Ln 1, Col 1]',
  'Error: Second fixture error fixture(FX3) [Ln 3, Col 1]',
  'Error: Other fixture error other [Ln 5, Col 1]',
  'Warning: Fixture warning fixture(FX2) [Ln 2, Col 1]',
  'Info: Fixture note fixture [Ln 4, Col 1]',
];

test('Problems lists the diagnostics by file, follows changes, and the status bar counts them', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithDiagnosticsFixtures(page);
  await expect(problemsStatus(page, '0 errors, 0 warnings')).toBeVisible();
  await runCommand(page, 'Set Fixture Diagnostics');
  await runCommand(page, 'Set Other Fixture Diagnostics');

  // The counts are the service's: errors of both owners, the one warning, no information.
  const status = problemsStatus(page, '3 errors, 1 warning');
  await expect(status).toBeVisible();
  await expect(status).toHaveText('3 1');
  await status.click();
  const panel = part(page, 'panel');
  await expect(panel.getByRole('tab', { name: 'Problems' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('No problems detected')).toHaveCount(0);
  await expect.poll(() => problemNames(page)).toEqual(settingsProblems);

  // One owner clears: the list and the counts follow without a reload.
  await runCommand(page, 'Clear Fixture Diagnostics');
  await expect.poll(() => problemNames(page)).toEqual([
    'settings.json /User, 1 problem',
    'Error: Other fixture error other [Ln 5, Col 1]',
  ]);
  await expect(problemsStatus(page, '1 error, 0 warnings')).toBeVisible();
  await runCommand(page, 'Set Fixture Diagnostics');
  await expect.poll(() => problemNames(page)).toEqual(settingsProblems);
});

test('Problems says so when there is nothing to show', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithDiagnosticsFixtures(page);
  await runCommand(page, openProblemsCommand);
  await expect(part(page, 'panel').getByText('No problems have been detected in the workspace.')).toBeVisible();
  await expect(problemsTree(page)).toHaveCount(0);
});

test('a click on a problem opens its file with the range selected', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithDiagnosticsFixtures(page);
  await runCommand(page, 'Set Fixture Diagnostics');
  await expect(problemsStatus(page, '2 errors, 1 warning')).toBeVisible();
  await runCommand(page, openProblemsCommand);
  await problemItems(page).filter({ hasText: 'Second fixture error' }).click();
  await expect(settingsTab(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(activeEditor(page)).toBeFocused({ timeout: 20_000 });
  // The range is "// t" of the third line: typing replaces it.
  await page.keyboard.type('X');
  await expect.poll(() => renderedText(settingsEditor(page))).toContain('Xhird line');
  await expect.poll(() => renderedText(settingsEditor(page))).toContain('// second line');
});

test('the problems can be reached and opened with the keyboard alone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithDiagnosticsFixtures(page);
  await runCommand(page, 'Set Fixture Diagnostics');
  await expect(problemsStatus(page, '2 errors, 1 warning')).toBeVisible();
  await runCommand(page, openProblemsCommand);
  const items = problemItems(page);
  await expect(items.first()).toBeFocused();
  await expect(items.first()).toHaveAttribute('aria-expanded', 'true');
  // Exactly one item is in the tab order.
  await expect(problemsTree(page).locator('[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(2)).toBeFocused();
  await expect(items.nth(2)).toHaveAccessibleName('Error: Second fixture error fixture(FX3) [Ln 3, Col 1]');

  await page.keyboard.press('ArrowLeft');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(items.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(items).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(items).toHaveCount(5);
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(settingsTab(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(activeEditor(page)).toBeFocused({ timeout: 20_000 });
  await page.keyboard.type('Y');
  await expect.poll(() => renderedText(settingsEditor(page))).toContain('Yhird line');
});

test('10,000 problems draw at most 2,000 rows and the workbench stays responsive', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithDiagnosticsFixtures(page);
  await runCommand(page, 'Set Many Fixture Diagnostics');
  await expect(problemsStatus(page, '5000 errors, 5000 warnings')).toBeVisible({ timeout: 30_000 });
  await runCommand(page, openProblemsCommand);
  await expect(problemItems(page).last()).toHaveAccessibleName('8000 more problems not shown');
  // Two files of 1,000 rows, their two headers and the one row that says the rest is not shown.
  await expect(problemItems(page)).toHaveCount(2003);
  await runCommand(page, 'Clear Fixture Diagnostics');
  await expect(part(page, 'panel').getByText('No problems have been detected in the workspace.')).toBeVisible({ timeout: 10_000 });
  await expect(problemsStatus(page, '0 errors, 0 warnings')).toBeVisible();
});

test('the list follows the Problems container to the sidebar, and stays there after a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithDiagnosticsFixtures(page);
  await runCommand(page, 'Set Fixture Diagnostics');
  await part(page, 'panel').getByRole('tab', { name: 'Problems' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Side Bar' }).click();
  const sidebar = part(page, 'sidebar');
  await expect(sidebar.getByRole('treeitem')).toHaveCount(5);
  await expect(part(page, 'panel').getByRole('tab', { name: 'Problems' })).toHaveCount(0);

  await page.reload();
  await expect(part(page, 'panel').getByRole('tab', { name: 'Output' })).toBeVisible();
  await expect(part(page, 'panel').getByRole('tab', { name: 'Problems' })).toHaveCount(0);
  await runCommand(page, 'Set Fixture Diagnostics');
  await expect(problemsStatus(page, '2 errors, 1 warning')).toBeVisible();
  await runCommand(page, openProblemsCommand);
  await expect(sidebar.getByRole('treeitem')).toHaveCount(5);
  await expect(problemsStatus(page, '2 errors, 1 warning')).toBeVisible();
});

test('a Problems tab that was active at reload shows the diagnostics set afterwards', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithDiagnosticsFixtures(page);
  await part(page, 'panel').getByRole('tab', { name: 'Problems' }).click();
  await expect(part(page, 'panel').getByText('No problems have been detected in the workspace.')).toBeVisible();
  await page.reload();
  await expect(part(page, 'panel').getByText('No problems have been detected in the workspace.')).toBeVisible();
  await runCommand(page, 'Set Fixture Diagnostics');
  await expect(part(page, 'panel').getByRole('treeitem')).toHaveCount(5);
});
