import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { expect, test } from './fixtures.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { explorerTree, rowNames, treeItem } from './explorer.helpers.js';
import {
  expectEditorText, groups, quickInputBox, quickPick, readWorkspaceText, selectedTab, waitForStorage, writeWorkspaceFile,
} from './files.helpers.js';

const manifest = JSON.parse(readFileSync(new URL('../fixtures/extensions/documents/package.json', import.meta.url), 'utf8')) as IExtensionManifest;

test('an extension opens, reads and updates mirrored documents over RPC', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Document API');
  await page.getByRole('option', { name: /Check Document API/ }).click();
  await expect(page.getByText('Document API verified', { exact: true })).toBeVisible({ timeout: 15000 });
});

test('an extension opens split editors and applies versioned edits and snippets', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Text Editor API');
  await page.getByRole('option', { name: /Check Text Editor API/ }).click();
  await expect(page.getByText('Text Editor API verified', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('tab', { name: 'Untitled-1' })).toHaveCount(2);
});

test('workspace edit preflights every target and editor decorations dispose', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Workspace Edit API');
  await page.getByRole('option', { name: /Check Workspace Edit API/ }).click();
  await expect(page.getByText('Workspace Edit API verified', { exact: true })).toBeVisible({ timeout: 15000 });
  const decorated = page.locator('.monaco-editor span').filter({ hasText: /^text$/ });
  await expect(decorated).toHaveCSS('background-color', 'rgb(221, 238, 255)');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Clear Fixture Decoration');
  await page.getByRole('option', { name: /Clear Fixture Decoration/ }).click();
  await expect(page.locator('.monaco-editor [class*="wr-extension-decoration-"]')).toHaveCount(0);
});

test('tab groups, built-in commands and editor context actions use the target editor', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Tab Groups API');
  await page.getByRole('option', { name: /Check Tab Groups API/ }).click();
  await expect(page.getByText('Tab Groups API verified', { exact: true })).toBeVisible({ timeout: 15000 });
  const editor = page.locator('.monaco-editor').filter({ visible: true }).first();
  await editor.getByText('tab content', { exact: true }).click({ button: 'right' });
  const action = page.getByRole('menuitem', { name: 'Fixture Actions: Report Fixture Editor Resource' });
  await expect(action).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Different Language Fixture Action' })).toHaveCount(0);
  // Monaco's menu ignores pointer release for 100 ms after it opens.
  await action.click({ delay: 150 });
  await expect(action).toBeHidden();
  await expect(page.getByText('Editor menu resource: Untitled-1', { exact: true })).toBeVisible();
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Reference Command');
  await page.getByRole('option', { name: /Check Reference Command/ }).click();
  await expect(page.getByRole('tree', { name: 'References' })).toBeVisible();
});

async function openDocumentSaveFixture(page: Page): Promise<void> {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await waitForStorage(page);
  await expect(explorerTree(page)).toBeVisible();
}

async function startUntitledSave(page: Page, visibility: 'Shown' | 'Hidden'): Promise<void> {
  const command = `Save ${visibility} Untitled Fixture`;
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(command);
  await page.getByRole('option', { name: command, exact: true }).click();
  await expect(quickPick(page, 'Save As')).toBeFocused({ timeout: 15_000 });
}

async function chooseUntitledSavePath(page: Page, filename: string): Promise<void> {
  await page.keyboard.type('Type a');
  await page.keyboard.press('Enter');
  const path = quickInputBox(page, 'Save As');
  await expect(path).toBeFocused();
  await path.fill(filename);
  await path.press('Enter');
}

test('extension save replaces a shown untitled tab with a clean file and closes the original document', async ({ page }) => {
  await openDocumentSaveFixture(page);
  await writeWorkspaceFile(page, 'existing.txt', 'Existing file');
  await treeItem(page, 'existing.txt').dblclick();
  const group = groups(page).first();
  await expect(selectedTab(group)).toHaveText('existing.txt');
  await expectEditorText(group, 'Existing file');
  const originalRows = await rowNames(page);
  await startUntitledSave(page, 'Shown');
  const untitled = group.getByRole('tab', { name: 'Untitled-1', exact: true });
  await expect(untitled).toHaveAccessibleDescription('Modified');
  const tabsBeforeSave = await group.getByRole('tab').allTextContents();

  await chooseUntitledSavePath(page, 'saved-visible.txt');
  await expect(page.getByText('Untitled save: true, closed: true, listed: false', { exact: true })).toBeVisible();
  await expect(untitled).toHaveCount(0);
  await expect(group.getByRole('tab')).toHaveText(tabsBeforeSave.map(title => title === 'Untitled-1' ? 'saved-visible.txt' : title));
  await expect(selectedTab(group)).toHaveText('saved-visible.txt');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  await expectEditorText(group, 'Draft from a visible extension document');
  expect(await readWorkspaceText(page, 'saved-visible.txt')).toBe('Draft from a visible extension document');
  await expect.poll(async () => (await rowNames(page)).sort()).toEqual([...originalRows, 'saved-visible.txt'].sort());

  await page.keyboard.press('ControlOrMeta+w');
  await expect(group.getByRole('tab', { name: 'saved-visible.txt', exact: true })).toHaveCount(0);
  await expect(quickPick(page, /Do you want to save/)).toHaveCount(0);
});

test('cancelling an extension save keeps the untitled draft and creates no file', async ({ page }) => {
  await openDocumentSaveFixture(page);
  const originalRows = await rowNames(page);
  await startUntitledSave(page, 'Shown');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Untitled save: false, closed: false, listed: true', { exact: true })).toBeVisible();
  const group = groups(page).first();
  await expect(selectedTab(group)).toHaveText('Untitled-1');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await expectEditorText(group, 'Draft from a visible extension document');
  expect(await rowNames(page)).toEqual(originalRows);
});

test('extension save of a hidden untitled document writes a file and closes the document without opening a tab', async ({ page }) => {
  await openDocumentSaveFixture(page);
  const tabs = page.getByRole('tab');
  const originalTabs = await tabs.allTextContents();
  await startUntitledSave(page, 'Hidden');
  await chooseUntitledSavePath(page, 'saved-hidden.txt');
  await expect(page.getByText('Untitled save: true, closed: true, listed: false', { exact: true })).toBeVisible();
  expect(await readWorkspaceText(page, 'saved-hidden.txt')).toBe('Draft from a hidden extension document');
  await expect(tabs).toHaveText(originalTabs);
});
