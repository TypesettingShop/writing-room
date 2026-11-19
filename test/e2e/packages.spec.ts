import { expect, test } from '@playwright/test';
import { fixtureOrigin, installedKey, prepareLocationInstall, runCommand, savedIdentifiers, savedRecords } from './packages.helpers.js';

test('two tabs that install different extensions at once both keep their records', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  // The second tab hears no storage events, as if the first tab's write had not reached its cache yet.
  await second.addInitScript(() => window.addEventListener('storage', event => event.stopImmediatePropagation(), true));
  await first.goto('/');
  await second.goto('/');
  await prepareLocationInstall(first, 'remote');
  await prepareLocationInstall(second, 'oversize-entry');

  await Promise.all([
    first.getByRole('option', { name: /Install Remote Fixture/ }).click(),
    second.getByRole('option', { name: /Install Remote Fixture/ }).click(),
  ]);
  const both = ['writing-room-tests.oversize-entry', 'writing-room-tests.remote'];
  await expect.poll(() => savedIdentifiers(first)).toEqual(both);

  // Installing one after the other, the second tab still reads the first tab's record before it writes.
  await runCommand(first, 'Uninstall Extension', /^Uninstall Extension/);
  await first.getByRole('option', { name: /Remote Fixture.*writing-room-tests\.remote/ }).click();
  await expect.poll(() => savedIdentifiers(first)).toEqual(['writing-room-tests.oversize-entry']);
  await prepareLocationInstall(first, 'remote');
  await first.getByRole('option', { name: /Install Remote Fixture/ }).click();
  await expect.poll(() => savedIdentifiers(first)).toEqual(both);
  await runCommand(second, 'Uninstall Extension', /^Uninstall Extension/);
  await second.getByRole('option', { name: /Remote Fixture.*writing-room-tests\.oversize-entry/ }).click();
  await expect.poll(() => savedIdentifiers(second)).toEqual(['writing-room-tests.remote']);
});

test('a folder URL install saved by v0.1.0 survives the schema 2 migration and still runs', async ({ page }) => {
  const manifest = await (await fetch(fixtureOrigin + '/remote/package.json')).json() as { version: string };
  await page.addInitScript(({ key, record }) => {
    if (!localStorage.getItem('writing-room:storage:version')) {
      localStorage.setItem('writing-room:storage:version', '1');
      localStorage.setItem(key, JSON.stringify([record]));
    }
  }, {
    key: installedKey,
    record: { identifier: 'writing-room-tests.remote', location: fixtureOrigin + '/remote/', manifest, installedAt: 1 },
  });
  await page.goto('/');
  await expect(page.locator('[id="workbench.parts.activitybar"]').getByRole('button', { name: 'Remote Fixture' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('writing-room:storage:version'))).toBe('2');
  expect(await savedRecords(page)).toEqual([expect.objectContaining({
    identifier: 'writing-room-tests.remote', location: fixtureOrigin + '/remote/', source: 'location', version: manifest.version,
  })]);
  await runCommand(page, 'Run Remote Fixture', /Run Remote Fixture/);
  await expect(page.getByText('Cross-origin extension ran.')).toBeVisible();
});
