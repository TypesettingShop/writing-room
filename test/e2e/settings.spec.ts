import type { Page } from '@playwright/test';
import { expect, renderedText, test } from './fixtures.js';

const persistedSettingsKey = 'writing-room:storage:0:user.settings.json';
const groups = (page: Page) => page.locator('[data-group-id]');
const activeEditor = (page: Page) => page.locator('[data-group-id].active').getByRole('textbox', { name: 'Editor content' });
const settingsTab = (page: Page) => page.getByRole('tab', { name: 'settings.json', exact: true });
const visibleEditors = (page: Page) => page.locator('.monaco-editor .view-lines:visible');

async function command(page: Page, query: string, title: RegExp): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(query);
  await page.getByRole('option', { name: title }).click();
}

async function openSettings(page: Page): Promise<void> {
  await command(page, 'Open User Settings JSON', /Open User Settings \(JSON\)/);
  await expect(settingsTab(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(activeEditor(page)).toBeFocused({ timeout: 20_000 });
}

async function openUntitled(page: Page): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'New Text File' }).click();
  await expect(activeEditor(page)).toBeFocused({ timeout: 20_000 });
}

async function replaceText(page: Page, text: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+a');
  // Model a paste so Monaco does not auto-close brackets or quotes in the test fixture.
  await activeEditor(page).evaluate((editor, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
  // Monaco applies the clipboard edit asynchronously. Wait before sending another key.
  const pane = page.locator('[data-group-id].active');
  await expect.poll(async () => (await renderedText(pane)).trimEnd()).toBe(text.trimEnd());
}

const persistedSettings = (page: Page) => page.evaluate(key => localStorage.getItem(key), persistedSettingsKey);
const save = (page: Page) => page.keyboard.press('ControlOrMeta+s');

test('opens one settings tab from File and the palette and applies saved options to both panes', async ({ appPage: page }) => {
  await openUntitled(page);
  await page.keyboard.insertText('Sample text');
  const firstGroup = groups(page).first();
  await firstGroup.getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);

  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click();
  await page.getByRole('menuitem', { name: /Open User Settings \(JSON\)/ }).click();
  await openSettings(page);
  await expect(settingsTab(page)).toHaveCount(1);
  await expect(visibleEditors(page)).toHaveCount(2);

  const raw = '{\n  // retain this text\n  "editor.fontSize": 24,\n}\n';
  await replaceText(page, raw);
  await expect(settingsTab(page)).toHaveAccessibleDescription('Modified');
  await expect(visibleEditors(page).nth(0)).toHaveCSS('font-size', '14px');
  await expect(visibleEditors(page).nth(1)).toHaveCSS('font-size', '14px');
  expect(await persistedSettings(page)).toBeNull();
  await save(page);
  await expect.poll(() => persistedSettings(page)).toBe(raw);
  await expect(settingsTab(page)).not.toHaveAccessibleDescription('Modified');
  await expect(visibleEditors(page).nth(0)).toHaveCSS('font-size', '24px');
  await expect(visibleEditors(page).nth(1)).toHaveCSS('font-size', '24px');

  await page.addInitScript(() => {
    const sizes: string[] = [];
    Reflect.set(window, 'firstSettingsEditorSizes', sizes);
    const resize = new MutationObserver(() => {
      for (const editor of document.querySelectorAll<HTMLElement>('.monaco-editor .view-lines')) {
        if (editor.clientWidth > 0) {
          sizes.push(getComputedStyle(editor).fontSize);
        }
      }
      if (sizes.length) {
        resize.disconnect();
      }
    });
    resize.observe(document, { childList: true, subtree: true, attributes: true });
  });
  await page.reload();
  await openSettings(page);
  await expect(settingsTab(page)).toHaveCount(1);
  await expect.poll(() => renderedText(groups(page).filter({ has: settingsTab(page) }).first())).toContain('retain this text');
  expect(await page.evaluate(() => Reflect.get(window, 'firstSettingsEditorSizes'))).toEqual(
    expect.arrayContaining(['24px']),
  );
  expect(await page.evaluate(() => Reflect.get(window, 'firstSettingsEditorSizes'))).not.toContain('14px');
});

test('restores an open settings tab and its unsaved draft on reload', async ({ appPage: page }) => {
  const pane = groups(page).first();
  const saved = '{\n  "editor.fontSize": 18,\n}\n';
  const draft = '{\n  // unsaved draft\n  "editor.fontSize": 27,\n}\n';

  await openSettings(page);
  await replaceText(page, saved);
  await save(page);
  await expect.poll(() => persistedSettings(page)).toBe(saved);
  await page.reload();
  await expect(settingsTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(settingsTab(page)).not.toHaveAccessibleDescription('Modified');
  await expect.poll(async () => (await renderedText(pane)).trimEnd()).toBe(saved.trimEnd());
  await expect(visibleEditors(page)).toHaveCSS('font-size', '18px');

  await activeEditor(page).focus();
  await replaceText(page, draft);
  await expect(settingsTab(page)).toHaveAccessibleDescription('Modified');
  await page.reload();
  await expect(settingsTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(settingsTab(page)).toHaveAccessibleDescription('Modified');
  await expect.poll(async () => (await renderedText(pane)).trimEnd()).toBe(draft.trimEnd());
  expect(await persistedSettings(page)).toBe(saved);
  await expect(visibleEditors(page)).toHaveCSS('font-size', '18px');

  await activeEditor(page).focus();
  await save(page);
  await expect.poll(() => persistedSettings(page)).toBe(draft);
  await expect(settingsTab(page)).not.toHaveAccessibleDescription('Modified');
  await expect(visibleEditors(page)).toHaveCSS('font-size', '27px');
});

test('retains exact invalid JSON while keeping the last applied settings', async ({ appPage: page }) => {
  await openSettings(page);
  const editor = groups(page).first();
  await replaceText(page, '{"editor.fontSize": 26}');
  await save(page);
  await expect(visibleEditors(page)).toHaveCSS('font-size', '26px');
  const invalid = '{ "editor.fontSize": ';
  await replaceText(page, invalid);
  await save(page);
  await expect.poll(() => persistedSettings(page)).toBe(invalid);
  await expect(settingsTab(page)).not.toHaveAccessibleDescription('Modified');
  await expect(visibleEditors(page)).toHaveCSS('font-size', '26px');
  await expect.poll(() => renderedText(editor)).toContain('"editor.fontSize"');
  await page.reload();
  await openSettings(page);
  await expect.poll(() => persistedSettings(page)).toBe(invalid);
  await expect.poll(() => renderedText(editor)).toContain('"editor.fontSize"');
});

test('suggests known keys and validates both unknown keys and incorrect types', async ({ appPage: page }) => {
  await openSettings(page);
  const settingsEditor = groups(page).filter({ has: settingsTab(page) }).first();
  await expect.poll(() => renderedText(settingsEditor)).toMatch(/\{\s*\}/);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+Space');
  await expect(settingsEditor.locator('.suggest-widget').getByText('editor.fontSize', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');

  const diagnostics = settingsEditor.locator('.squiggly-warning, .squiggly-error');
  await replaceText(page, '{"unknown.setting": true}');
  await expect.poll(() => renderedText(settingsEditor)).toBe('{"unknown.setting": true}');
  await expect.poll(() => diagnostics.count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await replaceText(page, '{\n  // accepted comment\n  "editor.fontSize": 20,\n}');
  await expect(diagnostics).toHaveCount(0);
  await replaceText(page, '{"editor.fontSize": "wrong"}');
  await expect.poll(() => renderedText(settingsEditor)).toBe('{"editor.fontSize": "wrong"}');
  await expect.poll(() => diagnostics.count(), { timeout: 15_000 }).toBeGreaterThan(0);
});

test('applies another tab’s save without replacing the editor’s dirty draft', async ({ appPage: first }) => {
  await openSettings(first);
  const draft = '{"editor.fontSize": 29}';
  await replaceText(first, draft);
  await expect(settingsTab(first)).toHaveAccessibleDescription('Modified');

  const second = await first.context().newPage();
  try {
    await second.goto('/');
    await openSettings(second);
    const incoming = '{"editor.fontSize": 22}';
    await replaceText(second, incoming);
    await save(second);
    await expect(visibleEditors(first)).toHaveCSS('font-size', '22px');
    await expect.poll(() => renderedText(groups(first).first())).toBe(draft);
    await expect(settingsTab(first)).toHaveAccessibleDescription('Modified');

    await first.bringToFront();
    await save(first);
    await expect.poll(() => persistedSettings(second)).toBe(draft);
    await expect(visibleEditors(second)).toHaveCSS('font-size', '29px');
    await expect.poll(() => renderedText(groups(second).first())).toBe(draft);
    await expect(settingsTab(second)).not.toHaveAccessibleDescription('Modified');
  } finally {
    await second.close();
  }
});

test('keeps a dirty draft when a browser write fails and can retry it', async ({ appPage: page }) => {
  await openSettings(page);
  const initial = '{"editor.fontSize": 18}';
  await replaceText(page, initial);
  await save(page);
  await expect(visibleEditors(page)).toHaveCSS('font-size', '18px');
  const draft = '{"editor.fontSize": 23}';
  await replaceText(page, draft);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) {
        Storage.prototype.setItem = original;
        throw new DOMException('Test quota failure.', 'QuotaExceededError');
      }
      return original.call(this, name, value);
    };
  }, persistedSettingsKey);
  await save(page);
  await expect(page.getByRole('combobox', { name: 'Could not save settings.json' })).toBeVisible();
  expect(await persistedSettings(page)).toBe(initial);
  await expect(settingsTab(page)).toHaveAccessibleDescription('Modified');
  await expect.poll(() => renderedText(groups(page).first())).toBe(draft);
  await expect(visibleEditors(page)).toHaveCSS('font-size', '18px');
  await page.getByRole('option', { name: /^OK/ }).click();
  await page.getByRole('button', { name: 'Close settings.json' }).click();
  await openSettings(page);
  await expect.poll(() => renderedText(groups(page).first())).toBe(draft);
  await save(page);
  await expect.poll(() => persistedSettings(page)).toBe(draft);
  await expect(settingsTab(page)).not.toHaveAccessibleDescription('Modified');
  await expect(visibleEditors(page)).toHaveCSS('font-size', '23px');
});

test('keeps empty groups when requested and limits command history', async ({ appPage: page }) => {
  await openSettings(page);
  await replaceText(page, '{"workbench.editor.closeEmptyGroups": false, "workbench.commandPalette.history": 1}');
  await save(page);
  await expect(settingsTab(page)).not.toHaveAccessibleDescription('Modified');
  await groups(page).first().getByRole('button', { name: 'Split Editor Right' }).click();
  const right = groups(page).nth(1);
  await expect(right.getByRole('tab', { name: 'settings.json' })).toBeVisible();
  await right.getByRole('button', { name: 'Close settings.json' }).click();
  await expect(groups(page)).toHaveCount(2);
  await expect(right.getByRole('tab')).toHaveCount(0);

  await command(page, 'Toggle Status Bar', /Toggle Status Bar/);
  await command(page, 'Toggle Activity Bar', /Toggle Activity Bar/);
  await page.keyboard.press('F1');
  const history = page.getByRole('group', { name: 'Recently Used' });
  await expect(history.getByRole('option')).toHaveCount(1);
  await expect(history.getByRole('option')).toContainText('Toggle Activity Bar');
});

test('captures Ctrl+S in an untitled editor without persisting settings', async ({ appPage: page }) => {
  await openUntitled(page);
  await page.evaluate(() => window.addEventListener('keydown', event => {
    if (event.code === 'KeyS' && (event.ctrlKey || event.metaKey)) {
      queueMicrotask(() => { document.body.dataset.savePrevented = String(event.defaultPrevented); });
    }
  }, { capture: true }));
  await save(page);
  await expect(page.locator('body')).toHaveAttribute('data-save-prevented', 'true');
  expect(await persistedSettings(page)).toBeNull();
});
