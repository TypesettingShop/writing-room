import type { Locator, Page } from '@playwright/test';
import { box, expect, renderedText, screenshotColor, test } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

const part = (page: Page, name: string) => page.locator(`[id="workbench.parts.${name}"]`);
const groups = (page: Page) => page.locator('[data-group-id]');
const group = (page: Page, index = 0) => groups(page).nth(index);
const strip = (scope: Locator) => scope.getByRole('tablist', { name: 'Open Editors' });
const textbox = (scope: Locator) => scope.getByRole('textbox', { name: 'Editor content' });
const overlay = (page: Page) => page.locator('[data-editor-drop-position]');
const tabMarker = (page: Page) => page.locator('[data-tab-drop-position]');

async function newTextFile(page: Page, text: string): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File' }).click();
  // The first editor waits for Monaco to load, which a cold dev server under a full run can take a while over.
  await expect(page.getByRole('textbox', { name: 'Editor content' }).and(page.locator(':focus'))).toHaveCount(1, { timeout: 20_000 });
  await page.keyboard.type(text);
}

/** The group's body: everything below its tab strip, which drop coordinates are relative to. */
async function body(scope: Locator) {
  const [g, s] = [await box(scope), await box(strip(scope))];
  const top = s.y + s.height;
  return { x: g.x, y: top, width: g.width, height: g.y + g.height - top };
}

/** A point at fractions (`fx`, `fy`) of the group's body. */
async function bodyPoint(scope: Locator, fx: number, fy: number) {
  const b = await body(scope);
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

/** A point in the empty part of the group's tab strip, right of its tabs. */
async function emptyStripPoint(scope: Locator) {
  const s = await box(strip(scope));
  return { x: s.x + s.width - 12, y: s.y + s.height / 2 };
}

async function center(locator: Locator) {
  const b = await box(locator);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Presses the mouse at `from` and moves off it, so the browser starts the drag. */
async function startDrag(page: Page, from: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 3, { steps: 3 });
}

/** Two moves, so the target sees `dragenter` and `dragover` at `to`. */
async function dragOver(page: Page, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(to.x - 1, to.y);
  await page.mouse.move(to.x, to.y);
}

async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await startDrag(page, from);
  await dragOver(page, to);
  await page.mouse.up();
}

const focusWithin = (scope: Locator) => scope.evaluate(element => element.contains(document.activeElement));

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  // One pixel of rounding is shared by neighbours.
  return a.x + a.width - 1 > b.x && b.x + b.width - 1 > a.x && a.y + a.height - 1 > b.y && b.y + b.height - 1 > a.y;
}

async function expectValidGrid(page: Page): Promise<void> {
  const editor = await box(part(page, 'editor'));
  const boxes = await Promise.all((await groups(page).all()).map(box));
  for (const [i, a] of boxes.entries()) {
    expect(a.width).toBeGreaterThan(0);
    expect(a.height).toBeGreaterThan(0);
    expect(a.x).toBeGreaterThanOrEqual(editor.x - 1);
    expect(a.x + a.width).toBeLessThanOrEqual(editor.x + editor.width + 1);
    for (const b of boxes.slice(i + 1)) {
      expect(overlaps(a, b), `${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`).toBe(false);
    }
  }
}

test('reorders tabs within a group where the marker shows', async ({ appPage: page }) => {
  const g = group(page);
  await newTextFile(page, 'one');
  await newTextFile(page, 'two');
  await expect(g.getByRole('tab')).toHaveText(['Welcome', 'Untitled-1', 'Untitled-2']);

  // Mid-drag: the marker sits after the hovered tab's right half.
  const third = await box(g.getByRole('tab', { name: 'Untitled-2' }));
  await startDrag(page, await center(g.getByRole('tab', { name: 'Welcome' })));
  await dragOver(page, { x: third.x + third.width * 0.9, y: third.y + third.height / 2 });
  await expect(tabMarker(page)).toHaveAttribute('data-tab-drop-position', 'after');
  await expect(tabMarker(page).getByRole('tab')).toHaveAccessibleName('Untitled-2');
  await expect(overlay(page)).toHaveCount(0);
  await page.mouse.up();

  await expect(g.getByRole('tab')).toHaveText(['Untitled-1', 'Untitled-2', 'Welcome']);
  await expect(g.getByRole('tab', { name: 'Welcome' })).toHaveAttribute('aria-selected', 'true');
  await expect(tabMarker(page)).toHaveCount(0);
  await expect(groups(page)).toHaveCount(1);

  // Left half of the first tab: the dropped tab goes before it.
  const first = await box(g.getByRole('tab', { name: 'Untitled-1' }));
  await dragTo(page, await center(g.getByRole('tab', { name: 'Untitled-2' })), { x: first.x + 4, y: first.y + first.height / 2 });
  await expect(g.getByRole('tab')).toHaveText(['Untitled-2', 'Untitled-1', 'Welcome']);
  await expect(g.getByRole('tab', { name: 'Untitled-2' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => renderedText(g)).toBe('two');

  // Moving right but not to the end: the tab lands before the hovered one, where the marker was.
  const last = await box(g.getByRole('tab', { name: 'Welcome' }));
  await dragTo(page, await center(g.getByRole('tab', { name: 'Untitled-2' })), { x: last.x + 4, y: last.y + last.height / 2 });
  await expect(g.getByRole('tab')).toHaveText(['Untitled-1', 'Untitled-2', 'Welcome']);
});

test('splits the only group by a tab dropped on its right edge, moving only that tab', async ({ appPage: page }) => {
  await newTextFile(page, 'moved');
  const left = group(page);
  await expect(left.getByRole('tab')).toHaveText(['Welcome', 'Untitled-1']);

  await startDrag(page, await center(left.getByRole('tab', { name: 'Untitled-1' })));
  await dragOver(page, await bodyPoint(left, 0.95, 0.5));
  // The indicator covers the right half of the body: where the new group goes.
  const b = await body(left);
  await expect(async () => {
    const o = await box(overlay(page));
    expect(Math.abs(o.x - (b.x + b.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(o.width - b.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(o.y - b.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(o.height - b.height)).toBeLessThanOrEqual(1);
  }).toPass();
  await expect(overlay(page)).toHaveAttribute('data-editor-drop-position', 'right');
  await page.mouse.up();

  await expect(groups(page)).toHaveCount(2);
  await expect(overlay(page)).toHaveCount(0);
  const right = group(page, 1);
  expect((await box(right)).x).toBeGreaterThan((await box(left)).x);
  await expect(left.getByRole('tab')).toHaveText(['Welcome']);
  await expect(right.getByRole('tab')).toHaveText(['Untitled-1']);
  await expect(right.getByRole('tab', { name: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => renderedText(right)).toBe('moved');
  await expect(textbox(right)).toBeFocused();
  await expectValidGrid(page);
});

test('moves a tab into the centre of another group, where it becomes active and focused', async ({ appPage: page }) => {
  await newTextFile(page, 'travel');
  await group(page).getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  const [left, right] = [group(page, 0), group(page, 1)];
  await expect.poll(() => renderedText(right)).toBe('travel');

  await startDrag(page, await center(left.getByRole('tab', { name: 'Welcome' })));
  const targetTab = right.locator('.tab').filter({ has: page.getByRole('tab', { name: 'Untitled-1' }) });
  const firstTab = await box(targetTab);
  const tabY = firstTab.y + firstTab.height / 2;
  await dragOver(page, { x: firstTab.x + 10, y: tabY });
  await expect(targetTab).toHaveAttribute('data-tab-drop-position', 'before');
  expect(await screenshotColor(page, firstTab.x, tabY)).toBe('#eaf0f9');

  // The centre: the indicator covers the whole body.
  await dragOver(page, await bodyPoint(right, 0.5, 0.5));
  const b = await body(right);
  await expect(async () => {
    const o = await box(overlay(page));
    for (const [actual, expected] of [[o.x, b.x], [o.y, b.y], [o.width, b.width], [o.height, b.height]]) {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
    }
  }).toPass();
  await expect(overlay(page)).toHaveAttribute('data-editor-drop-position', 'center');
  await page.mouse.up();

  await expect(groups(page)).toHaveCount(2);
  await expect(left.getByRole('tab')).toHaveText(['Untitled-1']);
  await expect(right.getByRole('tab')).toHaveText(['Untitled-1', 'Welcome']);
  await expect(right.getByRole('tab', { name: 'Welcome' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => focusWithin(right)).toBe(true);

  // The target is the active group: a new editor opens there.
  await newTextFile(page, 'here');
  await expect(right.getByRole('tab', { name: 'Untitled-2' })).toHaveAttribute('aria-selected', 'true');
  await expect(left.getByRole('tab')).toHaveText(['Untitled-1']);
});

test('a tab released right after it first enters another group\'s body still moves there', async ({ appPage: page }) => {
  await newTextFile(page, 'travel');
  await group(page).getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  const [left, right] = [group(page, 0), group(page, 1)];
  await expect.poll(() => renderedText(right)).toBe('travel');

  // One move: the overlay appears under the pointer, and the release comes before any `dragover` on it.
  await startDrag(page, await center(left.getByRole('tab', { name: 'Welcome' })));
  const to = await bodyPoint(right, 0.5, 0.5);
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();

  await expect(right.getByRole('tab')).toHaveText(['Untitled-1', 'Welcome']);
  await expect(overlay(page)).toHaveCount(0);
});

test('moves the group of a dragged only tab to another group\'s bottom edge, keeping text and cursor', async ({ appPage: page }) => {
  await newTextFile(page, 'top');
  await group(page).getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  const right = group(page, 1);
  await expect(textbox(right)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('hello world');
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowRight');
  }
  // Close the shared editor's other tab so the right group holds its only editor... of its own text.
  const left = group(page, 0);
  await left.getByRole('button', { name: 'Close Untitled-1' }).click();
  await expect(left.getByRole('tab')).toHaveText(['Welcome']);
  const rightId = await right.getAttribute('data-group-id');
  const moving = page.locator(`[data-group-id="${rightId}"]`);
  const pane = await moving.locator('.monaco-editor').first().elementHandle();

  await startDrag(page, await center(moving.getByRole('tab', { name: 'Untitled-1' })));
  await dragOver(page, await bodyPoint(left, 0.5, 0.95));
  await expect(overlay(page)).toHaveAttribute('data-editor-drop-position', 'down');
  await page.mouse.up();

  await expect(groups(page)).toHaveCount(2);
  await expect(overlay(page)).toHaveCount(0);
  const [l, m] = [await box(left), await box(moving)];
  expect(m.y).toBeGreaterThanOrEqual(l.y + l.height - 1);
  expect(Math.abs(m.x - l.x)).toBeLessThanOrEqual(1);
  // The same editor element moved with its group, its text and cursor intact.
  expect(await pane!.evaluate((element, id) => element.isConnected && !!element.closest(`[data-group-id="${id}"]`), rightId)).toBe(true);
  await expect.poll(() => renderedText(moving)).toBe('hello world');
  await expect(textbox(moving)).toBeFocused();
  await page.keyboard.type('X');
  await expect.poll(() => renderedText(moving)).toBe('helloX world');
  await expectValidGrid(page);
});

test('a view container offers no drop on the editor area, and a tab none on the activity bar', async ({ appPage: page }) => {
  const editor = part(page, 'editor');
  const explorer = part(page, 'activitybar').getByRole('button', { name: 'Explorer' });
  const welcome = group(page).getByRole('tab', { name: 'Welcome' });

  await startDrag(page, await center(explorer));
  await dragOver(page, await bodyPoint(group(page), 0.5, 0.5));
  await expect(overlay(page)).toHaveCount(0);
  await dragOver(page, await center(welcome));
  await expect(tabMarker(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(explorer).toHaveAttribute('aria-pressed', 'true');
  await expect(group(page).getByRole('tab')).toHaveText(['Welcome']);

  await startDrag(page, await center(welcome));
  await dragOver(page, await center(explorer));
  await expect(page.locator('[data-view-drop-position]')).toHaveCount(0);
  await dragOver(page, await center(part(page, 'panel').getByRole('tab', { name: 'Problems' })));
  await expect(page.locator('[data-view-drop-position]')).toHaveCount(0);
  await page.mouse.up();
  await expect(explorer).toHaveAttribute('aria-pressed', 'true');
  await expect(part(page, 'panel').getByRole('tab')).toHaveText(['Output', 'Problems']);
  await expect(groups(page)).toHaveCount(1);
  await expect(editor.getByRole('tab')).toHaveText(['Welcome']);
});

test('the only tab of a group offers no drop on its own body, and a group none on itself', async ({ appPage: page }) => {
  const g = group(page);
  const before = await box(g);
  const welcome = g.getByRole('tab', { name: 'Welcome' });

  for (const [fx, fy] of [[0.03, 0.5], [0.5, 0.5], [0.97, 0.5], [0.5, 0.97]]) {
    await startDrag(page, await center(welcome));
    await dragOver(page, await bodyPoint(g, fx, fy));
    await expect(overlay(page)).toHaveCount(0);
    await page.mouse.up();
  }
  await startDrag(page, await emptyStripPoint(g));
  await dragOver(page, await bodyPoint(g, 0.97, 0.5));
  await expect(overlay(page)).toHaveCount(0);
  await dragOver(page, await center(welcome));
  await expect(tabMarker(page)).toHaveCount(0);
  await page.mouse.up();

  await expect(groups(page)).toHaveCount(1);
  expect(await box(g)).toEqual(before);
  await expect(g.getByRole('tab')).toHaveText(['Welcome']);
});

test('drags a group by its strip to another group\'s right edge, keeping its tab order', async ({ appPage: page }) => {
  await newTextFile(page, 'docked');
  await group(page).getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  const [left, right] = [group(page, 0), group(page, 1)];
  const leftId = await left.getAttribute('data-group-id');
  const rightId = await right.getAttribute('data-group-id');
  const moving = page.locator(`[data-group-id="${leftId}"]`);
  const staying = page.locator(`[data-group-id="${rightId}"]`);
  await expect(moving.getByRole('tab')).toHaveText(['Welcome', 'Untitled-1']);

  // Within 30 % of the side, a dragged group splits rather than merges.
  await startDrag(page, await emptyStripPoint(moving));
  await dragOver(page, await bodyPoint(staying, 0.75, 0.5));
  await expect(overlay(page)).toHaveAttribute('data-editor-drop-position', 'right');
  await page.mouse.up();

  await expect(groups(page)).toHaveCount(2);
  const [m, s] = [await box(moving), await box(staying)];
  expect(m.x).toBeGreaterThanOrEqual(s.x + s.width - 1);
  await expect(moving.getByRole('tab')).toHaveText(['Welcome', 'Untitled-1']);
  await expect(staying.getByRole('tab')).toHaveText(['Untitled-1']);
  await expect.poll(() => focusWithin(moving)).toBe(true);
  await expectValidGrid(page);

  // Dropped on another group's strip, a group merges at the marker.
  await startDrag(page, await emptyStripPoint(staying));
  const welcome = await box(moving.getByRole('tab', { name: 'Welcome' }));
  await dragOver(page, { x: welcome.x + welcome.width * 0.9, y: welcome.y + welcome.height / 2 });
  await expect(tabMarker(page)).toHaveAttribute('data-tab-drop-position', 'after');
  await page.mouse.up();
  await expect(groups(page)).toHaveCount(1);
  await expect(moving.getByRole('tab')).toHaveText(['Welcome', 'Untitled-1']);
});

test('Escape during a drag removes the overlay and changes nothing', async ({ appPage: page }) => {
  await newTextFile(page, 'stay');
  const g = group(page);
  const before = await box(g);

  await startDrag(page, await center(g.getByRole('tab', { name: 'Untitled-1' })));
  await dragOver(page, await bodyPoint(g, 0.95, 0.5));
  await expect(overlay(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(overlay(page)).toHaveCount(0);
  await page.mouse.up();

  await expect(overlay(page)).toHaveCount(0);
  await expect(tabMarker(page)).toHaveCount(0);
  await expect(groups(page)).toHaveCount(1);
  expect(await box(g)).toEqual(before);
  await expect(g.getByRole('tab')).toHaveText(['Welcome', 'Untitled-1']);

  // The next drag over the strip shows a marker again and is not mistaken for the canceled one.
  await startDrag(page, await center(g.getByRole('tab', { name: 'Welcome' })));
  await dragOver(page, await center(g.getByRole('tab', { name: 'Untitled-1' })));
  await expect(tabMarker(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(tabMarker(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(g.getByRole('tab')).toHaveText(['Welcome', 'Untitled-1']);
});

test('the overlay shows the left half within 5 % of the left edge and the whole body in the centre', async ({ appPage: page }) => {
  await newTextFile(page, 'zones');
  const g = group(page);
  const b = await body(g);
  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);

  await startDrag(page, await center(g.getByRole('tab', { name: 'Untitled-1' })));
  await dragOver(page, await bodyPoint(g, 0.05, 0.5));
  await expect(overlay(page)).toHaveAttribute('data-editor-drop-position', 'left');
  await expect(async () => {
    const o = await box(overlay(page));
    near(o.x, b.x);
    near(o.y, b.y);
    near(o.width, b.width / 2);
    near(o.height, b.height);
  }).toPass();

  await dragOver(page, await bodyPoint(g, 0.5, 0.5));
  await expect(overlay(page)).toHaveAttribute('data-editor-drop-position', 'center');
  await expect(async () => {
    const o = await box(overlay(page));
    near(o.x, b.x);
    near(o.y, b.y);
    near(o.width, b.width);
    near(o.height, b.height);
  }).toPass();

  // Over the tab strip the overlay goes away; the marker shows instead.
  await dragOver(page, await center(g.getByRole('tab', { name: 'Welcome' })));
  await expect(overlay(page)).toHaveCount(0);
  await expect(tabMarker(page)).toHaveCount(1);
  await page.mouse.up();
  await expect(groups(page)).toHaveCount(1);
});

test('a drop into a 300 px wide group leaves groups that do not overlap', async ({ appPage: page }) => {
  await newTextFile(page, 'narrow');
  await group(page).getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  const [left, right] = [group(page, 0), group(page, 1)];

  // Narrow the right group to 300 px with the sash between the two.
  const editor = await box(part(page, 'editor'));
  const l = await box(left);
  const y = l.y + l.height / 2;
  await page.mouse.move(l.x + l.width, y);
  await page.mouse.down();
  await page.mouse.move(editor.x + editor.width - 300, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await box(right)).width)).toBe(300);

  await dragTo(page, await center(left.getByRole('tab', { name: 'Welcome' })), await bodyPoint(right, 0.95, 0.5));
  await expect(groups(page)).toHaveCount(3);
  await expect(group(page, 2).getByRole('tab')).toHaveText(['Welcome']);
  await expectValidGrid(page);
  for (const g of await groups(page).all()) {
    expect((await box(g)).width).toBeGreaterThanOrEqual(220 - 1);
  }
});

test('files and text dropped from outside do nothing', async ({ appPage: page }) => {
  await newTextFile(page, 'kept');
  const g = group(page);
  const lines = g.locator('.monaco-editor .view-lines').first();
  const result = await lines.evaluate(element => {
    const data = new DataTransfer();
    data.setData('text/plain', 'dropped');
    data.items.add(new File(['file'], 'file.txt', { type: 'text/plain' }));
    const bounds = element.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer: data, clientX: bounds.left + 20, clientY: bounds.top + 5 };
    element.dispatchEvent(new DragEvent('dragenter', init));
    const over = new DragEvent('dragover', init);
    element.dispatchEvent(over);
    const overlayShown = !!document.querySelector('[data-editor-drop-position]');
    element.dispatchEvent(new DragEvent('drop', init));
    return { overlayShown, dropEffect: data.dropEffect };
  });
  expect(result).toEqual({ overlayShown: false, dropEffect: 'none' });
  await expect(overlay(page)).toHaveCount(0);
  await expect(groups(page)).toHaveCount(1);
  await expect.poll(() => renderedText(g)).toBe('kept');
  await expect(page).toHaveURL(/\/$/);
});
