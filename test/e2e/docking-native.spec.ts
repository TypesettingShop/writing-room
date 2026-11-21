import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Locator, Page } from '@playwright/test';
import { part, treeItem } from './explorer.helpers.js';
import { groups, selectedTab, waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { box, expect, test as appTest } from './fixtures.js';

type Point = { x: number; y: number };
type Drag = (from: Point, to: Point, checkMarker: () => Promise<void>, via?: Point) => Promise<void>;

const pointerScript = fileURLToPath(new URL('../fixtures/x11-pointer.py', import.meta.url));
const exec = promisify(execFile);
const wayland = process.env.E2E_NATIVE_DND === 'wayland';

function unavailable(): string | undefined {
  if (process.env.E2E_NATIVE_DND !== '1' && !wayland) {
    return 'Native drag uses a dedicated X11 display. See the Xvfb command in README.md.';
  }
  if (process.platform !== 'linux' || !process.env.DISPLAY) {
    return 'Native drag requires Linux with an X11 display (DISPLAY).';
  }
  if (wayland && !process.env.WAYLAND_DISPLAY) {
    return 'Wayland native drag requires a nested Wayland compositor (WAYLAND_DISPLAY).';
  }
  const probe = spawnSync('python3', [pointerScript, 'probe'], { encoding: 'utf8', timeout: 5_000 });
  if (probe.error || probe.status !== 0) {
    return 'Native drag requires Python 3 and a working XTest display: ' + (probe.error?.message ?? probe.stderr.trim());
  }
}

async function pointer(command: 'move' | 'down' | 'up', position?: Point): Promise<void> {
  const coordinates = position ? [position.x, position.y].map(value => String(Math.round(value))) : [];
  await exec('python3', [pointerScript, command, ...coordinates], { timeout: 5_000 });
}

async function viewportOrigin(page: Page): Promise<Point> {
  await page.bringToFront();
  const { center, outside } = await page.evaluate(() => {
    if (window.devicePixelRatio !== 1) {
      throw new Error('XTest coordinates require a browser device scale factor of 1.');
    }
    return {
      center: { x: screenX + innerWidth / 2, y: screenY + innerHeight / 2 },
      outside: { x: screen.width + 32, y: screen.height + 32 },
    };
  });
  await pointer('move', outside);
  await page.evaluate(() => {
    window.addEventListener('mousemove', event => {
      if (event.isTrusted) {
        document.documentElement.dataset.x11Pointer = JSON.stringify({ x: event.clientX, y: event.clientY });
      }
    }, { once: true });
  });
  await pointer('move', center);
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-x11-pointer', /./);
  const client: Point = JSON.parse((await root.getAttribute('data-x11-pointer'))!);
  // Measure the viewport origin from actual input, including the browser chrome and window borders.
  return { x: Math.round(center.x) - client.x, y: Math.round(center.y) - client.y };
}

const test = appTest.extend<{ nativeDrag: Drag }>({
  nativeDrag: async ({ appPage: page }, use) => {
    await use(async (from, to, checkMarker, via) => {
      const origin = await viewportOrigin(page);
      const move = (point: Point) => pointer('move', { x: point.x + origin.x, y: point.y + origin.y });
      if (via) {
        await page.evaluate(() => {
          for (const type of ['dragenter', 'dragover'] as const) {
            window.addEventListener(type, event => {
              if (event.isTrusted) {
                document.documentElement.dataset.x11DragPosition = `${event.clientX},${event.clientY}`;
              }
            }, true);
          }
        });
      }
      await move(from);
      await pointer('down');
      try {
        await move({ x: from.x + 12, y: from.y + 2 });
        if (via) {
          const root = page.locator('html');
          // Chromium reports the previous renderer operation to X11. Give the refused
          // location two native position updates before entering the allowed target.
          for (const x of [via.x - 2, via.x]) {
            await move({ x, y: via.y });
            await expect(root).toHaveAttribute('data-x11-drag-position', `${Math.round(x)},${Math.round(via.y)}`);
          }
          await move(to);
          await checkMarker();
          // The first-entry assertion observes the renderer. Move within the target once
          // more so X11 has a subsequent position at which to read that operation.
          await move({ x: to.x + 2, y: to.y });
        } else {
          for (let step = 1; step <= 6; step++) {
            await move({
              x: from.x + (to.x - from.x) * step / 6,
              y: from.y + (to.y - from.y) * step / 6,
            });
          }
          await move({ x: to.x + 2, y: to.y });
          await checkMarker();
        }
      } finally {
        await pointer('up');
      }
    });
  },
});

const skipReason = unavailable();
test.skip(skipReason !== undefined, skipReason);
test.describe.configure({ mode: 'default' });
test.use({
  headless: false,
  viewport: null,
  launchOptions: {
    executablePath: process.env.E2E_NATIVE_DND_CHROME,
    args: [`--ozone-platform=${wayland ? 'wayland' : 'x11'}`, '--force-device-scale-factor=1', '--window-size=1200,780'],
  },
});

const refuseNativeDrop = process.env.E2E_NATIVE_DND_REFUSE === '1';
if (refuseNativeDrop) {
  test.beforeEach(async ({ appPage: page }) => {
    await page.evaluate(() => {
      const native = Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'dropEffect')!;
      Object.defineProperty(DataTransfer.prototype, 'dropEffect', {
        ...native,
        set(this: DataTransfer, value: DataTransfer['dropEffect']) {
          const internal = this.types.some(type => type === 'application/x-writing-room-editor'
            || type === 'application/x-writing-room-view-container');
          native.set!.call(this, internal ? 'none' : value);
        },
      });
    });
  });
}

const tabs = (group: Locator) => group.getByRole('tab');
const strip = (group: Locator) => group.getByRole('tablist', { name: 'Open Editors' });
const overlay = (page: Page) => page.locator('[data-editor-drop-position]');

async function point(locator: Locator, x = 0.5, y = 0.5): Promise<Point> {
  const bounds = await box(locator);
  return { x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y };
}

async function bodyPoint(group: Locator, x: number, y: number): Promise<Point> {
  const bounds = await box(group);
  const title = await box(strip(group));
  const top = title.y + title.height;
  return { x: bounds.x + bounds.width * x, y: top + (bounds.y + bounds.height - top) * y };
}

async function openWorkspaceFile(page: Page, name: string): Promise<void> {
  await waitForStorage(page);
  await writeWorkspaceFile(page, name, 'Native drag sample.\n');
  await treeItem(page, name).dblclick();
  await expect(selectedTab(groups(page).first())).toHaveText(name);
}

async function openTextFile(page: Page): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File' }).click();
  const editor = page.getByRole('textbox', { name: 'Editor content' }).and(page.locator(':focus'));
  await expect(editor).toHaveCount(1, { timeout: 20_000 });
}

test('reorders a tab with native pointer input', async ({ appPage: page, nativeDrag }) => {
  await openTextFile(page);
  const group = groups(page).first();
  const source = group.getByRole('tab', { name: 'Untitled-1' });
  const target = group.getByRole('tab', { name: 'Welcome' });
  await expect(tabs(group)).toHaveText(['Welcome', 'Untitled-1']);

  await nativeDrag(await point(source), await point(target, 0.2), async () => {
    const marker = page.locator('[data-tab-drop-position]');
    await expect(marker).toHaveAttribute('data-tab-drop-position', 'before');
    await expect(marker.getByRole('tab')).toHaveAccessibleName('Welcome');
  });

  await expect(tabs(group)).toHaveText(['Untitled-1', 'Welcome']);
  await expect(page.locator('[data-tab-drop-position]')).toHaveCount(0);
});

for (const direction of ['right', 'down'] as const) {
  test(`splits a group ${direction} with native pointer input`, async ({ appPage: page, nativeDrag }) => {
    const name = direction === 'right' ? 'dock.md' : 'dock.txt';
    await openWorkspaceFile(page, name);
    const original = groups(page).first();
    const added = groups(page).nth(1);
    const source = original.getByRole('tab', { name });
    const target = direction === 'right' ? await bodyPoint(original, 0.95, 0.5) : await bodyPoint(original, 0.5, 0.95);

    await nativeDrag(await point(source), target, async () => {
      await expect(overlay(page)).toHaveAttribute('data-editor-drop-position', direction);
    });

    await expect(groups(page)).toHaveCount(2);
    await expect(tabs(original)).toHaveText(['Welcome']);
    await expect(tabs(added)).toHaveText([name]);
    await expect(overlay(page)).toHaveCount(0);
    const [a, b] = [await box(original), await box(added)];
    if (direction === 'right') {
      expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
      expect(b.y).toBeCloseTo(a.y, 0);
    } else {
      expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
      expect(b.x).toBeCloseTo(a.x, 0);
    }
  });
}

test('docks a whole group with native pointer input', async ({ appPage: page, nativeDrag }) => {
  await openTextFile(page);
  await page.getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  const [left, right] = [groups(page).first(), groups(page).nth(1)];
  const title = await box(strip(left));

  await nativeDrag({ x: title.x + title.width - 12, y: title.y + title.height / 2 }, await bodyPoint(right, 0.8, 0.5), async () => {
    await expect(overlay(page)).toHaveAttribute('data-editor-drop-position', 'right');
  });

  await expect(groups(page)).toHaveCount(2);
  await expect(tabs(left)).toHaveText(['Untitled-1']);
  await expect(tabs(right)).toHaveText(['Welcome', 'Untitled-1']);
  await expect(overlay(page)).toHaveCount(0);
});

test('offers view-container docking on first entry from a refused native target', async ({ appPage: page, nativeDrag }) => {
  const explorer = part(page, 'activitybar').getByRole('button', { name: 'Explorer', exact: true });
  const panel = part(page, 'panel');
  const problems = panel.getByRole('tab', { name: 'Problems' });
  const refused = await bodyPoint(groups(page).first(), 0.5, 0.5);
  await panel.evaluate(element => {
    // Observe the operation after the workbench's handlers have seen the real dragenter.
    window.addEventListener('dragenter', event => {
      if (event.isTrusted && element.contains(event.target as Node)) {
        element.dataset.x11EntryOperation = event.defaultPrevented ? event.dataTransfer?.dropEffect : 'unhandled';
      }
    });
  });

  await nativeDrag(await point(explorer), await point(problems, 0.25), async () => {
    await expect(problems).toHaveAttribute('data-view-drop-position', 'before');
  }, refused);

  if (!refuseNativeDrop) {
    await expect(panel).toHaveAttribute('data-x11-entry-operation', 'move');
  }
  await expect(panel.getByRole('tab')).toHaveText(['Output', 'Explorer', 'Problems']);
  await expect(explorer).toHaveCount(0);
  await expect(page.locator('[data-view-drop-position]')).toHaveCount(0);
});
