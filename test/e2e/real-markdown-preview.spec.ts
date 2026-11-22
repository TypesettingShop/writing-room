// Acceptance of the master epic (wr-jbmd.g9f): the real Open VSX package `vscode.markdown-language-features` 1.95.3,
// installed unchanged from the Extensions view out of the fixture gallery (test/fixtures/routes/openvsx.mjs serves the
// pinned, signed cache) next to `vscode.markdown` 1.95.3, as VS Code ships the two. It is reported in three tiers, one
// test each, so that each tier passes or fails on its own:
//   가 (A): the preview to the side, its updates, Ctrl+Shift+V, the tab menu, restore after a reload, closing it;
//           once more on a forwarded https address (the Webview epic's proxy fixture)
//   나 (B): Reopen With "Markdown Preview", the custom editor, and back to the text editor
//   다 (C): the thirteen features of the language server, then removal
// and the floor candidate `vscode.simple-browser` 1.95.3 checks WebviewPanel and its serializer on its own.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { createServer as devServer, preview as previewServer } from 'vite';
import { openForwardingProxy } from '../fixtures/forwarding-proxy.mjs';
import { expect as baseExpect, collectPageErrors, test } from './fixtures.js';
import { treeItem } from './explorer.helpers.js';
import { chooseOption, readWorkspaceText, waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { activeGroup, editorText } from './language-basics.helpers.js';
import {
  actionMenu, actionNames, hoverWidget, openActionMenu, openQuickOutline, renameInput, suggestionNames, suggestList,
  triggerSuggest,
} from './language-features.helpers.js';
import { activeEditor, diagnostics, openSettings, replaceText, saveSettings, settingsEditor, startWithMarkdownSource } from './configuration.helpers.js';
import { problemItems, problemsTree } from './diagnostics.helpers.js';
import { packageFolders, savedRecords } from './packages.helpers.js';
import {
  installFromGallery, openExtensions, realPin, requireRealExtensions, routeFixtureGallery, uninstallButton,
} from './real-extensions.helpers.js';
import { expectSymbolsOpen, openFromPalette, symbolRow, symbolsField } from './workspace-symbols.helpers.js';

test.beforeEach(async ({ page }) => {
  await startWithMarkdownSource(page);
});

// The extension starts a language server in a nested Worker and the preview loads two frames and a service worker;
// on a busy machine each of these takes seconds.
const expect = baseExpect.configure({ timeout: 20_000 });
test.use({ viewport: { width: 1400, height: 900 }, actionTimeout: 20_000 });
test.describe.configure({ timeout: 300_000 });

const featuresId = 'vscode.markdown-language-features';
const featuresName = /^Uninstall Markdown Language Features/;
const basicsName = /^Uninstall Markdown Language Basics/;
const browserName = /^Uninstall Simple Browser/;

/**
 * The messages the workbench may log under the extension's own id, and no other. Four contribution points have no
 * counterpart here: the notebook renderer, JSON validation and the preview's style and script points that other
 * extensions use. The runtime accepts the proposals `documentPaste` and, for `vscode.simple-browser`,
 * `externalUriOpener`, so neither extension gets a proposal notice (wr-yxz6.4qz).
 */
const allowedMessages = [
  `info: [${featuresId}] contributes: Unsupported contributions: notebookRenderer, jsonValidation, markdown.previewStyles, markdown.previewScripts`,
];
const allowedBrowserMessages: readonly string[] = [];

// A 1x1 PNG: the preview shows it through the Webview's resource loading, the hover shows it as a preview.
const logo = { bytes: [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')] };
const notesText = [
  '# Notes title',
  '',
  'See [other](./other.md#install) and ![logo](./logo.png).',
  '',
  '## Section two',
  '',
  'body text',
  '',
  'Jump to [the section](#section-two).',
  '',
  '[broken](./missing.md)',
  '',
].join('\n');
const otherText = ['# Other', '', '## Install', '', 'Back to [notes](./notes.md#section-two).', ''].join('\n');

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const groups = (page: Page) => page.locator('[data-group-id]');
const tabNames = (group: Locator) => group.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.textContent?.trim() ?? ''));
const shell = (page: Page) => page.locator('iframe[title="Webview"]:visible');
const preview = (page: Page) => shell(page).contentFrame().locator('iframe[title="Webview content"]').contentFrame();

/** Collects the console messages logged under the ids of `extensions`, as `type: text`. */
function collectMessages(page: Page, extensions: readonly string[]): string[] {
  const messages: string[] = [];
  const pattern = new RegExp('^\\[(' + extensions.map(id => id.replaceAll('.', '\\.')).join('|') + ')\\]', 'i');
  page.on('console', message => {
    if (pattern.test(message.text())) {
      messages.push(message.type() + ': ' + message.text());
    }
  });
  return messages;
}

/** Each extension host start logs the same notices again; every message must be an allowed one, and each one shows. */
function expectAllowed(messages: readonly string[], allowed: readonly string[]): void {
  expect([...new Set(messages)].sort()).toEqual([...allowed].sort());
}

async function show(page: Page, name: string): Promise<void> {
  await tab(page, name).first().click();
  await expect(tab(page, name).first()).toHaveAttribute('aria-selected', 'true');
}

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

/** Clicks into the active editor's text and puts the caret on `text`'s first character (plus `offset`). */
async function caretOn(page: Page, text: string, offset = 0): Promise<void> {
  // The panel shares the height with the editors, and the extension's log channel can open it.
  await hidePanel(page);
  // From the top, so that sticky scroll's header line does not lie over the line clicked.
  await activeEditor(page).focus();
  await page.keyboard.press('ControlOrMeta+Home');
  // Monaco replaces a line's spans when its tokens arrive (the grammar loads on demand): measured and clicked again then.
  await expect(async () => {
    const token = activeGroup(page).locator('.view-line span span').filter({ hasText: text }).first();
    await expect(token).toBeVisible({ timeout: 5_000 });
    const content = (await token.textContent())!.replaceAll('\u00a0', ' ');
    // The locator's text filter ignores case; the caret is measured from the exact text only.
    expect(content.indexOf(text), `"${text}" in the token "${content}"`).toBeGreaterThanOrEqual(0);
    const index = content.indexOf(text) + offset;
    const width = await token.evaluate((element, index) => {
      const range = document.createRange();
      const node = element.firstChild!;
      range.setStart(node, 0);
      range.setEnd(node, index);
      return range.getBoundingClientRect().width;
    }, index);
    // A caret position is a point between characters, which may lie at the token's very edge: the line takes the click.
    await token.click({ position: { x: Math.max(width, 1), y: 5 }, force: true, timeout: 5_000 });
  }).toPass({ timeout: 20_000 });
}

/** Where the active editor's selection overlays lie: changes with every step of a selection, within a line too. */
async function selectionShape(page: Page): Promise<string> {
  return activeGroup(page).locator('.monaco-editor').first().evaluate(editor =>
    [...editor.querySelectorAll<HTMLElement>('.view-overlays .selected-text')]
      .map(element => [element.parentElement!.style.top, element.style.left, element.style.width].join(' ')).join('|'));
}

/** The text of the active editor's line that holds the caret (Monaco's current-line highlight). */
async function caretLine(page: Page): Promise<string | undefined> {
  return activeGroup(page).locator('.monaco-editor').first().evaluate(editor => {
    const top = editor.querySelector<HTMLElement>('.view-overlays .current-line')?.parentElement?.style.top;
    const line = [...editor.querySelectorAll<HTMLElement>('.view-line')].find(candidate => candidate.style.top === top);
    return line && (line.textContent ?? '').replaceAll('\u00a0', ' ');
  });
}

/**
 * The suggestions' accessible names without the documentation Monaco appends to a resolved item while its details pane
 * is open (`label, kind, docs: …`). Ctrl+Space toggles that pane when the list is already open, which happens when a
 * trigger character opened it a moment before the key, and the choice is kept for later lists.
 */
async function completionLabels(page: Page): Promise<string[]> {
  return (await suggestionNames(page)).map(name => name.replace(/, docs: [\s\S]*$/, ''));
}

/** Undoes until the active editor shows `text` again: Monaco groups typing into undo stops by timing. */
async function undoUntil(page: Page, text: string): Promise<void> {
  const expected = rendered(text);
  await expect.poll(async () => {
    const current = await editorText(page);
    if (current !== expected) {
      await page.keyboard.press('ControlOrMeta+z');
      // Monaco draws the undone text at an animation frame: the next read must see it, or one undo too many takes back
      // an earlier, saved edit (the rename) that no further undo brings back.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    return current;
  }, { intervals: [300] }).toBe(expected);
}

/** `text` as editorText reads it back: the rendered lines, where an empty line gives no text. */
function rendered(text: string): string {
  return text.split('\n').filter(line => line !== '').join('\n');
}

/** Hides the panel (Output, Problems), so that the editors have the height of the window. */
async function hidePanel(page: Page): Promise<void> {
  const panel = page.locator('[id="workbench.parts.panel"]');
  if (await panel.isVisible()) {
    await page.keyboard.press('ControlOrMeta+j');
    await expect(panel).toBeHidden();
  }
}

/** The texts of the active editor's lines that the selection covers (Monaco draws selections as overlays). */
async function selectedLines(page: Page): Promise<string[]> {
  return activeGroup(page).locator('.monaco-editor').first().evaluate(editor => {
    const tops = new Set([...editor.querySelectorAll<HTMLElement>('.view-overlays .selected-text')]
      .map(element => element.parentElement!.style.top));
    return [...editor.querySelectorAll<HTMLElement>('.view-line')]
      .filter(line => tops.has(line.style.top))
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
      .map(line => (line.textContent ?? '').replaceAll('\u00a0', ' '));
  });
}

/** Opens the app with the workspace files, routes the gallery, and installs the two Markdown packages from it. */
async function setUp(page: Page): Promise<void> {
  await routeFixtureGallery(page);
  await page.goto('/');
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'notes.md', notesText);
  await writeWorkspaceFile(page, 'other.md', otherText);
  await writeWorkspaceFile(page, 'logo.png', logo);
  await treeItem(page, 'notes.md').dblclick();
  await expect(tab(page, 'notes.md')).toHaveAttribute('aria-selected', 'true');
  await installMarkdown(page);
  await hidePanel(page);
  await show(page, 'notes.md');
}

async function installMarkdown(page: Page): Promise<void> {
  const pin = await realPin(featuresId);
  await installFromGallery(page, 'vscode.markdown', 'Markdown Language Basics', basicsName);
  const confirmation = await installFromGallery(page, 'markdown-language-features', 'Markdown Language Features', featuresName);
  expect(confirmation).toContain('vscode · 1.95.3 · ' + featuresId);
  expect(confirmation).toContain('Web extension');
  expect(confirmation).toContain('Source: open-vsx.org');
  expect(confirmation).toContain('SHA-256: ' + pin.vsix.sha256);
  expect(confirmation).toContain(`Signature: verified (${pin.publicKey})`);
}

/** The preview's frames: the shell on its own origin, the content inside it with the extension's scripts running. */
async function expectPreviewWorks(page: Page): Promise<void> {
  await expect(preview(page).locator('h1')).toHaveText('Notes title');
  const shellOrigin = new URL((await shell(page).getAttribute('src'))!).origin;
  expect(shellOrigin).not.toBe(new URL(page.url()).origin);
  const content = preview(page).locator('html');
  // media/pre.js and media/index.js come as Webview resources from the package folder, through the service worker.
  await expect.poll(() => content.evaluate(() => {
    const scripts = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return ['pre.js', 'index.js'].map(name => scripts.find(entry => entry.name.endsWith('/media/' + name))?.responseStatus);
  })).toEqual([200, 200]);
  expect(await content.evaluate(() => typeof (window as unknown as { cspAlerter?: object }).cspAlerter)).toBe('object');
  // pre.js shows this link when the content's policy blocked anything.
  await expect(preview(page).locator('#code-csp-warning')).toHaveCount(0);
  // The workspace image, relative to the document: the `<base>` the extension writes and localResourceRoots.
  await expect.poll(() => preview(page).locator('img').first().evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
}

test('가: the preview opens to the side and in place, follows the text, comes back after a reload and closes', async ({ page }) => {
  requireRealExtensions();
  const messages = collectMessages(page, [featuresId]);
  await test.step('Install vscode.markdown and vscode.markdown-language-features from the Extensions view', async () => {
    await setUp(page);
  });

  await test.step('The editor title button opens the preview to the side', async () => {
    await page.getByRole('button', { name: 'Open Preview to the Side' }).click();
    await expect(groups(page)).toHaveCount(2);
    await expect(groups(page).nth(1).getByRole('tab', { name: 'Preview notes.md' })).toHaveAttribute('aria-selected', 'true');
    await expectPreviewWorks(page);
  });

  await test.step('Typing in the editor updates the preview', async () => {
    await show(page, 'notes.md');
    await caretOn(page, 'body text', 'body text'.length);
    await page.keyboard.type(' and more');
    await expect(preview(page).getByText('body text and more')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(tab(page, 'notes.md')).not.toHaveAccessibleDescription('Modified');
  });

  await test.step('A double click in the preview goes to that line of the editor', async () => {
    await preview(page).getByText('body text and more').dblclick();
    await expect(tab(page, 'notes.md')).toHaveAttribute('aria-selected', 'true');
    await expect(activeEditor(page)).toBeFocused();
    await expect.poll(() => caretLine(page)).toBe('body text and more');
  });

  await test.step('Reload: the preview tab comes back with its content', async () => {
    await page.reload();
    await expect(groups(page)).toHaveCount(2);
    await expect(groups(page).nth(1).getByRole('tab', { name: 'Preview notes.md' })).toBeVisible();
    await groups(page).nth(1).getByRole('tab', { name: 'Preview notes.md' }).click();
    await expectPreviewWorks(page);
    await expect(preview(page).getByText('body text and more')).toBeVisible();
  });

  await test.step('Closing the preview tab removes the Webview', async () => {
    await page.getByRole('button', { name: 'Close Preview notes.md' }).click();
    await expect(tab(page, 'Preview notes.md')).toHaveCount(0);
    await expect(page.locator('iframe[title="Webview"]')).toHaveCount(0);
  });

  await test.step('The tab\'s context menu runs Open Preview with the tab\'s file', async () => {
    // Another file is the active editor, so only the tab's own resource gives a preview of notes.md.
    await page.keyboard.press('ControlOrMeta+Shift+e');
    await treeItem(page, 'other.md').dblclick();
    await expect(tab(page, 'other.md')).toHaveAttribute('aria-selected', 'true');
    await tab(page, 'notes.md').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open Preview', exact: true }).click();
    await expect(tab(page, 'Preview notes.md')).toHaveAttribute('aria-selected', 'true');
    await expect(preview(page).locator('h1')).toHaveText('Notes title');
    await page.getByRole('button', { name: 'Close Preview notes.md' }).click();
    await expect(tab(page, 'Preview notes.md')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close other.md' }).click();
    await expect(tab(page, 'other.md')).toHaveCount(0);
  });

  await test.step('Ctrl+Shift+V pastes literally in WYSIWYG and opens the preview in source mode', async () => {
    await show(page, 'notes.md');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await activeGroup(page).getByRole('button', { name: 'Switch to WYSIWYG' }).click();
    const wysiwyg = activeGroup(page).getByRole('textbox', { name: 'Markdown editor' });
    await expect(wysiwyg).toBeFocused();
    await page.keyboard.press('ControlOrMeta+End');
    await page.evaluate(() => navigator.clipboard.writeText(' **literal shortcut**'));
    await page.keyboard.press('ControlOrMeta+Shift+V');
    await expect(wysiwyg).toContainText('**literal shortcut**');
    await expect(tab(page, 'Preview notes.md')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(wysiwyg).not.toContainText('literal shortcut');
    await activeGroup(page).getByRole('button', { name: 'Switch to Markdown Source' }).click();
    await activeEditor(page).focus();
    await page.keyboard.press('ControlOrMeta+Shift+V');
    const group = groups(page).filter({ has: tab(page, 'notes.md') });
    await expect(group.getByRole('tab', { name: 'Preview notes.md' })).toHaveAttribute('aria-selected', 'true');
    await expect(preview(page).locator('h1')).toHaveText('Notes title');
    await page.getByRole('button', { name: 'Close Preview notes.md' }).click();
    await expect(tab(page, 'Preview notes.md')).toHaveCount(0);
  });

  expectAllowed(messages, allowedMessages);
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a loopback port');
  }
  return address.port;
}

/** Starts a second app server (dev or preview, as the run) whose Webview listener is `webviewPort`. */
async function openApp(port: number, webviewPort: number) {
  const old = process.env.WRITING_ROOM_WEBVIEW_PORT;
  process.env.WRITING_ROOM_WEBVIEW_PORT = String(webviewPort);
  try {
    const options = { host: '127.0.0.1', port, strictPort: true };
    if (process.env.E2E_TARGET === 'preview') {
      return await previewServer({ preview: options, logLevel: 'silent' });
    }
    const server = await devServer({ server: options, logLevel: 'silent' });
    return await server.listen();
  } finally {
    if (old === undefined) {
      delete process.env.WRITING_ROOM_WEBVIEW_PORT;
    } else {
      process.env.WRITING_ROOM_WEBVIEW_PORT = old;
    }
  }
}

test('가 (forwarded address): the preview opens on its own forwarded origin and comes back after a reload', async () => {
  requireRealExtensions();
  // The forwarding fixture as in webview-forwarded.spec.ts: a TLS proxy that sends `<port>--forwarded.localhost`
  // to that loopback port, as coder's port forwarding does.
  const temporary = mkdtempSync(join(tmpdir(), 'writing-room-forwarding-'));
  const cleanup: Array<() => void | Promise<void>> = [() => rmSync(temporary, { recursive: true, force: true })];
  try {
    const key = join(temporary, 'key.pem');
    const cert = join(temporary, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1',
      '-subj', '/CN=forwarded.localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const appPort = await availablePort();
    let webviewPort = await availablePort();
    while (webviewPort === appPort) {
      webviewPort = await availablePort();
    }
    const app = await openApp(appPort, webviewPort);
    cleanup.unshift(() => app.close());
    const proxy = await openForwardingProxy(appPort, webviewPort, { key: readFileSync(key), cert: readFileSync(cert) });
    cleanup.unshift(() => proxy.close());
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    cleanup.unshift(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await startWithMarkdownSource(page);
    page.setDefaultTimeout(20_000);
    const errors = collectPageErrors(page);
    const messages = collectMessages(page, [featuresId]);
    const appOrigin = 'https://' + appPort + '--forwarded.localhost:' + proxy.port;
    const viewOrigin = 'https://' + webviewPort + '--forwarded.localhost:' + proxy.port;

    await routeFixtureGallery(page);
    await page.goto(appOrigin);
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'notes.md', notesText);
    await writeWorkspaceFile(page, 'other.md', otherText);
    await writeWorkspaceFile(page, 'logo.png', logo);
    await treeItem(page, 'notes.md').dblclick();
    await expect(tab(page, 'notes.md')).toHaveAttribute('aria-selected', 'true');
    await installMarkdown(page);
    await hidePanel(page);
    await show(page, 'notes.md');

    await page.getByRole('button', { name: 'Open Preview to the Side' }).click();
    await expect(groups(page).nth(1).getByRole('tab', { name: 'Preview notes.md' })).toHaveAttribute('aria-selected', 'true');
    await expectPreviewWorks(page);
    expect(new URL((await shell(page).getAttribute('src'))!).origin).toBe(viewOrigin);

    await show(page, 'notes.md');
    await caretOn(page, 'body text', 'body text'.length);
    await page.keyboard.type(' forwarded');
    await expect(preview(page).getByText('body text forwarded')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(tab(page, 'notes.md')).not.toHaveAccessibleDescription('Modified');

    await page.reload();
    await expect(groups(page).nth(1).getByRole('tab', { name: 'Preview notes.md' })).toBeVisible();
    await groups(page).nth(1).getByRole('tab', { name: 'Preview notes.md' }).click();
    await expectPreviewWorks(page);
    await expect(preview(page).getByText('body text forwarded')).toBeVisible();
    await page.getByRole('button', { name: 'Close Preview notes.md' }).click();
    await expect(page.locator('iframe[title="Webview"]')).toHaveCount(0);

    expectAllowed(messages, allowedMessages);
    expect(errors.errors, 'Browser page errors and console errors').toEqual([]);
    errors.stop();
  } finally {
    for (const close of cleanup) {
      await close();
    }
  }
});

test('나: Reopen With switches the tab to the Markdown Preview custom editor and back', async ({ page }) => {
  requireRealExtensions();
  const messages = collectMessages(page, [featuresId]);
  await setUp(page);
  const group = groups(page).filter({ has: tab(page, 'notes.md') });
  const before = await tabNames(group);

  await test.step('Reopen Editor With... replaces the core WYSIWYG pane with the extension preview in the same tab', async () => {
    await group.getByRole('button', { name: 'Switch to WYSIWYG' }).click();
    const editor = group.getByRole('textbox', { name: 'Markdown editor' });
    await expect(editor.getByRole('heading', { name: 'Notes title' })).toBeVisible();
    await expect(editor.getByRole('img', { name: 'logo' })).toBeVisible();
    await command(page, 'View: Reopen Editor With...');
    await expect(page.getByRole('option', { name: /^Manuscript Editor/ })).toContainText('Active');
    await chooseOption(page, 'Markdown Preview');
    await expectPreviewWorks(page);
    expect(await tabNames(group)).toEqual(before);
    await expect(tab(page, 'notes.md')).toHaveAttribute('aria-selected', 'true');
    // The editor title of the custom editor offers Show Source (`activeCustomEditorId`).
    await expect(page.getByRole('button', { name: 'Show Source' })).toBeVisible();
  });

  await test.step('Reload: the custom editor tab comes back', async () => {
    await page.reload();
    await expect(tab(page, 'notes.md')).toBeVisible();
    await show(page, 'notes.md');
    await expectPreviewWorks(page);
  });

  await test.step('Reopen With Text Editor gives the text back in the same tab', async () => {
    await command(page, 'View: Reopen Editor With...');
    await chooseOption(page, 'Text Editor');
    await expect.poll(() => editorText(page)).toContain('## Section two');
    expect(await tabNames(group)).toEqual(before);
    await expect(page.locator('iframe[title="Webview"]')).toHaveCount(0);
  });

  expectAllowed(messages, allowedMessages);
});

test('다: the language server\'s thirteen features, the settings that turn two of them on and off, and removal', async ({ page }) => {
  requireRealExtensions();
  test.setTimeout(480_000);
  const messages = collectMessages(page, [featuresId]);
  const workers: string[] = [];
  page.on('worker', worker => workers.push(worker.url()));
  await setUp(page);
  // The extension host and, inside it, the language server Worker (a blob: script the host wraps).
  await expect.poll(() => page.workers().filter(worker => worker.url().startsWith('blob:')).length).toBe(1);

  await test.step('1 Completion: file paths after `](./`, headers after `](#`', async () => {
    await caretOn(page, 'Jump to', 0);
    await page.keyboard.press('End');
    await page.keyboard.type(' [x](./');
    await triggerSuggest(page);
    await expect.poll(() => completionLabels(page)).toEqual(expect.arrayContaining(['other.md, File', 'logo.png, File']));
    await page.keyboard.press('Escape');
    await page.keyboard.type('other.md) [y](#');
    await triggerSuggest(page);
    await expect.poll(() => completionLabels(page)).toEqual(expect.arrayContaining(['#notes-title', '#section-two']));
    await page.keyboard.press('Escape');
    await undoUntil(page, notesText);
  });

  await test.step('2 Hover: an image link shows the image', async () => {
    await page.mouse.move(0, 0);
    await activeGroup(page).locator('.view-line span span').filter({ hasText: './logo.png' }).first().hover();
    await expect(hoverWidget(page).locator('img')).toHaveCount(1);
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
  });

  await test.step('3 Document symbols: the outline lists the headers', async () => {
    await activeEditor(page).focus();
    const options = await openQuickOutline(page);
    await expect.poll(() => options.evaluateAll(items => items.map(item => item.getAttribute('aria-label') ?? '')))
      .toEqual([expect.stringMatching(/^# Notes title/), expect.stringMatching(/^## Section two/)]);
    await page.keyboard.press('Escape');
  });

  await test.step('4 Folding: a header folds its section', async () => {
    const body = activeGroup(page).locator('.view-line').filter({ hasText: 'body text' });
    await expect(body).toBeVisible();
    // Fold and Unfold of the editor, at the header: the range is the provider's, from the header to the next one.
    await caretOn(page, '## Section two', 3);
    await page.keyboard.press('Control+Shift+BracketLeft');
    await expect(body).toHaveCount(0);
    await expect(activeGroup(page).locator('.view-line').filter({ hasText: 'Jump to' })).toHaveCount(0);
    await expect(activeGroup(page).locator('.view-line').filter({ hasText: 'See [other]' })).toBeVisible();
    await page.keyboard.press('Control+Shift+BracketRight');
    await expect(body).toBeVisible();
  });

  await test.step('5 Selection range: expanding from a word reaches its section, header included', async () => {
    await caretOn(page, 'body text', 1);
    // One step at a time, each read once Monaco has drawn it: a step pressed before the last one shows would skip past
    // the section to the whole document.
    for (let step = 0; step < 6 && (await selectedLines(page))[0] !== '## Section two'; step++) {
      const before = await selectionShape(page);
      await page.keyboard.press('Shift+Alt+ArrowRight');
      await expect.poll(() => selectionShape(page), { timeout: 10_000 }).not.toBe(before);
    }
    expect((await selectedLines(page))[0]).toBe('## Section two');
    expect(await selectedLines(page)).not.toContain('# Notes title');
    await page.keyboard.press('Escape');
  });

  await test.step('6 Document links: Ctrl+click opens the linked file', async () => {
    // The link is also a definition, whose decoration renders the line anew as the pointer moves: the underline found
    // can be gone before it is measured, so Ctrl+click is tried again until the file opens.
    await expect(async () => {
      const link = activeGroup(page).locator('.view-line .detected-link').filter({ hasText: './other.md#install' }).first();
      const bounds = await link.boundingBox({ timeout: 5_000 });
      expect(bounds).not.toBeNull();
      const x = bounds!.x + bounds!.width / 2;
      const y = bounds!.y + bounds!.height / 2;
      // By the point, as a person does: the nodes under it are drawn anew while Ctrl and the pointer rest there.
      await page.mouse.move(x, y);
      await page.keyboard.down('ControlOrMeta');
      try {
        // Go to definition opens other.md as well: the link's own active underline shows the links contribution has it.
        await expect(activeGroup(page).locator('.view-line .detected-link-active').filter({ hasText: './other.md#install' }))
          .toBeVisible({ timeout: 5_000 });
        await page.mouse.click(x, y);
      } finally {
        await page.keyboard.up('ControlOrMeta');
      }
      await expect(tab(page, 'other.md')).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Close other.md' }).click();
    await show(page, 'notes.md');
  });

  await test.step('7 Definition: F12 on a link goes to the header in the other file', async () => {
    await caretOn(page, './other.md#install', 4);
    await page.keyboard.press('F12');
    await expect(tab(page, 'other.md')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => caretLine(page)).toBe('## Install');
    await page.getByRole('button', { name: 'Close other.md' }).click();
    await show(page, 'notes.md');
  });

  await test.step('8 References: Shift+F12 on a header lists the links to it in both files', async () => {
    await caretOn(page, 'Section two', 2);
    await page.keyboard.press('Shift+F12');
    const peek = activeGroup(page).locator('.peekview-widget');
    await expect(peek).toBeVisible();
    await expect(peek).toContainText('other.md');
    await expect(peek).toContainText('notes.md');
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0);
  });

  await test.step('9 Workspace symbols: the search screen finds a header of the file that is not open and opens it there', async () => {
    await openFromPalette(page);
    await expectSymbolsOpen(page);
    await symbolsField(page).pressSequentially('Inst');
    await expect(symbolRow(page, '## Install')).toBeVisible();
    await symbolRow(page, '## Install').click();
    await expect(tab(page, 'other.md')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => caretLine(page)).toBe('## Install');
    await page.getByRole('button', { name: 'Close other.md' }).click();
    await show(page, 'notes.md');
    // Once by its key.
    await activeEditor(page).focus();
    await page.keyboard.press('Control+t');
    await expectSymbolsOpen(page);
    await symbolsField(page).pressSequentially('Other');
    await expect(symbolRow(page, '# Other')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  await test.step('10 Code action: Extract to link definition applies its resolved edit', async () => {
    await show(page, 'notes.md');
    await caretOn(page, './other.md#install', 3);
    await openActionMenu(page);
    await expect.poll(() => actionNames(page)).toContainEqual(expect.stringMatching(/^Extract to link definition/));
    await actionMenu(page).getByRole('option', { name: /^Extract to link definition/ }).click();
    await expect.poll(() => editorText(page)).toMatch(/See \[other\]\[\w+\]/);
    expect(await editorText(page)).toMatch(/\n\[\w+\]: \.\/other\.md#install$/);
    // The extension starts a rename of the new definition with `editor.action.rename`.
    await page.keyboard.press('Escape');
    await undoUntil(page, notesText);
  });

  await test.step('11 Rename: the header and the links to it in the other file', async () => {
    await caretOn(page, 'Section two', 2);
    await page.keyboard.press('F2');
    await expect(renameInput(page)).toHaveValue('Section two');
    await renameInput(page).fill('Section renamed');
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toContain('## Section renamed');
    expect(await editorText(page)).toContain('[the section](#section-renamed)');
    // The edit of the other file goes to its text model, which no editor shows yet.
    await page.keyboard.press('ControlOrMeta+Shift+e');
    await treeItem(page, 'other.md').dblclick();
    await expect(tab(page, 'other.md')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => editorText(page)).toContain('[notes](./notes.md#section-renamed)');
    await page.keyboard.press('ControlOrMeta+s');
    await page.getByRole('button', { name: 'Close other.md' }).click();
    await show(page, 'notes.md');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readWorkspaceText(page, 'other.md')).toContain('#section-renamed');
  });

  await test.step('12 Diagnostics and 13 occurrence highlight follow their settings; path completions turn off', async () => {
    // Monaco marks a provider's highlights `wordHighlight`/`wordHighlightStrong`, its own word matches `wordHighlightText`.
    const highlights = (kind: 'provider' | 'textual') => activeGroup(page).locator(kind === 'provider'
      ? '.view-overlays .wordHighlight, .view-overlays .wordHighlightStrong' : '.view-overlays .wordHighlightText').count();
    const waitForLinkHighlights = async (kind: 'provider' | 'textual', minimum: number) => {
      await expect(async () => {
        // Monaco debounces the caret move by 50 ms and clears highlights at Home, where there is no word.
        await activeEditor(page).focus();
        await page.keyboard.press('ControlOrMeta+Home');
        // A click inside an existing highlight reuses it, even if provider registration has changed.
        await expect.poll(async () => await highlights('provider') + await highlights('textual'), {
          message: 'Previous occurrence highlights clear at the start of the document',
          timeout: 3_000,
        }).toBe(0);
        await caretOn(page, '#section-renamed', 3);
        // Leave the caret on the link while Monaco queries and renders. Moving it again would clear the result.
        await expect.poll(() => highlights(kind), {
          message: `${kind} occurrence highlights appear with the caret on the link`,
          timeout: 3_000,
        }).toBeGreaterThanOrEqual(minimum);
      }).toPass({ timeout: 20_000 });
    };
    await caretOn(page, '#section-renamed', 3);
    await expect.poll(() => highlights('textual')).toBeGreaterThan(0);
    expect(await highlights('provider')).toBe(0);
    // Validation is off by default: the Problems view, on screen, has no row for the broken link. A hidden view has no
    // rows to count at all.
    await command(page, 'View: Focus Problems (Errors, Warnings, Infos)');
    await expect(problemsTree(page).or(page.getByText('No problems have been detected in the workspace.'))).toBeVisible();
    await expect(problemItems(page).filter({ hasText: 'missing.md' })).toHaveCount(0);
    await hidePanel(page);

    await openSettings(page);
    await replaceText(page, '{\n  "markdown.validate.enabled": true,\n  "markdown.occurrencesHighlight.enabled": true,\n  "markdown.suggest.paths.enabled": false\n}');
    await saveSettings(page);
    await show(page, 'notes.md');
    await command(page, 'View: Focus Problems (Errors, Warnings, Infos)');
    await expect(problemItems(page).filter({ hasText: 'missing.md' })).toHaveCount(1);
    await hidePanel(page);
    await show(page, 'notes.md');
    const renamed = await editorText(page);
    // The server registers its provider when it receives the setting. A fresh caret move queries for the header and link.
    await waitForLinkHighlights('provider', 2);
    await page.keyboard.press('End');
    await page.keyboard.type(' [z](./');
    await page.keyboard.press('Control+Space');
    // Read once every provider has answered: the widget then shows its list, or Monaco's message that there is none.
    const noSuggestions = activeGroup(page).locator('.suggest-widget .message').filter({ hasText: 'No suggestions.' });
    await expect.poll(async () => await suggestList(page).isVisible() || await noSuggestions.isVisible()).toBe(true);
    expect(await suggestList(page).isVisible() ? await completionLabels(page) : []).not.toContain('other.md, File');
    await page.keyboard.press('Escape');
    await undoUntil(page, renamed);

    await show(page, 'settings.json');
    // The three settings, saved since the start of this part, are the extension's own: none is marked as unknown.
    await expect(settingsEditor(page).locator('.view-line').filter({ hasText: 'markdown.suggest.paths.enabled' })).toBeVisible();
    await expect(diagnostics(page)).toHaveCount(0);
    await replaceText(page, '{\n  "markdown.validate.enabled": false,\n  "markdown.occurrencesHighlight.enabled": false\n}');
    await saveSettings(page);
    await command(page, 'View: Focus Problems (Errors, Warnings, Infos)');
    await expect(problemItems(page).filter({ hasText: 'missing.md' })).toHaveCount(0);
    await hidePanel(page);
    await show(page, 'notes.md');
    // The server unregisters its provider when it receives the setting. A fresh query falls back to Monaco's word matches.
    await waitForLinkHighlights('textual', 1);
    expect(await highlights('provider')).toBe(0);
    await page.keyboard.press('End');
    await page.keyboard.type(' [z](./');
    await triggerSuggest(page);
    await expect.poll(() => completionLabels(page)).toContain('other.md, File');
    await page.keyboard.press('Escape');
    await undoUntil(page, renamed);
  });

  await test.step('Removal: no server Worker, Webview, provider, command or setting stays', async () => {
    await show(page, 'notes.md');
    await page.getByRole('button', { name: 'Open Preview to the Side' }).click();
    await expect(preview(page).locator('h1')).toHaveText('Notes title');
    await openExtensions(page);
    await uninstallButton(page, featuresName).click();
    await expect(uninstallButton(page, featuresName)).toHaveCount(0);
    await expect(page.locator('iframe[title="Webview"]')).toHaveCount(0);
    await expect.poll(() => page.workers().filter(worker => worker.url().startsWith('blob:')).length).toBe(0);
    await expect.poll(async () => (await savedRecords(page)).map(record => record.identifier)).toEqual(['vscode.markdown']);
    await expect.poll(async () => (await packageFolders(page)).some(path => path.includes(featuresId))).toBe(false);

    await show(page, 'notes.md');
    await activeEditor(page).focus();
    await page.keyboard.press('Control+Shift+O');
    // Nothing can be waited for: without a symbol provider the outline does not open, and a provider's symbols would
    // arrive a moment after the outline did.
    await page.waitForTimeout(1_000);
    await expect(page.locator('.quick-input-widget').filter({ visible: true }).getByRole('option')
      .filter({ hasText: /Notes title|Section renamed/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    // A command that is still there would show: first a query the list must show (a built-in command), then the one it
    // must not, read once the first query's entry has gone from the list.
    await page.keyboard.press('F1');
    await page.getByRole('combobox').fill('Focus Problems');
    await expect(page.getByRole('option', { name: /Focus Problems/ })).toBeVisible();
    await page.getByRole('combobox').fill('Markdown: Open Preview');
    await expect(page.getByRole('option', { name: /Focus Problems/ })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /Open Preview/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await show(page, 'settings.json');
    await expect.poll(() => diagnostics(page).count()).toBeGreaterThan(0);
  });

  expect(workers.some(url => url.startsWith('blob:'))).toBe(true);
  expectAllowed(messages, allowedMessages);
});

test('simple-browser: Show opens the page in a WebviewPanel that comes back after a reload', async ({ page }) => {
  requireRealExtensions();
  const messages = collectMessages(page, ['vscode.simple-browser']);
  await routeFixtureGallery(page);
  await page.goto('/');
  await waitForStorage(page);
  await installFromGallery(page, 'simple-browser', 'Simple Browser', browserName);
  const address = 'http://127.0.0.1:' + process.env.E2E_EXTENSIONS_PORT + '/webview/plain.css';

  await command(page, 'Simple Browser: Show');
  await page.getByRole('textbox').fill(address);
  await page.keyboard.press('Enter');
  await expect(tab(page, 'Simple Browser')).toHaveAttribute('aria-selected', 'true');
  const frame = preview(page).locator('iframe');
  await expect(frame).toHaveAttribute('src', new RegExp('^' + address.replaceAll('.', '\\.')));
  await expect(preview(page).locator('.url-input, input').first()).toHaveValue(address);

  await page.reload();
  await expect(tab(page, 'Simple Browser')).toBeVisible();
  await tab(page, 'Simple Browser').click();
  await expect(preview(page).locator('iframe')).toHaveAttribute('src', new RegExp('^' + address.replaceAll('.', '\\.')));
  expectAllowed(messages, allowedBrowserMessages);
});
