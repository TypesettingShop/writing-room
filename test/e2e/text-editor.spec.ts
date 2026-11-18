import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { collectPageErrors, expect, test } from './fixtures.js';
import type { Locator, Page } from '@playwright/test';

const preview = process.env.E2E_TARGET === 'preview';
const monacoRequest = /monaco-editor|editor\.api|\.worker[-.]/;

/** The text Monaco renders, one string per visible line, with its non-breaking spaces made plain. */
async function renderedText(pane: Locator): Promise<string> {
  // An editor without a model renders no lines at all.
  const lines = pane.locator('.monaco-editor .view-lines');
  const text = await lines.count() ? await lines.innerText() : '';
  return text.replaceAll(' ', ' ');
}

function editor(page: Page, pane: string): Locator {
  return page.getByRole('region', { name: pane }).getByRole('textbox', { name: 'Editor content' });
}

function monacoRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', request => {
    if (monacoRequest.test(request.url())) {
      urls.push(request.url());
    }
  });
  return urls;
}

test('the workbench page does not load Monaco on its own', async ({ page }) => {
  const requested = monacoRequests(page);
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  await page.waitForLoadState('networkidle');
  expect(requested).toEqual([]);
});

test.describe('in the harness', () => {
  test.skip(preview, 'The text editor harness is served by the development server only.');

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
  });

  async function open(page: Page): Promise<string[]> {
    const requested = monacoRequests(page);
    const response = await page.goto('/test/harness/text-editor.html');
    expect(response?.ok()).toBe(true);
    await page.waitForLoadState('networkidle');
    expect(requested, 'Monaco requests before any text editor opened').toEqual([]);
    return requested;
  }

  async function newUntitled(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'New Untitled' }).click();
    await expect(editor(page, 'Left Pane')).toBeFocused();
  }

  test('loads Monaco with the first editor, and typing shows text and marks the input dirty', async ({ page }) => {
    const requested = await open(page);
    await newUntitled(page);
    expect(requested.length).toBeGreaterThan(0);

    await page.keyboard.type('hello world');
    const left = page.getByRole('region', { name: 'Left Pane' });
    await expect.poll(() => renderedText(left)).toBe('hello world');
    await expect(page.getByRole('status', { name: 'Inputs' })).toHaveText('Untitled-1*');
    await expect(page.getByRole('status', { name: 'Focus Keys' })).toHaveText('editorTextFocus editorFocus textInputFocus');
    await expect(left.locator('.monaco-editor')).toHaveCount(1);
    // `loadMonaco()` sets the theme; the editor's options leave it alone.
    await expect(left.locator('.monaco-editor')).toHaveClass(/\bvs-dark\b/);
  });

  test('switching a pane between inputs keeps each one\'s text, cursor and scroll', async ({ page }) => {
    await open(page);
    const left = page.getByRole('region', { name: 'Left Pane' });
    await newUntitled(page);
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
    await page.keyboard.type(lines.join('\n'));
    await expect.poll(() => renderedText(left)).toContain('line 60');
    await expect.poll(() => renderedText(left)).not.toContain('line 1\n');
    // Put the cursor inside the last line, then leave.
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');

    await newUntitled(page);
    await page.keyboard.type('second');
    await expect.poll(() => renderedText(left)).toBe('second');

    await page.getByRole('combobox', { name: 'Input' }).selectOption({ label: 'Untitled-1' });
    await page.getByRole('button', { name: 'Show Left' }).click();
    await expect(editor(page, 'Left Pane')).toBeFocused();
    await expect.poll(() => renderedText(left)).toContain('line 60');
    await expect.poll(() => renderedText(left)).not.toContain('second');
    await expect.poll(() => renderedText(left)).not.toContain('line 1\n');
    await page.keyboard.type('X');
    await expect.poll(() => renderedText(left)).toContain('lXine 60');
  });

  test('one input in two panes shows each edit in both, and closing one pane leaves the other working', async ({ page }) => {
    await open(page);
    const left = page.getByRole('region', { name: 'Left Pane' });
    const right = page.getByRole('region', { name: 'Right Pane' });
    await newUntitled(page);
    await page.getByRole('button', { name: 'Show Right' }).click();
    await expect(editor(page, 'Right Pane')).toBeFocused();
    await page.keyboard.type('from the right');
    await expect.poll(() => renderedText(left)).toBe('from the right');

    await editor(page, 'Left Pane').focus();
    await page.keyboard.press('End');
    await page.keyboard.type(', and the left');
    await expect.poll(() => renderedText(right)).toBe('from the right, and the left');

    await page.getByRole('button', { name: 'Dispose Left Pane' }).click();
    await expect(left.locator('.monaco-editor')).toHaveCount(0);
    await editor(page, 'Right Pane').focus();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await expect.poll(() => renderedText(right)).toBe('from the right, and the left!');
    await expect(page.getByRole('status', { name: 'Models' })).toHaveText('untitled:Untitled-1');
  });

  test('closing an input disposes its model and empties the panes that showed it', async ({ page }) => {
    await open(page);
    const left = page.getByRole('region', { name: 'Left Pane' });
    await newUntitled(page);
    await page.keyboard.type('doomed');
    await page.getByRole('button', { name: 'Show Right' }).click();
    await expect(page.getByRole('status', { name: 'Models' })).toHaveText('untitled:Untitled-1');

    await page.getByRole('button', { name: 'Close Input' }).click();
    await expect(page.getByRole('status', { name: 'Models' })).toHaveText('');
    await expect(page.getByRole('status', { name: 'Inputs' })).toHaveText('');
    await expect.poll(() => renderedText(left)).toBe('');

    await newUntitled(page);
    await expect(page.getByRole('status', { name: 'Inputs' })).toHaveText('Untitled-1');
  });

  test('the editor follows resizes and a move to another parent', async ({ page }) => {
    await open(page);
    const left = page.getByRole('region', { name: 'Left Pane' });
    await newUntitled(page);
    await page.keyboard.type('still here');
    await expect.poll(async () => (await left.locator('.monaco-editor').boundingBox())?.width).toBe(360);

    await page.getByRole('button', { name: 'Resize Left' }).click();
    await expect.poll(async () => {
      const box = await left.locator('.monaco-editor').boundingBox();
      return [box?.width, box?.height];
    }).toEqual([520, 300]);

    await page.getByRole('button', { name: 'Move Left', exact: true }).click();
    const elsewhere = page.getByRole('region', { name: 'Elsewhere' });
    await expect.poll(async () => {
      const box = await elsewhere.locator('.monaco-editor').boundingBox();
      return [box?.width, box?.height];
    }).toEqual([300, 180]);
    await expect.poll(() => renderedText(elsewhere)).toBe('still here');
    await editor(page, 'Elsewhere').focus();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await expect.poll(() => renderedText(elsewhere)).toBe('still here!');
  });

  test('a scrolled editor moved without a size change still shows where it was', async ({ page }) => {
    await open(page);
    await newUntitled(page);
    await page.getByRole('button', { name: 'Move Left', exact: true }).click();
    await editor(page, 'Elsewhere').focus();
    await page.keyboard.type(Array.from({ length: 40 }, (_, index) => `row ${index + 1}`).join('\n'));
    const elsewhere = page.getByRole('region', { name: 'Elsewhere' });
    await expect.poll(() => renderedText(elsewhere)).toContain('row 40');

    await page.getByRole('button', { name: 'Move Left Back' }).click();
    const left = page.getByRole('region', { name: 'Left Pane' });
    await expect(left.locator('.monaco-editor')).toHaveCount(1);
    await expect.poll(() => renderedText(left)).toContain('row 40');
    await expect.poll(() => renderedText(left)).not.toMatch(/^row 1\n/);
    await editor(page, 'Left Pane').focus();
    await page.keyboard.type('!');
    await expect.poll(() => renderedText(left)).toContain('row 40!');
  });

  test('F1 does not open Monaco\'s own palette, and undo and redo work from the keyboard', async ({ page }) => {
    await open(page);
    const left = page.getByRole('region', { name: 'Left Pane' });
    await newUntitled(page);
    await page.keyboard.type('first');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    await expect.poll(() => renderedText(left)).toBe('first\nsecond');

    await page.keyboard.press('F1');
    await page.waitForTimeout(300);
    await expect(page.locator('.quick-input-widget:visible')).toHaveCount(0);
    await expect(editor(page, 'Left Pane')).toBeFocused();

    await page.keyboard.press('Control+z');
    await expect.poll(() => renderedText(left)).not.toBe('first\nsecond');
    const undone = await renderedText(left);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => renderedText(left)).toBe('first\nsecond');
    await page.keyboard.press('Control+z');
    await expect.poll(() => renderedText(left)).toBe(undone);
    await page.keyboard.press('Control+y');
    await expect.poll(() => renderedText(left)).toBe('first\nsecond');
  });

  test('all five workers start', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    await newUntitled(page);
    await page.getByRole('button', { name: 'Start Workers' }).click();
    await expect(page.getByRole('status', { name: 'Workers' })).toHaveText('5 started');
    for (const name of ['editor.worker', 'json.worker', 'css.worker', 'html.worker', 'ts.worker']) {
      await expect.poll(() => page.workers().find(worker => worker.url().includes(name))?.url(), { timeout: 30_000 })
        .toBeTruthy();
      const worker = page.workers().find(candidate => candidate.url().includes(name))!;
      // Each worker installs its message handler once its module has loaded.
      await expect.poll(() => worker.evaluate(() => typeof self.onmessage), { timeout: 60_000 }).toBe('function');
    }
  });
});

// Aborted requests log console errors, so this test checks the page's errors itself.
base('shows a message in the pane when Monaco cannot load, and opens on the next try', async ({ page }) => {
  base.skip(preview, 'The text editor harness is served by the development server only.');
  const collector = collectPageErrors(page);
  await page.route(monacoRequest, route => route.abort());
  const response = await page.goto('/test/harness/text-editor.html');
  expect(response?.ok()).toBe(true);
  await page.getByRole('button', { name: 'New Untitled' }).click();
  const left = page.getByRole('region', { name: 'Left Pane' });
  await expect(left.getByRole('alert')).toContainText('could not be opened');

  await page.unroute(monacoRequest);
  await page.getByRole('button', { name: 'Show Left' }).click();
  await expect(left.getByRole('alert')).toBeHidden();
  await expect(editor(page, 'Left Pane')).toBeFocused();
  collector.stop();
  expect(collector.errors.filter(error => !error.startsWith('Failed to load resource'))).toEqual([]);
});

test.describe('the production build', () => {
  test.skip(!preview, 'Checks dist/, which only the preview target builds.');
  const dist = fileURLToPath(new URL('../../dist/', import.meta.url));

  test('emits each of the five workers and Monaco in chunks of their own', () => {
    const assets = readdirSync(join(dist, 'assets'));
    for (const name of ['editor', 'json', 'css', 'html', 'ts']) {
      const bundles = assets.filter(file => new RegExp(`^${name}\\.worker-[\\w-]+\\.js$`).test(file))
        .filter(file => statSync(join(dist, 'assets', file)).size > 100_000);
      expect(bundles, `${name} worker bundle`).toHaveLength(1);
    }

    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const entry = /<script type="module"[^>]* src="\/assets\/([^"]+)"/.exec(html)![1];
    // A string literal of Monaco's own that minification keeps.
    const marker = 'editor.contrib.findController';
    const monacoChunks = assets.filter(file => file.endsWith('.js') && readFileSync(join(dist, 'assets', file), 'utf8').includes(marker));
    expect(monacoChunks).toHaveLength(1);
    expect(monacoChunks).not.toContain(entry);
    expect(html).not.toContain(monacoChunks[0]);
  });

  test('each built worker runs as a worker', async ({ page }) => {
    test.setTimeout(120_000);
    const bundles = readdirSync(join(dist, 'assets'))
      .filter(file => /^\w+\.worker-[\w-]+\.js$/.test(file) && statSync(join(dist, 'assets', file)).size > 100_000);
    expect(bundles).toHaveLength(5);
    await page.goto('/');
    for (const bundle of bundles) {
      const started = page.waitForEvent('worker', worker => worker.url().endsWith(bundle));
      // The wrapper chunks start them the same way: a classic worker on the bundle's URL.
      await page.evaluate(url => void new Worker(url), `/assets/${bundle}`);
      const worker = await started;
      await expect.poll(() => worker.evaluate(() => typeof self.onmessage), { timeout: 60_000 }).toBe('function');
    }
  });
});
