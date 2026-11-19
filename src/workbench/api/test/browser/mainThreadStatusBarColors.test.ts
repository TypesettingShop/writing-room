import { expect, test, vi } from 'vitest';
import { MainThreadStatusBar } from '../../browser/mainThreadStatusBar.js';
import type { IStatusbarEntry } from '../../../services/statusbar/browser/statusbar.js';
import { StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import type { StatusBarEntryDto } from '../../common/extHost.protocol.js';

function statusbar() {
  const update = vi.fn();
  const addEntry = vi.fn((_entry: IStatusbarEntry, _id: string, _alignment: StatusbarAlignment, _priority: number) => ({ dispose: vi.fn(), update }));
  const main = new MainThreadStatusBar({ _serviceBrand: undefined, addEntry }, key => key === 'a' ? 'test.a' : undefined);
  return { main, addEntry, update };
}

test('an item with an id is the element "<extension id>.<id>"; without one it keeps its key', async () => {
  const { main, addEntry } = statusbar();
  await main.$setEntry('a', '1', { alignment: 1, text: 'One', id: 'build' });
  await main.$setEntry('a', '2', { alignment: 1, text: 'Two' });
  expect(addEntry.mock.calls.map(call => call[1])).toEqual(['test.a.build', 'test.a.2']);
});

test('the accessibility label becomes the accessible name and only shapes pass on', async () => {
  const { main, addEntry } = statusbar();
  await main.$setEntry('a', '1', {
    alignment: 1, text: 'One', name: 'Build', color: { id: 'charts.red', extra: 'x' } as never,
    backgroundColor: { id: 'statusBarItem.errorBackground' }, accessibilityInformation: { label: 'Build failed', role: 'link' },
  });
  expect(addEntry.mock.calls[0][0]).toMatchObject({
    name: 'Build', ariaLabel: 'Build failed', role: 'link',
    color: { id: 'charts.red' }, backgroundColor: { id: 'statusBarItem.errorBackground' },
  });
  expect(Object.keys(addEntry.mock.calls[0][0].color as object)).toEqual(['id']);

  // What a worker sends is not trusted for shapes.
  await main.$setEntry('a', '2', {
    alignment: 1, text: 'Two', color: 42, backgroundColor: 'statusBarItem.errorBackground',
    accessibilityInformation: { label: 7, role: {} },
  } as unknown as StatusBarEntryDto);
  expect(addEntry.mock.calls[1][0]).toMatchObject({ name: 'test.a', color: undefined, backgroundColor: undefined, ariaLabel: undefined, role: undefined });
});
