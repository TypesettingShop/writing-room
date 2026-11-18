import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

const part = (page: Page, name: string) => page.locator(`[id="workbench.parts.${name}"]`);
const marker = (page: Page) => page.locator('[data-view-drop-position]');

async function point(locator: Locator, x = 0.5, y = 0.5) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width * x, y: box!.y + box!.height * y };
}

async function startDrag(page: Page, source: Locator): Promise<void> {
  const { x, y } = await point(source);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 9, y + 2, { steps: 3 });
}

async function dragOver(page: Page, target: Locator, horizontal = 0.5, vertical = 0.5): Promise<void> {
  const { x, y } = await point(target, horizontal, vertical);
  await page.mouse.move(x - 1, y);
  await page.mouse.move(x, y);
}

test('drags Explorer into the panel, restores its placement and order, and drags it back', async ({ appPage: page }) => {
  const activitybar = part(page, 'activitybar');
  const sidebar = part(page, 'sidebar');
  const panel = part(page, 'panel');
  const explorerIcon = activitybar.getByRole('button', { name: 'Explorer' });
  const explorerTab = panel.getByRole('tab', { name: 'Explorer' });
  const problems = panel.getByRole('tab', { name: 'Problems' });
  const output = panel.getByRole('tab', { name: 'Output' });
  const original = await sidebar.getByText('No folder opened').elementHandle();

  await startDrag(page, explorerIcon);
  await dragOver(page, problems, 0.25);
  await expect(problems).toHaveAttribute('data-view-drop-position', 'before');
  await page.mouse.up();
  await expect(marker(page)).toHaveCount(0);
  await expect(panel.getByRole('tab')).toHaveText(['Output', 'Explorer', 'Problems']);
  await expect(explorerTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('No folder opened')).toBeVisible();
  expect(await original?.evaluate(element => element.closest('.part')?.id)).toBe('workbench.parts.panel');
  await expect(explorerIcon).toHaveCount(0);
  await expect(sidebar).toBeHidden();

  await startDrag(page, problems);
  await dragOver(page, output, 0.25);
  await expect(output).toHaveAttribute('data-view-drop-position', 'before');
  await page.mouse.up();
  await expect(panel.getByRole('tab')).toHaveText(['Problems', 'Output', 'Explorer']);

  await page.reload();
  await expect(panel.getByRole('tab')).toHaveText(['Problems', 'Output', 'Explorer']);
  await expect(sidebar).toBeHidden();
  await expect(explorerIcon).toHaveCount(0);

  await startDrag(page, explorerTab);
  await dragOver(page, activitybar);
  await expect(marker(page)).toHaveAttribute('data-view-drop-position', 'empty');
  await page.mouse.up();
  await expect(explorerTab).toHaveCount(0);
  await expect(explorerIcon).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar.getByText('No folder opened')).toBeVisible();
  await expect(problems).toHaveAttribute('aria-selected', 'true');
});

test('places a drop over the gap between tabs or the bar padding beside the nearest tab', async ({ appPage: page }) => {
  const activitybar = part(page, 'activitybar');
  const panel = part(page, 'panel');
  const output = panel.getByRole('tab', { name: 'Output' });
  const problems = panel.getByRole('tab', { name: 'Problems' });
  const outputBox = (await output.boundingBox())!;
  const problemsBox = (await problems.boundingBox())!;
  const gap = outputBox.x + outputBox.width;
  expect(problemsBox.x).toBeGreaterThan(gap);

  // Neither point is inside a tab: the gap between two tabs, then the header padding before the first tab.
  await startDrag(page, activitybar.getByRole('button', { name: 'Explorer' }));
  const y = outputBox.y + outputBox.height / 2;
  await page.mouse.move((gap + problemsBox.x) / 2 - 1, y);
  await page.mouse.move((gap + problemsBox.x) / 2, y);
  await expect(marker(page)).toHaveCount(1);
  await page.mouse.up();
  await expect(panel.getByRole('tab')).toHaveText(['Output', 'Explorer', 'Problems']);

  // The emptied sidebar has closed, so the panel and its tabs have moved.
  const first = (await output.boundingBox())!;
  await startDrag(page, problems);
  await page.mouse.move(first.x - 5, first.y + first.height / 2);
  await page.mouse.move(first.x - 4, first.y + first.height / 2);
  await expect(output).toHaveAttribute('data-view-drop-position', 'before');
  await page.mouse.up();
  await expect(panel.getByRole('tab')).toHaveText(['Problems', 'Output', 'Explorer']);
});

test('rejects the editor area and clears the marker after Escape', async ({ appPage: page }) => {
  const activitybar = part(page, 'activitybar');
  const panel = part(page, 'panel');
  const explorer = activitybar.getByRole('button', { name: 'Explorer' });
  const problems = panel.getByRole('tab', { name: 'Problems' });
  const editor = part(page, 'editor');

  await startDrag(page, explorer);
  await dragOver(page, explorer);
  await expect(marker(page)).toHaveCount(0);
  await dragOver(page, problems, 0.25);
  await expect(marker(page)).toHaveCount(1);
  await dragOver(page, editor);
  await expect(marker(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(explorer).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveText(['Output', 'Problems']);

  await startDrag(page, explorer);
  await dragOver(page, problems, 0.25);
  await expect(marker(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(marker(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(explorer).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveText(['Output', 'Problems']);
});

test('drops on a part body and moves a container by its sidebar title', async ({ appPage: page }) => {
  const sidebar = part(page, 'sidebar');
  const panel = part(page, 'panel');
  const output = panel.getByRole('tab', { name: 'Output' });
  const activitybar = part(page, 'activitybar');

  await startDrag(page, output);
  await dragOver(page, sidebar);
  await expect(sidebar).toHaveAttribute('data-view-drop-position', 'body');
  await page.mouse.up();
  await expect(activitybar.getByRole('button').nth(0)).toHaveAccessibleName('Explorer');
  await expect(activitybar.getByRole('button').nth(1)).toHaveAccessibleName('Output');
  await expect(sidebar.getByText('No output yet')).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveText(['Problems']);

  await startDrag(page, activitybar.getByRole('button', { name: 'Output' }));
  const explorerIcon = activitybar.getByRole('button', { name: 'Explorer' });
  await dragOver(page, explorerIcon, 0.5, 0.25);
  await expect(explorerIcon).toHaveAttribute('data-view-drop-position', 'before');
  await page.mouse.up();
  await expect(activitybar.getByRole('button').first()).toHaveAccessibleName('Output');

  await startDrag(page, sidebar.getByRole('heading', { name: 'Output', level: 2 }));
  await dragOver(page, panel.locator('.pane-composite-content'));
  await expect(marker(page)).toHaveAttribute('data-view-drop-position', 'body');
  await page.mouse.up();
  await expect(panel.getByRole('tab')).toHaveText(['Problems', 'Output']);
  await expect(sidebar.getByRole('heading', { name: 'Explorer' })).toBeVisible();
});

test('moves from the keyboard context menu and resets with the command palette', async ({ appPage: page }) => {
  const activitybar = part(page, 'activitybar');
  const sidebar = part(page, 'sidebar');
  const panel = part(page, 'panel');
  const explorer = activitybar.getByRole('button', { name: 'Explorer' });

  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toBeHidden();
  await explorer.press('Shift+F10');
  const move = page.getByRole('menuitem', { name: 'Move to Panel' });
  await expect(move).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sidebar).toBeHidden();
  await expect(panel.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('region', { name: 'Files' })).toBeFocused();

  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Reset View Locations');
  await page.getByRole('option', { name: /Reset View Locations/ }).click();
  await expect(explorer).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('tab')).toHaveText(['Output', 'Problems']);
  await expect(sidebar.getByText('No folder opened')).toBeVisible();
});

test('ignores a non-container drag from the editor', async ({ appPage: page }) => {
  const editor = part(page, 'editor');
  const explorer = part(page, 'activitybar').getByRole('button', { name: 'Explorer' });
  // A real editor tab: its drag carries an editor, which no composite bar takes.
  await startDrag(page, editor.getByRole('tab', { name: 'Welcome' }));
  await dragOver(page, explorer);
  await expect(marker(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(explorer).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.getByRole('tab')).toHaveText(['Welcome']);
});
